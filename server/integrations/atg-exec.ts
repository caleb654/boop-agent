/**
 * ATG Exec Chat integration.
 *
 * Hand-rolled HTTP wrapper around the exec-chat app's `/api/ask` endpoint
 * (lives at `~/documents_not_icloud/Programming/atg/exec-chat`). Lets the
 * execution agent ask ATG business questions (MRR, churn, top products,
 * finance sheets, PostHog metrics) and get back a text answer plus, when
 * the response is visual (chart / map / weekly briefing), a PNG that
 * boop attaches to the iMessage reply.
 *
 * Configuration:
 *   ATG_EXEC_URL     – default http://localhost:3005
 *   ATG_EXEC_SECRET  – matches the same env var in exec-chat's .env.local
 *
 * Image flow (per user choice — see PR notes):
 *   1. /api/ask returns { text, image?: { base64, type } }
 *   2. We decode the PNG, save to /tmp/atg-images/<uuid>.png
 *   3. Boop's express server already exposes /atg-images/<uuid>.png publicly
 *      (wired in server/index.ts) — that URL becomes the media_url for
 *      sendImessage's MMS path.
 *   4. Tool result text includes a `[ATG_IMAGE:<absolute-path>]` marker;
 *      the interaction-agent reply pipeline strips that and sends the
 *      image alongside the text reply.
 */

import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { IntegrationModule } from "./registry.js";

const DEFAULT_URL = "http://localhost:3005";
const IMAGE_DIR = join(tmpdir(), "atg-images");

function getUrl(): string {
  // Varlock injects schema-declared vars as empty strings when no value is
  // set in .env.local, so `??` alone isn't enough — fall back on empty too.
  const raw = process.env.ATG_EXEC_URL?.trim();
  return (raw || DEFAULT_URL).replace(/\/$/, "");
}

function getSecret(): string | undefined {
  return process.env.ATG_EXEC_SECRET;
}

export interface AtgAskResult {
  text: string;
  imagePath?: string;
  imageType?: string;
}

/**
 * Calls exec-chat's /api/ask. When the answer is visual the PNG is saved
 * to /tmp/atg-images/<uuid>.png and the path is returned so the caller
 * (an LLM) can include it in its reply.
 */
export async function askAtgExec(
  question: string,
  opts: { format?: "text" | "rich"; model?: "gemini-3.5-flash" | "gpt-5.5" } = {},
): Promise<AtgAskResult> {
  const secret = getSecret();
  if (!secret) {
    throw new Error("[atg-exec] ATG_EXEC_SECRET is not set");
  }
  const format = opts.format ?? "rich";
  const res = await fetch(`${getUrl()}/api/ask`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ question, format, model: opts.model }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[atg-exec] /api/ask ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = (await res.json()) as {
    text?: string;
    image?: { base64: string; mimeType: string; type: string };
  };

  let imagePath: string | undefined;
  let imageType: string | undefined;
  if (data.image?.base64) {
    mkdirSync(IMAGE_DIR, { recursive: true });
    const id = randomUUID();
    imagePath = join(IMAGE_DIR, `${id}.png`);
    writeFileSync(imagePath, Buffer.from(data.image.base64, "base64"));
    imageType = data.image.type;
  }

  return { text: data.text ?? "", imagePath, imageType };
}

function jsonText(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function createAtgExecMcp(): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "atg-exec",
    version: "0.1.0",
    tools: [
      tool(
        "ask_atg",
        [
          "Ask ATG Exec Chat — Caleb's internal business assistant — a natural-language question",
          "about ATG's business metrics. Has read-only access to Chargebee (subscriptions / customers /",
          "invoices / refunds — US + International combined), Shopify (orders / customers / products /",
          "top sellers / variants), Google Sheets (finance), and PostHog (events, HogQL).",
          "",
          "Use this tool for any ATG / Caleb's business question — MRR, ARR, churn, cancelled subs,",
          "new signups, top selling products, country breakdowns, weekly briefings, custom HogQL",
          "queries, anything finance-sheet driven. Don't try to answer ATG business questions from",
          "memory — call this and quote what it returns.",
          "",
          "When the answer is visual (chart / map / weekly briefing), the tool also returns an",
          "absolute image path. INCLUDE THAT PATH VERBATIM in your reply, wrapped as",
          "`[ATG_IMAGE:/absolute/path.png]` on its own line. The reply pipeline strips that marker",
          "and attaches the image to the iMessage. Don't describe the image — let the chart speak.",
        ].join("\n"),
        {
          question: z
            .string()
            .describe("The user's natural-language question, passed through. Be specific — include any time-range/region context the user mentioned."),
          format: z
            .enum(["text", "rich"])
            .optional()
            .describe("'rich' (default) requests an image when the answer is visual. Use 'text' to suppress images."),
          model: z
            .enum(["gemini-3.5-flash", "gpt-5.5"])
            .optional()
            .describe("Override the model exec-chat uses. Defaults to GPT 5.5."),
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
          return jsonText(lines.join("\n"));
        },
      ),
    ],
  });
}

/** Registry entry — gated on ATG_EXEC_SECRET so a missing env means skip. */
export function buildAtgExecIntegrationModule(): IntegrationModule {
  return {
    name: "atg-exec",
    description:
      "ATG Exec Chat — natural-language access to ATG's Chargebee / Shopify / finance sheets / PostHog data, with chart/map images.",
    requiredEnv: ["ATG_EXEC_SECRET"],
    createServer: async () => createAtgExecMcp(),
  };
}
