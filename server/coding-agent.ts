import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { broadcast } from "./broadcast.js";
import { sendImessage } from "./sendblue.js";
import { EMPTY_USAGE, type UsageTotals } from "./usage.js";

export type CodingAgentKind = "claude" | "codex";

const running = new Map<string, ChildProcess>();
const cancelledCoders = new Set<string>();

interface RunningCoderMeta {
  agentId: string;
  agent: CodingAgentKind;
  projectPath: string;
  task: string;
  startedAt: number;
}
const runningCoders = new Map<string, RunningCoderMeta>();

export interface CoderSessionRef {
  agent: CodingAgentKind;
  projectPath: string;
  sessionId: string;
  updatedAt: number;
}

interface CliRunResult {
  status: "completed" | "failed" | "cancelled";
  result: string;
  error?: string;
  sessionId?: string;
  usage: UsageTotals;
}

type AgentLogType = "thinking" | "tool_use" | "tool_result" | "text" | "error";

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function codingRoot(): string {
  return expandHome(process.env.BOOP_CODING_ROOT ?? "~/Programming");
}

/**
 * Resolve a project argument to an absolute directory.
 * - Absolute path: used as-is.
 * - "~/foo": expanded to home.
 * - Bare name like "boop-agent": resolved against BOOP_CODING_ROOT.
 */
export function resolveProjectPath(project: string): string {
  const expanded = expandHome(project);
  const abs = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(codingRoot(), expanded);
  return abs;
}

function sessionPathFor(agent: CodingAgentKind, projectAbs: string): string {
  const hash = createHash("sha1").update(`${agent}:${projectAbs}`).digest("hex").slice(0, 16);
  return path.join(os.homedir(), ".boop", "sessions", `${agent}-${hash}`);
}

function readPriorSessionId(agent: CodingAgentKind, projectAbs: string): string | undefined {
  try {
    const p = sessionPathFor(agent, projectAbs);
    if (!fs.existsSync(p)) return undefined;
    const id = fs.readFileSync(p, "utf8").trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}

function persistSessionId(agent: CodingAgentKind, projectAbs: string, sessionId: string): void {
  const sessFile = sessionPathFor(agent, projectAbs);
  fs.mkdirSync(path.dirname(sessFile), { recursive: true });
  fs.writeFileSync(sessFile, sessionId);

  const histFile = path.join(os.homedir(), ".boop", "history");
  fs.mkdirSync(path.dirname(histFile), { recursive: true });
  fs.appendFileSync(histFile, `${Date.now()}\t${projectAbs}\t${sessionId}\t${agent}\n`);
}

export function latestCoderSession(agent?: CodingAgentKind): CoderSessionRef | undefined {
  const histFile = path.join(os.homedir(), ".boop", "history");
  try {
    if (!fs.existsSync(histFile)) return undefined;
    return fs
      .readFileSync(histFile, "utf8")
      .split("\n")
      .map((line): CoderSessionRef | null => {
        const [tsRaw, projectPath, sessionId, rawAgent] = line.split("\t");
        const updatedAt = Number(tsRaw);
        const parsedAgent: CodingAgentKind = rawAgent === "codex" ? "codex" : "claude";
        if (!Number.isFinite(updatedAt) || !projectPath || !sessionId) return null;
        if (agent && parsedAgent !== agent) return null;
        return { updatedAt, projectPath, sessionId, agent: parsedAgent };
      })
      .filter((session): session is CoderSessionRef => Boolean(session))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  } catch {
    return undefined;
  }
}

export function runningCoderIds(): string[] {
  return [...runningCoders.keys()];
}

function boopScratchDir(): string {
  const p = path.join(os.homedir(), ".boop", "coder");
  fs.mkdirSync(p, { recursive: true });
  return p;
}

const CODING_SYSTEM = `You are Boop's coding sub-agent. You are running as a real local CLI coding agent, launched from an iMessage workflow.

Scope:
- You operate inside ONE project directory: your cwd.
- Make small, targeted changes. Match existing style. Don't reformat unrelated files.
- Tests, type checks, linters, git, and dep installs are available. Use them when verifying a change.

Style:
- Optimize the FINAL summary for iMessage: short, concrete, and under 400 words.
- Name files and commands when useful.
- If a task is ambiguous or large, do the most useful safe thing and surface open questions in the final reply.

Long-running processes:
- Prefer tmux for dev servers, watchers, tunnels, and ngrok.
- Convention: tmux session name \`boop-<project-basename>-<purpose>\`.
- Before launching a new long-running process, check existing sessions and avoid duplicates.

Persistence:
- This run may be resumed by a later Boop coder task in the same project.
- The user may also take over locally through the relevant CLI resume command.`;

function buildPrompt(task: string, agent: CodingAgentKind): string {
  return [
    CODING_SYSTEM,
    "",
    `Selected coding agent: ${agent}.`,
    "",
    "User task:",
    task,
  ].join("\n");
}

export interface CodingSpawnOptions {
  task: string;
  project: string;
  conversationId?: string;
  name?: string;
  agent?: CodingAgentKind;
}

export interface CodingSpawnResult {
  agentId: string;
  agent: CodingAgentKind;
  result: string;
  status: "completed" | "failed" | "cancelled";
  projectPath: string;
  sessionId?: string;
  costUsd?: number;
}

function normalizeAgent(agent?: string): CodingAgentKind {
  const requested = agent ?? process.env.BOOP_CODING_AGENT;
  return requested === "codex" ? "codex" : "claude";
}

function shortSummary(text: string, max = 1200): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function tryJson(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function findSessionId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value)) {
    if (
      (key === "session_id" || key === "thread_id" || key === "conversation_id") &&
      typeof nested === "string" &&
      nested.length > 8
    ) {
      return nested;
    }
    const found = findSessionId(nested);
    if (found) return found;
  }
  return null;
}

function findAssistantText(value: unknown): string | null {
  const ev = asRecord(value);
  if (!ev) return null;
  if (ev.type === "agent_message" && typeof ev.message === "string") return ev.message;
  if (ev.type === "event_msg" && ev.payload) return findAssistantText(ev.payload);
  if (ev.type === "message" && ev.role === "assistant" && typeof ev.content === "string") {
    return ev.content;
  }
  if (Array.isArray(ev.content)) {
    const text = ev.content
      .map((block) => {
        const b = asRecord(block);
        return typeof b?.text === "string" ? b.text : "";
      })
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  for (const nested of Object.values(ev)) {
    const found = findAssistantText(nested);
    if (found) return found;
  }
  return null;
}

function findErrorText(value: unknown): string | null {
  const ev = asRecord(value);
  if (!ev) return null;
  if (typeof ev.error === "string") return ev.error;
  const error = asRecord(ev.error);
  if (typeof error?.message === "string") return error.message;
  for (const nested of Object.values(ev)) {
    const found = findErrorText(nested);
    if (found) return found;
  }
  return null;
}

function getNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nonEmptyEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function claudeExecutable(): string {
  return nonEmptyEnv("BOOP_CODING_CLAUDE_PATH") ?? nonEmptyEnv("BOOP_CODING_CLI_PATH") ?? "claude";
}

function remoteControlName(projectAbs: string): string {
  const base = path.basename(projectAbs).replace(/[^a-zA-Z0-9_-]/g, "-");
  return `boop-${base}`;
}

function tmuxRemoteSessionName(projectAbs: string, sessionId: string): string {
  const base = path.basename(projectAbs).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 24);
  const hash = createHash("sha1").update(`${projectAbs}:${sessionId}`).digest("hex").slice(0, 8);
  return `boop-rc-${base}-${hash}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function remoteKeepAliveMs(): number {
  const raw = nonEmptyEnv("BOOP_CODING_REMOTE_KEEPALIVE_HOURS") ?? "2";
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return hours * 60 * 60 * 1000;
}

function formatDuration(ms: number): string {
  const hours = ms / (60 * 60 * 1000);
  if (Number.isInteger(hours)) return `${hours}h`;
  return `${Math.round(ms / (60 * 1000))}m`;
}

const CLAUDE_CODE_URL_RE = /https:\/\/claude\.ai\/code\/[A-Za-z0-9][A-Za-z0-9_-]{6,}/;

function stripAnsi(input: string): string {
  return input.replace(/\[[0-9;?]*[A-Za-z]/g, "");
}

function captureRemoteSessionUrl(tmuxName: string, timeoutMs = 20000): Promise<string | undefined> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const out = spawnSync("tmux", ["capture-pane", "-t", tmuxName, "-p", "-J", "-S", "-500"], {
        encoding: "utf8",
      });
      if (out.status === 0 && typeof out.stdout === "string") {
        const match = CLAUDE_CODE_URL_RE.exec(stripAnsi(out.stdout));
        if (match) {
          resolve(match[0]);
          return;
        }
      }
      if (Date.now() >= deadline) {
        resolve(undefined);
        return;
      }
      setTimeout(tick, 400);
    };
    setTimeout(tick, 600);
  });
}

function codexExecutable(): string {
  return nonEmptyEnv("BOOP_CODING_CODEX_PATH") ?? "codex";
}

function codexAppUrl(sessionId?: string): string {
  const template = nonEmptyEnv("BOOP_CODEX_SESSION_URL_TEMPLATE");
  if (template && sessionId) {
    return template.replaceAll("{sessionId}", encodeURIComponent(sessionId));
  }
  return nonEmptyEnv("BOOP_CODEX_URL") ?? "https://chatgpt.com/codex";
}

interface RemoteKeepAlive {
  tmuxName: string;
  ttlMs: number;
  sessionUrl?: string;
}

async function startClaudeRemoteKeepAlive(
  projectAbs: string,
  sessionId: string,
): Promise<RemoteKeepAlive | undefined> {
  const ttlMs = remoteKeepAliveMs();
  if (ttlMs <= 0) return undefined;

  const tmuxName = tmuxRemoteSessionName(projectAbs, sessionId);
  const tmuxOk = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
  if (!tmuxOk) {
    console.warn("[coder] tmux not found; Claude remote-control keepalive skipped");
    return undefined;
  }

  const existing = spawnSync("tmux", ["has-session", "-t", tmuxName], {
    stdio: "ignore",
  }).status === 0;
  if (!existing) {
    const remoteName = remoteControlName(projectAbs);
    const command = [
      "exec",
      shellQuote(claudeExecutable()),
      "--resume",
      shellQuote(sessionId),
      "--remote-control",
      shellQuote(remoteName),
    ].join(" ");
    const child = spawn("tmux", ["new-session", "-d", "-s", tmuxName, "-x", "200", "-y", "50", "-c", projectAbs, command], {
      env: process.env,
      stdio: "ignore",
      detached: true,
    });
    child.on("error", (err) => {
      console.error("[coder] failed to start Claude remote-control keepalive", err);
    });
    child.unref();
  }

  const seconds = Math.ceil(ttlMs / 1000);
  const killer = spawn(
    "sh",
    ["-lc", `sleep ${seconds}; tmux kill-session -t ${shellQuote(tmuxName)} >/dev/null 2>&1 || true`],
    {
      env: process.env,
      stdio: "ignore",
      detached: true,
    },
  );
  killer.unref();

  const sessionUrl = await captureRemoteSessionUrl(tmuxName);
  if (!sessionUrl) {
    console.warn(`[coder] could not capture remote-control session URL from tmux ${tmuxName}`);
  }

  return { tmuxName, ttlMs, sessionUrl };
}

function stopClaudeRemoteKeepAlive(projectAbs: string, sessionId: string): void {
  const tmuxName = tmuxRemoteSessionName(projectAbs, sessionId);
  spawnSync("tmux", ["kill-session", "-t", tmuxName], { stdio: "ignore" });
}

function runProcess(
  agentId: string,
  child: ChildProcess,
  handleStdoutLine: (line: string) => void,
): Promise<{ exitCode: number; stderr: string }> {
  running.set(agentId, child);

  let stderr = "";
  let stdoutLineBuffer = "";

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutLineBuffer += chunk;
    const lines = stdoutLineBuffer.split("\n");
    stdoutLineBuffer = lines.pop() ?? "";
    for (const line of lines) handleStdoutLine(line);
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const done: Promise<{ exitCode: number; stderr: string }> = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (stdoutLineBuffer.trim()) handleStdoutLine(stdoutLineBuffer);
      resolve({ exitCode: code ?? (signal ? 1 : 0), stderr });
    });
  });
  return done.finally(() => {
    running.delete(agentId);
  });
}

async function runClaudeCli(
  agentId: string,
  projectAbs: string,
  prompt: string,
  priorSessionId: string | undefined,
  enqueueLog: (type: AgentLogType, content: string, toolName?: string) => void,
  log: (msg: string) => void,
): Promise<CliRunResult> {
  const requestedModel = process.env.BOOP_CODING_MODEL;
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--effort",
    process.env.BOOP_CODING_CLAUDE_EFFORT ?? "medium",
    "--setting-sources",
    "project,local",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--strict-mcp-config",
    "--dangerously-skip-permissions",
    "--remote-control",
    remoteControlName(projectAbs),
  ];
  if (requestedModel) args.push("--model", requestedModel);
  if (priorSessionId) args.push("--resume", priorSessionId);

  const child = spawn(claudeExecutable(), args, {
    cwd: projectAbs,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  log(
    `spawned claude cli at ${JSON.stringify(claudeExecutable())}${priorSessionId ? ` (resume ${priorSessionId.slice(0, 8)})` : ""}`,
  );

  let lastAssistantText = "";
  let sessionIdSeen: string | undefined;
  let resultErrors: string[] = [];
  let usage: UsageTotals = {
    ...EMPTY_USAGE,
    model: requestedModel ?? "claude-cli",
  };

  const handleStdoutLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const ev = tryJson(trimmed);
    if (!ev) return;

    if (
      typeof ev.session_id === "string" &&
      (ev.type === "init" || ev.type === "assistant" || ev.type === "result")
    ) {
      sessionIdSeen = ev.session_id;
    }

    if (ev.type === "assistant") {
      const message = asRecord(ev.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const block of content) {
        const b = asRecord(block);
        if (b?.type === "text" && typeof b.text === "string") {
          lastAssistantText = b.text;
          enqueueLog("text", b.text);
        } else if (b?.type === "tool_use") {
          const toolName = typeof b.name === "string" ? b.name : "tool";
          enqueueLog("tool_use", JSON.stringify(b.input ?? {}).slice(0, 2000), toolName);
          broadcast("agent_tool", { agentId, toolName });
        }
      }
    } else if (ev.type === "user") {
      const message = asRecord(ev.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const block of content) {
        const b = asRecord(block);
        if (b?.type === "tool_result") {
          enqueueLog("tool_result", JSON.stringify(b.content ?? "").slice(0, 2000));
        }
      }
    } else if (ev.type === "result") {
      if (typeof ev.result === "string") lastAssistantText = ev.result;
      if (Array.isArray(ev.errors)) {
        resultErrors = ev.errors.filter((e): e is string => typeof e === "string");
      }
      usage = {
        model: requestedModel ?? "claude-cli",
        inputTokens: getNumber(ev.usage && asRecord(ev.usage)?.input_tokens),
        outputTokens: getNumber(ev.usage && asRecord(ev.usage)?.output_tokens),
        cacheReadTokens: getNumber(ev.usage && asRecord(ev.usage)?.cache_read_input_tokens),
        cacheCreationTokens: getNumber(ev.usage && asRecord(ev.usage)?.cache_creation_input_tokens),
        costUsd: getNumber(ev.total_cost_usd),
      };
    }
  };

  const { exitCode, stderr } = await runProcess(agentId, child, handleStdoutLine);
  if (cancelledCoders.has(agentId)) {
    return {
      status: "cancelled",
      result: lastAssistantText,
      error: "Cancelled by user.",
      sessionId: sessionIdSeen,
      usage,
    };
  }
  if (exitCode !== 0) {
    const error =
      resultErrors.join(" ").trim() ||
      stderr.split("\n").slice(-3).join(" ").trim() ||
      `claude exited ${exitCode}`;
    return { status: "failed", result: lastAssistantText, error, sessionId: sessionIdSeen, usage };
  }

  return {
    status: "completed",
    result: shortSummary(lastAssistantText || "change applied"),
    sessionId: sessionIdSeen,
    usage,
  };
}

async function runCodexCli(
  agentId: string,
  projectAbs: string,
  prompt: string,
  priorSessionId: string | undefined,
  enqueueLog: (type: AgentLogType, content: string, toolName?: string) => void,
  log: (msg: string) => void,
): Promise<CliRunResult> {
  const summaryPath = path.join(boopScratchDir(), `codex-summary-${Date.now()}.txt`);
  const model = process.env.BOOP_CODING_CODEX_MODEL ?? "gpt-5.5";
  const reasoning = process.env.BOOP_CODING_CODEX_REASONING ?? "high";
  const serviceTier = process.env.BOOP_CODING_CODEX_SERVICE_TIER ?? "fast";
  const baseArgs = [
    "--json",
    "-c",
    `model="${model}"`,
    "-c",
    `model_reasoning_effort="${reasoning}"`,
    "-c",
    `service_tier="${serviceTier}"`,
    "-o",
    summaryPath,
    "--dangerously-bypass-approvals-and-sandbox",
  ];
  const args = priorSessionId
    ? ["exec", "resume", ...baseArgs, priorSessionId, "-"]
    : ["exec", ...baseArgs, "-"];

  const child = spawn(codexExecutable(), args, {
    cwd: projectAbs,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(prompt);
  log(`spawned codex cli${priorSessionId ? ` (resume ${priorSessionId.slice(0, 8)})` : ""}`);

  let lastAssistantText = "";
  let sessionIdSeen: string | undefined;
  const outputErrors: string[] = [];

  const handleStdoutLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const ev = tryJson(trimmed);
    if (!ev) return;
    sessionIdSeen ||= findSessionId(ev) ?? undefined;
    const text = findAssistantText(ev);
    if (text) {
      lastAssistantText = text;
      enqueueLog("text", text);
    }
    const error = findErrorText(ev);
    if (error) outputErrors.push(error);
    const toolName = findToolName(ev);
    if (toolName) {
      enqueueLog("tool_use", trimmed.slice(0, 2000), toolName);
      broadcast("agent_tool", { agentId, toolName });
    }
  };

  const { exitCode, stderr } = await runProcess(agentId, child, handleStdoutLine);
  let summary = lastAssistantText;
  try {
    summary = (await readFile(summaryPath, "utf8")).trim() || summary;
  } catch {
    // Fall back to the JSON event stream.
  }

  if (cancelledCoders.has(agentId)) {
    return {
      status: "cancelled",
      result: shortSummary(summary),
      error: "Cancelled by user.",
      sessionId: sessionIdSeen,
      usage: { ...EMPTY_USAGE, model },
    };
  }

  if (exitCode !== 0) {
    const error =
      outputErrors.join(" ").trim() ||
      stderr.split("\n").slice(-3).join(" ").trim() ||
      `codex exited ${exitCode}`;
    return {
      status: "failed",
      result: shortSummary(summary),
      error,
      sessionId: sessionIdSeen,
      usage: { ...EMPTY_USAGE, model },
    };
  }

  return {
    status: "completed",
    result: shortSummary(summary || "change applied"),
    sessionId: sessionIdSeen,
    usage: { ...EMPTY_USAGE, model },
  };
}

function findToolName(value: unknown): string | null {
  const ev = asRecord(value);
  if (!ev) return null;
  for (const key of ["tool_name", "toolName", "name"]) {
    if (typeof ev[key] === "string" && /tool|cmd|command|exec|patch|shell|bash/i.test(String(ev.type ?? key))) {
      return ev[key] as string;
    }
  }
  for (const nested of Object.values(ev)) {
    const found = findToolName(nested);
    if (found) return found;
  }
  return null;
}

export async function spawnCodingAgent(opts: CodingSpawnOptions): Promise<CodingSpawnResult> {
  const projectAbs = resolveProjectPath(opts.project);
  const agent = normalizeAgent(opts.agent);

  if (!fs.existsSync(projectAbs) || !fs.statSync(projectAbs).isDirectory()) {
    return {
      agentId: "",
      agent,
      result: `Project directory not found: ${projectAbs}`,
      status: "failed",
      projectPath: projectAbs,
    };
  }

  const agentId = randomId("agent");
  const name = opts.name ?? `code:${agent}:${path.basename(projectAbs)}`;
  runningCoders.set(agentId, {
    agentId,
    agent,
    projectPath: projectAbs,
    task: opts.task,
    startedAt: Date.now(),
  });

  const shortId = agentId.slice(-6);
  const log = (msg: string) => console.log(`[coder ${shortId} ${agent}] ${msg}`);
  const taskPreview = opts.task.length > 120 ? opts.task.slice(0, 120) + "..." : opts.task;
  const priorSessionId = readPriorSessionId(agent, projectAbs);
  if (agent === "claude" && priorSessionId) {
    stopClaudeRemoteKeepAlive(projectAbs, priorSessionId);
  }
  log(
    `spawn: ${projectAbs}${priorSessionId ? ` (resume ${priorSessionId.slice(0, 8)})` : ""} - ${JSON.stringify(taskPreview)}`,
  );
  const agentStart = Date.now();

  await convex.mutation(api.agents.create, {
    agentId,
    conversationId: opts.conversationId,
    name,
    task: opts.task,
    mcpServers: [`coding:${agent}`],
  });
  broadcast("agent_spawned", { agentId, name, task: opts.task });
  await convex.mutation(api.agents.update, { agentId, status: "running" });

  let logQueue: Promise<void> = Promise.resolve();
  const enqueueLog = (logType: AgentLogType, content: string, toolName?: string) => {
    logQueue = logQueue
      .then(() =>
        convex.mutation(api.agents.addLog, {
          agentId,
          logType,
          toolName,
          content: content.slice(0, 2000),
        }),
      )
      .then(() => undefined, (err) => {
        console.error(`[coder ${shortId}] log failed`, err);
      });
  };

  let cliResult: CliRunResult;
  try {
    const prompt = buildPrompt(opts.task, agent);
    cliResult =
      agent === "codex"
        ? await runCodexCli(agentId, projectAbs, prompt, priorSessionId, enqueueLog, log)
        : await runClaudeCli(agentId, projectAbs, prompt, priorSessionId, enqueueLog, log);
  } catch (err) {
    const cancelled = cancelledCoders.has(agentId);
    cliResult = {
      status: cancelled ? "cancelled" : "failed",
      result: "",
      error: String(err),
      usage: { ...EMPTY_USAGE, model: `${agent}-cli` },
    };
    enqueueLog("error", cliResult.error ?? String(err));
  } finally {
    running.delete(agentId);
    runningCoders.delete(agentId);
    cancelledCoders.delete(agentId);
  }

  await logQueue;

  if (cliResult.sessionId) {
    try {
      persistSessionId(agent, projectAbs, cliResult.sessionId);
    } catch (err) {
      console.error(`[coder ${shortId}] failed to persist session id`, err);
    }
  }

  const elapsed = ((Date.now() - agentStart) / 1000).toFixed(1);
  log(
    `done (${cliResult.status}, ${elapsed}s, in/out tokens ${cliResult.usage.inputTokens}/${cliResult.usage.outputTokens}, $${cliResult.usage.costUsd.toFixed(4)})`,
  );

  const resultText = cliResult.result || cliResult.error || "(no output)";
  await convex.mutation(api.agents.update, {
    agentId,
    status: cliResult.status,
    result: resultText,
    error: cliResult.error,
    inputTokens: cliResult.usage.inputTokens,
    outputTokens: cliResult.usage.outputTokens,
    cacheReadTokens: cliResult.usage.cacheReadTokens,
    cacheCreationTokens: cliResult.usage.cacheCreationTokens,
    costUsd: cliResult.usage.costUsd,
  });
  if (cliResult.usage.costUsd > 0 || cliResult.usage.inputTokens > 0) {
    await convex.mutation(api.usageRecords.record, {
      source: "execution",
      conversationId: opts.conversationId,
      agentId,
      model: cliResult.usage.model,
      inputTokens: cliResult.usage.inputTokens,
      outputTokens: cliResult.usage.outputTokens,
      cacheReadTokens: cliResult.usage.cacheReadTokens,
      cacheCreationTokens: cliResult.usage.cacheCreationTokens,
      costUsd: cliResult.usage.costUsd,
      durationMs: Date.now() - agentStart,
    });
  }
  broadcast("agent_done", {
    agentId,
    status: cliResult.status,
    result: resultText.slice(0, 200),
  });

  return {
    agentId,
    agent,
    result: resultText,
    status: cliResult.status,
    projectPath: projectAbs,
    sessionId: cliResult.sessionId,
    costUsd: cliResult.usage.costUsd,
  };
}

/**
 * Fire-and-forget runner: spawns the coder, then notifies the user via iMessage
 * + writes a Convex assistant message when it finishes. Caller does NOT await.
 */
export function runCoderInBackground(opts: CodingSpawnOptions): void {
  spawnCodingAgent(opts)
    .then(async (res) => {
      const projectName = path.basename(res.projectPath);
      const agentLabel = res.agent === "codex" ? "codex" : "claude";
      const remoteName = remoteControlName(res.projectPath);
      const keepAlive =
        res.agent === "claude" && res.sessionId
          ? await startClaudeRemoteKeepAlive(res.projectPath, res.sessionId)
          : undefined;
      const claudeUrl = keepAlive?.sessionUrl ?? "https://claude.ai/code";
      const appLink =
        res.agent === "claude"
          ? `\n\nOpen Claude${keepAlive ? ` (live ${formatDuration(keepAlive.ttlMs)})` : ""}: ${claudeUrl}`
          : res.agent === "codex"
            ? `\n\nOpen Codex: ${codexAppUrl(res.sessionId)}`
            : "";
      const handoff =
        res.sessionId && res.agent === "claude"
          ? `\n\nTerminal: cd ${res.projectPath} && claude --resume ${res.sessionId} --remote-control ${remoteName}`
          : res.sessionId && res.agent === "codex"
            ? `\n\nTerminal: cd ${res.projectPath} && codex exec resume ${res.sessionId}`
            : "";
      let header: string;
      if (res.status === "completed") {
        header = `[${agentLabel} coder done - ${projectName}]\n\n`;
      } else {
        header = `[${agentLabel} coder ${res.status} - ${projectName}]\n\n`;
      }
      const message = header + res.result + appLink + handoff;

      if (opts.conversationId) {
        if (opts.conversationId.startsWith("sms:")) {
          const number = opts.conversationId.slice(4);
          try {
            await sendImessage(number, message);
          } catch (err) {
            console.error("[coder] sendImessage failed", err);
          }
        }
        try {
          await convex.mutation(api.messages.send, {
            conversationId: opts.conversationId,
            role: "assistant",
            content: message,
          });
        } catch (err) {
          console.error("[coder] convex notify failed", err);
        }
      }
    })
    .catch((err) => {
      console.error("[coder] background run error", err);
    });
}

export function listRunningCoders(): RunningCoderMeta[] {
  return [...runningCoders.values()].sort((a, b) => a.startedAt - b.startedAt);
}

export function cancelCodingAgent(agentId: string): boolean {
  const child = running.get(agentId);
  if (!child) return false;
  cancelledCoders.add(agentId);
  child.kill("SIGTERM");
  setTimeout(() => {
    if (!child.killed) child.kill("SIGKILL");
  }, 5000).unref();
  return true;
}
