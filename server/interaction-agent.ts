import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { createMemoryMcp } from "./memory/tools.js";
import { extractAndStore } from "./memory/extract.js";
import { availableIntegrations, spawnExecutionAgent } from "./execution-agent.js";
import { createAutomationMcp } from "./automation-tools.js";
import { createCodingMcp } from "./coding-tools.js";
import { createDraftDecisionMcp } from "./draft-tools.js";
import { createImessageMcp } from "./imessage-tools.js";
import { createSelfMcp } from "./self-tools.js";
import { getRuntimeModel } from "./runtime-config.js";
import { broadcast } from "./broadcast.js";
import { sendImessage } from "./sendblue.js";
import { aggregateUsageFromResult, EMPTY_USAGE, type UsageTotals } from "./usage.js";
import { askAtgExec } from "./integrations/atg-exec.js";

const INTERACTION_SYSTEM = `You are Boop, a personal agent the user texts from iMessage.

You are a DISPATCHER, not a doer. Your job:
1. Understand what the user wants.
2. Decide: answer directly (quick facts, chit-chat, anything you already know) OR spawn_agent (real work that needs tools like email, calendar, web, etc.).
3. When you spawn, give the agent a crisp, specific task — not the raw user message.
4. When the agent returns, relay the result in YOUR voice, tightened for iMessage.

Tone: Warm, witty, concise. Write like you're texting a friend. No corporate voice. No bullet dumps unless the user asked for a list.

Your only tools:
- recall / write_memory (durable memory for this user)
- spawn_agent (dispatches a sub-agent that CAN touch the world)
- spawn_coder / continue_coder / list_running_coders / list_recent_coders / cancel_coder (dispatches a real local Claude Code or Codex CLI inside a project directory; runs ASYNC and texts the user when done)
- recent_messages_from_contact (reads recent local iMessage/SMS history for a named contact through the imsg CLI)
- create_automation / list_automations / toggle_automation / delete_automation
- list_drafts / send_draft / reject_draft
- get_config / set_model / set_timezone / list_integrations / search_composio_catalog / inspect_toolkit (self-inspection)

You cannot answer factual questions from your own knowledge. Not allowed.
You have NO browser, NO WebSearch, NO WebFetch, NO file access, NO APIs.
You are not allowed to recite facts about places, events, people, prices,
news, URLs, statistics, or anything "in the world." Your training data does
not count as a source.

Hard rule: if the user asks for information, research, a lookup, a
recommendation that requires real-world data, a current event, a comparison,
a tutorial, a how-to, any URL, or anything you'd be tempted to "just know" —
spawn_agent. No exceptions. Even if you're 99% sure. The sub-agent has
WebSearch/WebFetch and will return real citations; you don't and won't.

Acknowledgment rule (iMessage UX):
BEFORE every spawn_agent call, you MUST call send_ack first with a short
1-sentence message. The user otherwise sees nothing for 10-30 seconds while
the sub-agent works. Examples of good acks:
  "On it — one sec 🔍"
  "Looking into your calendar…"
  "Drafting that email now."
  "Checking Slack, hold tight."
Order: send_ack → spawn_agent → (wait) → final reply with the result.
Skip the ack ONLY for things you'll answer in under 2 seconds (chit-chat,
simple memory recall, single automation toggle).

Memory — recall is MANDATORY before any claim about the user:
Your context does NOT auto-load saved memories. You must call recall()
explicitly. Conversation history is NOT memory — anything older than the
last few turns is gone, and even visible history may not be saved.

Hard rule: BEFORE making ANY statement about the user — names, contacts,
phone numbers, addresses, schedule, preferences, projects, history, who
they know, what they're working on — you MUST call recall() first.

This applies to NEGATIVE claims TOO. Saying "I don't have a phone number
for Alex" without first calling recall() is a CRITICAL FAILURE: that fact
might be in memory and you'd be lying to the user. If you're about to say
"I don't have X stored" or "I don't know that" about something user-
specific, STOP and call recall() first.

Recall is cheap. Overuse is correct. Underuse is a bug. Multiple recalls
per turn are fine and encouraged — different segments, different angles.

write_memory() — call aggressively for durable facts. Err on the side of
saving. If the user reveals anything personal, factual, or preferential,
write it down in the same turn.

Safe to answer directly without recall (a SHORT list):
- Greetings, acknowledgments, conversational filler ("thanks", "lol", "ok").
- Explaining what you just did, confirming a draft, relaying a sub-agent.
- Clarifying your own abilities or asking the user a clarifying question.
- Anything in the same conversation turn the user JUST told you (echo
  back is fine; persistent facts still need write_memory).

Everything else about the user — SPAWN or RECALL FIRST.

Never fabricate URLs, site names, "sources", statistics, news, quotes, prices,
dates, or any external fact. "Sources: [vague site names]" is fabrication.

When relaying a sub-agent's answer:
- Pass through the Sources section the sub-agent included, VERBATIM. Don't
  add, remove, paraphrase, or summarize URLs.
- If the sub-agent did NOT include a Sources section, YOU DO NOT ADD ONE.
  Do not write "Sources: Lonely Planet, etc." No exceptions.
- You may tighten the body for iMessage (shorter bullets, fewer emojis),
  but the URLs are ground truth — don't touch them.

Automations:
When the user wants something to happen on a recurring schedule — daily,
weekly, before/after some recurring event, anything that should fire more
than once — use create_automation with a 5-field cron expression and a
concrete task description for the sub-agent. Don't just promise to
remember and do it later; if there's a schedule, there's a cron.

When the user wants to inspect, change, pause, resume, or remove
automations they've already set up, use list_automations /
toggle_automation / delete_automation. Route by intent — the user may
phrase it as "what's running", "kill the morning thing", "pause that
weekly digest", etc.

Drafts:
External actions (email, calendar event, Slack message, etc.) go through a
draft flow — execution agents SAVE drafts; only send_draft actually commits.

When the user signals they want a previously-prepared action to go through —
ANY phrasing — call list_drafts to see what's pending, then send_draft on
the matching ones. The intent ("execute the thing we just talked about") is
what matters; don't try to match specific words. If a message could either
be a confirm OR a fresh request, and there are pending drafts in this
conversation, check list_drafts FIRST — the user almost always means
"finalize what we already drafted," not "start a new one."

When the user signals they want to back out (cancel, scrap it, different
version, never mind, etc.), call reject_draft.

Never claim something was sent unless send_draft returned success.

Integration capabilities — IMPORTANT:
You only know integration NAMES, not their actual tool surface. Composio's
toolkits don't always expose the tools you'd expect from the brand (e.g. the
LinkedIn toolkit has no inbox/DM tools). If the user asks what you can do
with a specific integration, spawn_agent against it — the sub-agent has
COMPOSIO_SEARCH_TOOLS and will return the real tool list. Never describe
integration capabilities from training-data knowledge of the product.

Self-inspection (no spawn needed — answer instantly):
When the user asks about Boop itself, pick the tool by intent:
- Wants to know what model / config / time is currently in effect → get_config
- Wants to switch models or change speed/quality tradeoff → set_model
  (takes effect next turn; this turn finishes on the current model)
- Wants to know which integrations or accounts are connected → list_integrations
- Wondering whether some service is connectable at all → search_composio_catalog
- Probing the actual capabilities of a specific connected integration
  (does Slack expose DMs? does Notion let me create databases?) → inspect_toolkit
- Telling Boop where they are or what timezone they want → set_timezone
  (accepts IANA IDs or natural names like "central time" or city names)

These are cheap and synchronous — no ack required. The user's phrasing
will vary; route by what they're trying to accomplish, not by keyword
matching.

Time / timezone:
The user has a saved timezone in get_config.userTimezone. Whenever your reply
or a sub-agent's task depends on local time (deadlines, "today", "9am
tomorrow", RSVP windows, scheduling, "in N hours"), call get_config first to
read it. If userTimezone is null, the system is currently using
timezoneFallback (the server's local zone, which may be wrong) — ASK the
user once ("what timezone are you in?") and call set_timezone with their
answer. Don't silently guess from city names mentioned in passing — confirm
before saving.

Available integrations for spawn_agent: {{INTEGRATIONS}}

ATG business questions:
- For anything about ATG / Athletic Truth Group business metrics — MRR, ARR, churn, cancelled subs, new signups, customers, top products, country breakdowns, weekly briefings, finance sheets, PostHog metrics, Chargebee/Shopify data — call ask_atg DIRECTLY. Do NOT spawn a sub-agent for these; ask_atg already has all the integrations and skipping the spawn layer saves seconds.
- ask_atg may return an image marker like [ATG_IMAGE:/abs/path.png]. INCLUDE IT VERBATIM in your final reply (on its own line). The reply pipeline strips it and attaches the image to the iMessage. Do not describe the image, do not paraphrase, do not strip the marker — keep your text reply short, the image does the talking.

Coding (spawn_coder):
- Use for any programming/software/project task that needs local project files, shell commands, dependencies, tests, config, repo setup, dev servers, webhooks, API keys, migrations, UI changes, bug fixes, refactors, package installs, deploy/tunnel setup, or checking how a codebase works.
- Infer coding intent from normal language. The user will usually NOT say "coder" or "coding agent". Requests like "add this", "fix that bug", "set up this project", "update the webhook", "make the UI show X", "why is the server doing Y", "run the tests", "install this package", "wire up OpenAI", "change the architecture", or "continue that change" should route here when they are about a repo or local app.
- Do NOT use generic spawn_agent for repo work unless the task is mainly external research/account work with no local code changes.
- Pass "project" (bare name resolves to ~/Programming/<name>, or absolute path) and a crisp task.
- Default to agent="claude". Use agent="codex" only when the user explicitly asks for Codex ("use codex", "do this with codex", etc.).
- spawn_coder runs ASYNC. It returns immediately. The coder works in the background and the user receives a follow-up iMessage like "[coder done - <project>]..." when it finishes. Tell the user you've kicked it off; do NOT pretend the work is done.
- The coder has full project-local CLI power. Claude Code sessions start with remote control enabled when supported; completion messages include a resume command so the user can jump in directly.
- For follow-up iteration on the last programming/project task, use continue_coder instead of asking for the project again. Examples: "also make it show the date", "that didn't work", "have it fix the test", "can you tweak the button", "now wire up OpenAI", "why did it do local", "force re-embed", "keep going", "ship that with Codex". It resumes the most recent coder session and texts the user when done.
- For status questions ("where's that fix at?", "what's still running?") use list_running_coders.
- For outcome/failure questions ("did it fail?", "is it done?", "why did it cancel?", "what happened?"), call list_recent_coders before answering. Do not guess from conversation context and do not start a new coder unless the user asks to retry or continue.
- For "cancel that" use cancel_coder with the agentId from list_running_coders.
- If a recent turn in this conversation listed image attachment paths (e.g. under /Users/.../Library/Messages/Attachments/), include those absolute paths verbatim in the task string you pass to spawn_coder. The coder's Read tool can open PNG/JPEG/HEIC and the images often carry the actual context the sender meant to convey.

iMessage lookup:
- When the user explicitly asks to look at, inspect, summarize, or use recent texts/iMessages from a named person, call recent_messages_from_contact. Do not ask for a phone number first; names like "Isaac" resolve through imsg chat metadata.
- This is for local Messages history only. Do not use it for generic facts about a person or for contacting them.
- If the returned messages include attachment paths and the user wants coding/design work based on them, pass those absolute paths to spawn_coder or continue_coder.

Format: Plain iMessage-friendly text. Markdown sparingly. Keep replies under ~400 chars when you can.`;

interface HandleOpts {
  conversationId: string;
  content: string;
  turnTag?: string;
  onThinking?: (chunk: string) => void;
  // "proactive" persists the inbound message with role=system instead of
  // role=user, so the synthetic notice the IA receives doesn't pollute the
  // user-message history. Defaults to "user".
  kind?: "user" | "proactive";
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function handleUserMessage(opts: HandleOpts): Promise<string> {
  // Deterministic /clear short-circuit. Exact match (trim + case-insensitive)
  // on "clear" wipes conversation history before any LLM call. Does NOT touch
  // memory or coding sessions — only the per-turn message history.
  // Returns the reply string and lets the webhook handler send/persist it.
  if (opts.content.trim().toLowerCase() === "clear") {
    const deleted = await convex.mutation(api.messages.clearConversation, {
      conversationId: opts.conversationId,
    });
    broadcast("conversation_cleared", {
      conversationId: opts.conversationId,
      deleted,
    });
    return `Cleared ${deleted} message${deleted === 1 ? "" : "s"}. Fresh start. (Memory kept.)`;
  }

  const turnId = randomId("turn");
  const integrations = availableIntegrations();

  const inboundRole = opts.kind === "proactive" ? "system" : "user";
  await convex.mutation(api.messages.send, {
    conversationId: opts.conversationId,
    role: inboundRole,
    content: opts.content,
    turnId,
  });
  broadcast(opts.kind === "proactive" ? "proactive_notice" : "user_message", {
    conversationId: opts.conversationId,
    content: opts.content,
  });

  const memoryServer = createMemoryMcp(opts.conversationId);
  const automationServer = createAutomationMcp(opts.conversationId);
  const codingServer = createCodingMcp(opts.conversationId);
  const draftDecisionServer = createDraftDecisionMcp(opts.conversationId);
  const imessageServer = createImessageMcp();
  const selfServer = createSelfMcp();

  const ackServer = createSdkMcpServer({
    name: "boop-ack",
    version: "0.1.0",
    tools: [
      tool(
        "send_ack",
        `Send a short acknowledgment message to the user IMMEDIATELY, before a slow operation. Use this BEFORE spawn_agent so the user knows you heard them and are working on it. Keep it to ONE short sentence (ideally under 60 chars) with tone that matches the task. Examples: "On it — one sec 🔍", "Looking into it…", "Drafting now, hold tight.", "Let me check your calendar."`,
        {
          message: z.string().describe("1 short sentence ack. No markdown. Emojis OK."),
        },
        async (args) => {
          const text = args.message.trim();
          if (!text) {
            return {
              content: [{ type: "text" as const, text: "Empty ack skipped." }],
            };
          }
          // Skip the iMessage send for proactive turns — those go out as a
          // single self-contained notice from dispatchProactiveNotice. If the
          // IA calls send_ack here on a proactive turn, the user would get
          // two iMessages (the ack + the final reply). Still persist + log
          // so the debug UI sees it.
          if (opts.conversationId.startsWith("sms:") && opts.kind !== "proactive") {
            const number = opts.conversationId.slice(4);
            await sendImessage(number, text);
          }
          await convex.mutation(api.messages.send, {
            conversationId: opts.conversationId,
            role: "assistant",
            content: text,
            turnId,
          });
          broadcast("assistant_ack", {
            conversationId: opts.conversationId,
            content: text,
          });
          log(`→ ack: ${text}`);
          return {
            content: [{ type: "text" as const, text: "Ack sent to user." }],
          };
        },
      ),
    ],
  });

  // Direct ATG access at the interaction-agent layer. Skipping the sub-agent
  // for ATG questions cuts ~5–10s off the round trip — the IA itself can call
  // exec-chat's /api/ask, then pass the image marker straight through to the
  // user. Only registered when ATG_EXEC_SECRET is set.
  const atgServer = process.env.ATG_EXEC_SECRET
    ? createSdkMcpServer({
        name: "boop-atg",
        version: "0.1.0",
        tools: [
          tool(
            "ask_atg",
            [
              "Ask ATG Exec Chat (Caleb's ATG business assistant) a natural-language question. Read-only",
              "access to Chargebee (US + International), Shopify (orders / customers / products / top",
              "sellers), Google Sheets finance, and PostHog. Use this for any ATG / business question:",
              "MRR, ARR, churn, cancellations, signups, top products, country breakdowns, weekly briefings,",
              "HogQL queries, finance-sheet stuff. Don't spawn a sub-agent for these — call this directly.",
              "",
              "When the answer is visual (chart / map / table / KPIs / briefing) the tool returns an",
              "image marker `[ATG_IMAGE:/absolute/path.png]`. INCLUDE THAT MARKER VERBATIM in your reply.",
              "The reply pipeline strips it and attaches the image to the iMessage. Don't paraphrase or",
              "describe the image — let it speak for itself, and keep your text reply short.",
            ].join("\n"),
            {
              question: z
                .string()
                .describe("Natural-language question, including any time-range/region context. Pass through the user's wording."),
              format: z
                .enum(["text", "rich"])
                .optional()
                .describe("'rich' (default) returns an image when the answer is visual. Use 'text' to suppress images."),
              model: z
                .enum(["gemini-3.5-flash", "gpt-5.5"])
                .optional()
                .describe("Override exec-chat's model. Defaults to GPT 5.5."),
            },
            async (args) => {
              const result = await askAtgExec(args.question, {
                format: args.format,
                model: args.model,
              });
              const lines = [result.text || "(no text response)"];
              if (result.imagePath) {
                lines.push("", `[ATG_IMAGE:${result.imagePath}]`);
              }
              return {
                content: [{ type: "text" as const, text: lines.join("\n") }],
              };
            },
          ),
        ],
      })
    : null;

  const spawnServer = createSdkMcpServer({
    name: "boop-spawn",
    version: "0.1.0",
    tools: [
      tool(
        "spawn_agent",
        "Spawn a focused sub-agent to do real work using external tools. Returns the agent's final answer. Use for anything requiring lookups, drafting, or actions in the user's integrations.",
        {
          task: z
            .string()
            .describe("Crisp task description — what to find/draft/do, not the raw user message."),
          integrations: z
            .array(z.string())
            .describe(`Which integrations to give the agent. Available: ${integrations.join(", ") || "(none)"}`),
          name: z.string().optional().describe("Short label for the agent."),
        },
        async (args) => {
          const res = await spawnExecutionAgent({
            task: args.task,
            integrations: args.integrations,
            conversationId: opts.conversationId,
            name: args.name,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: `[agent ${res.agentId} ${res.status}]\n\n${res.result}`,
              },
            ],
          };
        },
      ),
    ],
  });

  const history = await convex.query(api.messages.recent, {
    conversationId: opts.conversationId,
    limit: 10,
  });
  const historyBlock = history
    .slice(0, -1)
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n");

  const systemPrompt = INTERACTION_SYSTEM.replace(
    "{{INTEGRATIONS}}",
    integrations.join(", ") || "(no integrations configured yet)",
  );

  const prompt = historyBlock
    ? `Prior turns:\n${historyBlock}\n\nCurrent message:\n${opts.content}`
    : opts.content;

  const tag = opts.turnTag ?? turnId.slice(-6);
  const log = (msg: string) => console.log(`[turn ${tag}] ${msg}`);

  const turnStart = Date.now();
  const requestedModel = await getRuntimeModel();
  let reply = "";
  let usage: UsageTotals = { ...EMPTY_USAGE };
  try {
    for await (const msg of query({
      prompt,
      options: {
        systemPrompt,
        model: requestedModel,
        mcpServers: {
          "boop-memory": memoryServer,
          "boop-spawn": spawnServer,
          "boop-automations": automationServer,
          "boop-coding": codingServer,
          "boop-draft-decisions": draftDecisionServer,
          "boop-imessage": imessageServer,
          "boop-ack": ackServer,
          "boop-self": selfServer,
          ...(atgServer ? { "boop-atg": atgServer } : {}),
        },
        allowedTools: [
          "mcp__boop-memory__write_memory",
          "mcp__boop-memory__recall",
          "mcp__boop-spawn__spawn_agent",
          "mcp__boop-coding__spawn_coder",
          "mcp__boop-coding__continue_coder",
          "mcp__boop-coding__list_running_coders",
          "mcp__boop-coding__list_recent_coders",
          "mcp__boop-coding__cancel_coder",
          "mcp__boop-automations__create_automation",
          "mcp__boop-automations__list_automations",
          "mcp__boop-automations__toggle_automation",
          "mcp__boop-automations__delete_automation",
          "mcp__boop-draft-decisions__list_drafts",
          "mcp__boop-draft-decisions__send_draft",
          "mcp__boop-draft-decisions__reject_draft",
          "mcp__boop-imessage__recent_messages_from_contact",
          "mcp__boop-ack__send_ack",
          "mcp__boop-self__get_config",
          "mcp__boop-self__set_model",
          "mcp__boop-self__set_timezone",
          "mcp__boop-self__list_integrations",
          "mcp__boop-self__search_composio_catalog",
          "mcp__boop-self__inspect_toolkit",
          "mcp__boop-atg__ask_atg",
        ],
        // Belt-and-suspenders: even with bypassPermissions the SDK can leak
        // its built-ins if we only whitelist. Explicitly block them on the
        // dispatcher so it MUST spawn a sub-agent for external work.
        disallowedTools: [
          "WebSearch",
          "WebFetch",
          "Bash",
          "Read",
          "Write",
          "Edit",
          "Glob",
          "Grep",
          "Agent",
          "Skill",
        ],
        permissionMode: "bypassPermissions",
      },
    })) {
      if (msg.type === "assistant") {
        // Reset `reply` on each new assistant turn so only the LAST turn's
        // text becomes the user-facing iMessage. Earlier turns are usually
        // pre-tool-call narration ("Got it — saving that now.") that, if
        // concatenated with the post-tool-result final text, sends as one
        // smushed iMessage. Streaming via onThinking still sees everything.
        reply = "";
        for (const block of msg.message.content) {
          if (block.type === "text") {
            reply += block.text;
            opts.onThinking?.(block.text);
          } else if (block.type === "tool_use") {
            const name = block.name.replace(/^mcp__boop-[a-z-]+__/, "");
            const inputPreview = JSON.stringify(block.input);
            log(
              `tool: ${name}(${inputPreview.length > 90 ? inputPreview.slice(0, 90) + "…" : inputPreview})`,
            );
          }
        }
      } else if (msg.type === "result") {
        usage = aggregateUsageFromResult(msg, requestedModel);
      }
    }
  } catch (err) {
    console.error(`[turn ${tag}] query failed`, err);
    reply = "Sorry — I hit an error processing that. Try again in a moment.";
  }

  // Sometimes the model produces a placeholder string like "(no output)" or
  // "(no reply)" instead of composing a real reply — usually after a tool
  // call cycle where it lost the thread of what to say. Treat those as
  // empty so the user gets a real fallback they can act on.
  reply = reply.trim();
  // Match "(no output)" / "no reply." / "(No Response)" etc. Parens are
  // matched as a balanced pair (or omitted) — alternation prevents `(no
  // output` or `no output)` with one stray paren from sneaking through.
  const placeholder =
    /^(?:\(\s*no (?:output|reply|response|content)\s*\)|no (?:output|reply|response|content))\.?$/i;
  if (!reply || placeholder.test(reply)) {
    console.warn(`[turn ${tag}] empty/placeholder reply (${JSON.stringify(reply)}) — using fallback`);
    // Frame as model-side hiccup, not user error — the placeholder fires
    // when the model loses the thread mid-tool-call, the user's phrasing
    // is fine.
    reply = "Hmm — got tangled up there. Want to try that again?";
  }

  if (usage.costUsd > 0 || usage.inputTokens > 0) {
    log(
      `cost: in/out ${usage.inputTokens}/${usage.outputTokens}, cache r/w ${usage.cacheReadTokens}/${usage.cacheCreationTokens}, $${usage.costUsd.toFixed(4)}`,
    );
    await convex.mutation(api.usageRecords.record, {
      source: "dispatcher",
      conversationId: opts.conversationId,
      turnId,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      costUsd: usage.costUsd,
      durationMs: Date.now() - turnStart,
    });
  }

  broadcast("assistant_message", { conversationId: opts.conversationId, content: reply });

  // Background extraction — fire-and-forget; don't block the reply.
  // Skip on proactive turns: the "user message" is a synthetic
  // [proactive notice] derived from email content, not something the user
  // said. Letting extractAndStore run on it would persist email-derived
  // facts ("Alice asked about Q4 report") as user preferences/memory — the
  // same store the classifier reads on the next event, creating a feedback
  // loop where surfaced emails reshape future classification.
  if (opts.kind !== "proactive") {
    extractAndStore({
      conversationId: opts.conversationId,
      userMessage: opts.content,
      assistantReply: reply,
      turnId,
    }).catch((err) => console.error("[interaction] extraction error", err));
  }

  return reply;
}
