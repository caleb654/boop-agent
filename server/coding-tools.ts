import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import {
  cancelCodingAgent,
  latestCoderSession,
  listRunningCoders,
  resolveProjectPath,
  runCoderInBackground,
  type CodingAgentKind,
} from "./coding-agent.js";
import { convex } from "./convex-client.js";

function fmtAgo(ms: number): string {
  const d = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

export function createCodingMcp(conversationId: string) {
  return createSdkMcpServer({
    name: "boop-coding",
    version: "0.1.0",
    tools: [
      tool(
        "spawn_coder",
        `Kick off a real local CLI coding agent inside a project directory. Defaults to Claude Code; use Codex when the user explicitly asks for Codex. Asynchronous - the coder runs in the background and the user gets an iMessage when it finishes.

Use for: programming/software/project tasks that need local project files or commands - implementing features, fixing bugs, changing UI, editing config, wiring APIs/webhooks/env vars, installing packages, running tests, starting dev servers, setting up projects, migrations, refactors, deploy/tunnel setup, or inspecting how a repo works.

Infer intent from normal language. The user usually will not say "coder". If they ask to add, fix, set up, wire, install, test, debug, refactor, update, deploy, start, or continue something in a repo/local app, use this tool.

Project resolution:
  - Bare name like "boop-agent" resolves to ~/Programming/boop-agent (override via BOOP_CODING_ROOT).
  - Absolute path or "~/foo" is used as-is.

Sessions persist per project and per CLI. Subsequent Claude calls for the same project resume the prior Claude Code conversation; Codex calls resume the prior Codex conversation. Claude Code sessions start with remote control enabled when supported. Completion messages include a resume command so the user can jump in directly.

Capabilities: full project-local file edits and shell commands through the selected CLI.

This tool returns IMMEDIATELY with an "agent <id> started" message. Do not pretend the work is done - relay to the user that you've kicked it off and you'll text them the result when it finishes.`,
        {
          project: z
            .string()
            .describe(
              "Project directory. Bare name (resolved under ~/Programming) or absolute path.",
            ),
          task: z
            .string()
            .describe(
              "Crisp coding task - be specific about files, intent, and acceptance criteria.",
            ),
          name: z
            .string()
            .optional()
            .describe("Short label (defaults to code:<basename>)."),
          agent: z
            .enum(["claude", "codex"])
            .optional()
            .describe("Coding CLI to use. Default is claude. Use codex only when the user asks for Codex."),
        },
        async (args) => {
          const projectAbs = resolveProjectPath(args.project);
          runCoderInBackground({
            project: args.project,
            task: args.task,
            conversationId,
            name: args.name,
            agent: args.agent,
          });
          const agent = args.agent ?? "claude";
          return {
            content: [
              {
                type: "text" as const,
                text: `${agent} coder started in ${projectAbs}. The user will get a follow-up iMessage when it finishes.`,
              },
            ],
          };
        },
      ),

      tool(
        "continue_coder",
        `Send a follow-up task to the most recent coder session. Use this when the user wants to iterate on the last programming/project task through iMessage without naming the project again.

Infer this from normal follow-up language, even if the user never says "coder". Examples: "also add the date", "that didn't work", "why is it doing local", "force re-embed", "make it one click", "now wire up OpenAI", "continue that", "fix the tests", "ship that with codex", "what about setup?".

This resumes the last persisted Claude/Codex session for its project, runs asynchronously, and texts the user when finished. For Claude, any idle remote-control keepalive for that session is closed before the batch follow-up starts, then reopened when the follow-up finishes.`,
        {
          task: z
            .string()
            .describe("Crisp follow-up task to send to the most recent coder session."),
          agent: z
            .enum(["claude", "codex"])
            .optional()
            .describe("Filter to the most recent session for this CLI. Default picks the most recent coder of either type."),
        },
        async (args) => {
          const session = latestCoderSession(args.agent as CodingAgentKind | undefined);
          if (!session) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "No prior coder session found. Ask for a project or use spawn_coder first.",
                },
              ],
            };
          }
          runCoderInBackground({
            project: session.projectPath,
            task: args.task,
            conversationId,
            name: `code:${session.agent}:${session.projectPath.split("/").pop()}:followup`,
            agent: session.agent,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: `${session.agent} coder follow-up started in ${session.projectPath}. The user will get a follow-up iMessage when it finishes.`,
              },
            ],
          };
        },
      ),

      tool(
        "list_running_coders",
        "List all coder agents currently running in the background. Use when the user asks for status (e.g. 'where's that fix at?', 'what's still going?').",
        {},
        async () => {
          const coders = listRunningCoders();
          if (coders.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No coders running." }],
            };
          }
          const lines = coders.map((c) => {
            const taskPreview =
              c.task.length > 80 ? c.task.slice(0, 80) + "..." : c.task;
            return `- [${c.agentId}] ${c.agent} ${c.projectPath} - ${fmtAgo(c.startedAt)} - ${taskPreview}`;
          });
          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
          };
        },
      ),

      tool(
        "list_recent_coders",
        "List recent coder runs, including completed, failed, and cancelled runs. Use before answering status/failure questions like 'did it fail?', 'what happened?', 'why did that cancel?', or 'is it done?'.",
        { limit: z.number().optional().describe("Maximum recent coder runs to return. Default 8.") },
        async (args) => {
          const all = await convex.query(api.agents.list, { limit: Math.max(args.limit ?? 8, 8) * 3 });
          const coders = all
            .filter((a) => a.mcpServers.some((server) => server.startsWith("coding:")))
            .slice(0, args.limit ?? 8);
          if (coders.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No recent coder runs found." }],
            };
          }
          const lines = coders.map((a) => {
            const taskPreview = a.task.length > 90 ? a.task.slice(0, 90) + "..." : a.task;
            const error = a.error ? ` error=${a.error.slice(0, 140)}` : "";
            return `- [${a.agentId}] ${a.status} ${a.name} - ${fmtAgo(a.startedAt)} ago - ${taskPreview}${error}`;
          });
          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
          };
        },
      ),

      tool(
        "cancel_coder",
        "Abort a running coder by id. Use when the user says to stop or cancel a specific coding task.",
        { agentId: z.string() },
        async (args) => {
          const ok = cancelCodingAgent(args.agentId);
          return {
            content: [
              {
                type: "text" as const,
                text: ok ? `Cancelled ${args.agentId}.` : `No running coder with id ${args.agentId}.`,
              },
            ],
          };
        },
      ),
    ],
  });
}
