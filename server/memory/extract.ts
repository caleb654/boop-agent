import { query } from "@anthropic-ai/claude-agent-sdk";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { embed } from "../embeddings.js";
import { aggregateUsageFromResult, EMPTY_USAGE, type UsageTotals } from "../usage.js";
import { SEGMENT_DEFAULTS, makeMemoryId, type MemorySegment } from "./types.js";

const EXTRACTION_PROMPT = `You are a memory-extraction subagent.

Given a user message + assistant reply, extract any DURABLE facts worth remembering.
Return STRICT JSON:
{"facts":[
  {"content":"...","segment":"identity|preference|correction|relationship|project|knowledge|context","importance":0.0-1.0,"corrects":"what was wrong, if this is a correction"}
]}

Rules:
- Prefer fewer, higher-quality facts over many trivial ones.
- Skip anything transient ("I'm tired right now"). Context facts should describe ongoing state, not momentary feelings.
- Segment meanings:
  - identity: name, role, location, core traits (highest priority — rarely changes)
  - correction: the user explicitly corrected something. "No, it's Sarah not Sara." "Actually I prefer X not Y." Set "corrects" to the wrong value or prior belief being overturned. Use this instead of preference/identity when the user is FIXING something rather than stating it fresh.
  - preference: how they like things done (style, defaults)
  - relationship: people they know + how
  - project: ongoing work or goals
  - knowledge: facts about their world
  - context: current ongoing situation
- Importance defaults: identity 0.85, correction 0.80, relationship 0.75, preference 0.70, project 0.65, knowledge 0.60, context 0.40. Bump up or down only when you have a clear reason — trust the defaults.
- The "corrects" field is ONLY for segment="correction". Omit it (or null) for everything else.
- Return empty facts array if nothing durable.

Respond with ONLY the JSON object.`;

interface ExtractedFact {
  content: string;
  segment: MemorySegment;
  importance: number;
  corrects?: string | null;
}

/**
 * Find the first balanced {...} substring whose JSON parses and contains a
 * `facts` array. Walks brace depth in a string-aware way so braces inside
 * quoted strings (and braces from incidental code in the assistant reply, like
 * `import { query } from "..."`) don't break the match.
 */
function extractFactsObject(s: string): { facts: ExtractedFact[] } | null {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (esc) {
          esc = false;
          continue;
        }
        if (c === "\\") {
          esc = true;
          continue;
        }
        if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(s.slice(i, j + 1)) as {
              facts?: ExtractedFact[];
            };
            if (Array.isArray(parsed.facts)) {
              return { facts: parsed.facts };
            }
          } catch {
            /* try next candidate */
          }
          break;
        }
      }
    }
  }
  return null;
}

export async function extractAndStore(opts: {
  conversationId: string;
  userMessage: string;
  assistantReply: string;
  turnId: string;
}): Promise<void> {
  const started = Date.now();
  const requestedModel = process.env.BOOP_MODEL ?? "claude-sonnet-4-6";
  try {
    const payload = `USER: ${opts.userMessage}\n\nASSISTANT: ${opts.assistantReply}`;
    let buffer = "";
    let usage: UsageTotals = { ...EMPTY_USAGE };
    for await (const msg of query({
      prompt: payload,
      options: {
        systemPrompt: EXTRACTION_PROMPT,
        model: requestedModel,
        permissionMode: "bypassPermissions",
      },
    })) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text") buffer += block.text;
        }
      } else if (msg.type === "result") {
        usage = aggregateUsageFromResult(msg, requestedModel);
      }
    }

    if (usage.costUsd > 0 || usage.inputTokens > 0) {
      await convex.mutation(api.usageRecords.record, {
        source: "extract",
        conversationId: opts.conversationId,
        turnId: opts.turnId,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        costUsd: usage.costUsd,
        durationMs: Date.now() - started,
      });
    }

    const parsed = extractFactsObject(buffer);
    if (!parsed) return;
    const facts = parsed.facts;

    for (const f of facts) {
      const defaults = SEGMENT_DEFAULTS[f.segment];
      if (!defaults) continue; // skip unknown segment rather than crashing
      // Clamp importance to [0, 1]; fall back to segment default when the
      // LLM omits it or returns garbage.
      const rawImportance =
        typeof f.importance === "number" && Number.isFinite(f.importance)
          ? Math.max(0, Math.min(1, f.importance))
          : defaults.importance;
      const memoryId = makeMemoryId();
      const embedding = (await embed(f.content)) ?? undefined;
      const metadata =
        f.segment === "correction" && f.corrects
          ? JSON.stringify({ corrects: f.corrects })
          : undefined;
      await convex.mutation(api.memoryRecords.upsert, {
        memoryId,
        content: f.content,
        tier: defaults.tier,
        segment: f.segment,
        importance: rawImportance,
        decayRate: defaults.decayRate,
        sourceTurn: opts.turnId,
        embedding,
        metadata,
      });
    }

    await convex.mutation(api.memoryEvents.emit, {
      eventType: "memory.extracted",
      conversationId: opts.conversationId,
      data: JSON.stringify({ turnId: opts.turnId, count: facts.length }),
    });
  } catch (err) {
    console.error("[memory.extract] failed", err);
  }
}
