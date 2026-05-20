import express from "express";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { handleUserMessage } from "./interaction-agent.js";
import { broadcast } from "./broadcast.js";

const API_BASE = "https://api.sendblue.com/api";
const MAX_CHUNK = 2900;

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?|```/g, ""))
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/\[(.+?)\]\((.+?)\)/g, "$1 ($2)")
    .trim();
}

function chunk(text: string, size = MAX_CHUNK): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let buf = "";
  for (const line of text.split(/\n/)) {
    if ((buf + "\n" + line).length > size) {
      if (buf) out.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + "\n" + line : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function headers(): Record<string, string> | null {
  const apiKey = process.env.SENDBLUE_API_KEY;
  const apiSecret = process.env.SENDBLUE_API_SECRET;
  if (!apiKey || !apiSecret) return null;
  return {
    "Content-Type": "application/json",
    "sb-api-key-id": apiKey,
    "sb-api-secret-key": apiSecret,
  };
}

function normalizeE164(n: string | undefined): string | undefined {
  if (!n) return undefined;
  const trimmed = n.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("+")) return trimmed;
  // Bare US-length numbers get a +1. Longer/shorter just get a leading +.
  if (/^\d{10}$/.test(trimmed)) return `+1${trimmed}`;
  if (/^\d{11,15}$/.test(trimmed)) return `+${trimmed}`;
  return trimmed;
}

/**
 * Marker emitted by tools (currently atg-exec's ask_atg) that need to
 * attach an image alongside their text reply. Format:
 *   [ATG_IMAGE:/absolute/path/to.png]
 * The reply pipeline strips these markers and sends each image as media.
 */
const IMAGE_MARKER_RE = /\[ATG_IMAGE:([^\]\n]+)\]/g;

export interface ParsedReply {
  text: string;
  imagePaths: string[];
}

/** Pull `[ATG_IMAGE:/path.png]` markers out of `text` and return both the
 *  cleaned text and the list of image paths (preserved in order). */
export function extractImageMarkers(text: string): ParsedReply {
  const imagePaths: string[] = [];
  const cleaned = text.replace(IMAGE_MARKER_RE, (_, p1: string) => {
    const trimmed = p1.trim();
    if (trimmed) imagePaths.push(trimmed);
    return "";
  });
  return { text: cleaned.replace(/\n{3,}/g, "\n\n").trim(), imagePaths };
}

/**
 * Sends an iMessage with an attached media file. Sendblue's `/send-message`
 * endpoint accepts a `media_url` field; the image must be reachable from
 * Sendblue's servers, so we host it on boop's public webhook host (see
 * `mountAtgImageRoute()` below — registered in server/index.ts).
 *
 * If the file isn't reachable publicly, set ATG_IMAGE_BASE_URL to a tunnel
 * URL (ngrok / cloudflared) that maps to this server.
 */
export async function sendImessageWithMedia(
  toNumber: string,
  text: string,
  imagePath: string,
): Promise<void> {
  const h = headers();
  if (!h) {
    console.warn("[sendblue] missing credentials — not sending media");
    return;
  }
  const from = normalizeE164(process.env.SENDBLUE_FROM_NUMBER);
  if (!from) {
    console.error("[sendblue] SENDBLUE_FROM_NUMBER is not set; not sending media");
    return;
  }
  const baseUrl =
    process.env.ATG_IMAGE_BASE_URL ??
    process.env.PUBLIC_BASE_URL ??
    process.env.PUBLIC_URL;
  if (!baseUrl || baseUrl.includes("localhost")) {
    console.error(
      "[sendblue] No public base URL (ATG_IMAGE_BASE_URL / PUBLIC_BASE_URL / PUBLIC_URL) — Sendblue can't fetch images from localhost. Skipping image send.",
    );
    return;
  }
  // Map /tmp/atg-images/<uuid>.png → ${baseUrl}/atg-images/<uuid>.png
  const filename = imagePath.split("/").pop();
  if (!filename) return;
  const mediaUrl = `${baseUrl.replace(/\/$/, "")}/atg-images/${filename}`;
  const plain = stripMarkdown(text);
  const res = await fetch(`${API_BASE}/send-message`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      number: toNumber,
      from_number: from,
      content: plain.slice(0, MAX_CHUNK),
      media_url: mediaUrl,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[sendblue] media send failed ${res.status}: ${body}`);
    return;
  }
  console.log(`[sendblue] → sent image ${mediaUrl} to ${toNumber}`);
}

/** Express handler that serves /atg-images/<uuid>.png from the OS tmp dir.
 *  Mount via `app.use(mountAtgImageRoute())` in server/index.ts. Public so
 *  Sendblue can fetch the image; we trust the UUID-in-path as a soft secret
 *  (15-min TTL on the tmp file is enough). */
export function mountAtgImageRoute(): express.Router {
  const router = express.Router();
  router.get("/atg-images/:filename", async (req, res) => {
    const { filename } = req.params;
    if (!/^[a-f0-9-]+\.png$/i.test(filename)) {
      res.status(400).send("bad filename");
      return;
    }
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const filePath = join(tmpdir(), "atg-images", filename);
    res.sendFile(filePath, (err) => {
      if (err) {
        console.warn(`[atg-images] serve failed for ${filename}:`, err);
        if (!res.headersSent) res.status(404).send("not found");
      }
    });
  });
  return router;
}

export async function sendImessage(toNumber: string, text: string): Promise<void> {
  const h = headers();
  if (!h) {
    console.warn("[sendblue] missing credentials — not sending");
    return;
  }
  const from = normalizeE164(process.env.SENDBLUE_FROM_NUMBER);
  if (!from) {
    console.error(
      `[sendblue] SENDBLUE_FROM_NUMBER is not set. Run \`npm run sendblue:sync\` (pulls it from \`sendblue lines\`) or paste your provisioned number into .env.local, then restart \`npm run dev\`.`,
    );
    return;
  }
  const plain = stripMarkdown(text);
  const failures: string[] = [];
  for (const part of chunk(plain)) {
    const res = await fetch(`${API_BASE}/send-message`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ number: toNumber, content: part, from_number: from }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[sendblue] send failed ${res.status}: ${body}`);
      failures.push(`${res.status}: ${body}`);
      if (body.includes("missing required parameter") && body.includes("from_number")) {
        console.error(
          `[sendblue] → Set SENDBLUE_FROM_NUMBER in .env.local to your Sendblue-provisioned number and restart the server.`,
        );
      } else if (body.includes("Cannot send messages to self")) {
        console.error(
          `[sendblue] → SENDBLUE_FROM_NUMBER is your personal cell. It must be the Sendblue-provisioned number (the one people text TO).`,
        );
      } else if (body.includes("This phone number is not defined")) {
        console.error(
          `[sendblue] → Sendblue doesn't recognize from_number=${from}. Run \`npm run sendblue:sync\` to pull the correct one from \`sendblue lines\`, then restart the server.`,
        );
      }
    } else {
      console.log(`[sendblue] → sent ${part.length} chars to ${toNumber}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`[sendblue] failed to send to ${toNumber}: ${failures.join("; ")}`);
  }
}

export async function sendReadReceipt(toNumber: string): Promise<void> {
  const h = headers();
  if (!h) return;
  const from = normalizeE164(process.env.SENDBLUE_FROM_NUMBER);
  if (!from) return;
  try {
    const res = await fetch(`${API_BASE}/mark-read`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ number: toNumber, from_number: from }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[sendblue] read receipt failed ${res.status}: ${body}`);
    }
  } catch (err) {
    console.warn("[sendblue] read receipt error", err);
  }
}

export async function sendTypingIndicator(toNumber: string): Promise<void> {
  const h = headers();
  if (!h) return;
  const from = process.env.SENDBLUE_FROM_NUMBER;
  try {
    await fetch(`${API_BASE}/send-typing-indicator`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ number: toNumber, from_number: from }),
    });
  } catch {
    /* non-fatal */
  }
}

export function startTypingLoop(toNumber: string): () => void {
  sendTypingIndicator(toNumber);
  const timer = setInterval(() => sendTypingIndicator(toNumber), 5000);
  return () => clearInterval(timer);
}

export function createSendblueRouter(): express.Router {
  const router = express.Router();

  router.post("/webhook", async (req, res) => {
    const { content, from_number, is_outbound, message_handle } = req.body ?? {};
    if (is_outbound || !content || !from_number) {
      res.json({ ok: true, skipped: true });
      return;
    }

    if (message_handle) {
      const { claimed } = await convex.mutation(api.sendblueDedup.claim, {
        handle: message_handle,
      });
      if (!claimed) {
        res.json({ ok: true, deduped: true });
        return;
      }
    }

    const conversationId = `sms:${from_number}`;
    const turnTag = Math.random().toString(36).slice(2, 8);
    const preview = content.length > 100 ? content.slice(0, 100) + "…" : content;
    console.log(`[turn ${turnTag}] ← ${from_number}: ${JSON.stringify(preview)}`);
    const start = Date.now();

    broadcast("message_in", { conversationId, content, from_number, handle: message_handle });
    res.json({ ok: true });

    sendReadReceipt(from_number);
    const stopTyping = startTypingLoop(from_number);
    try {
      const reply = await handleUserMessage({
        conversationId,
        content,
        turnTag,
        onThinking: (t) => broadcast("thinking", { conversationId, t }),
      });
      if (reply) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        const replyPreview = reply.length > 100 ? reply.slice(0, 100) + "…" : reply;
        console.log(
          `[turn ${turnTag}] → reply (${elapsed}s, ${reply.length} chars): ${JSON.stringify(replyPreview)}`,
        );
        // The atg-exec tool injects `[ATG_IMAGE:/abs/path.png]` markers when
        // its answer should be visual. Pull them out before sending so the
        // user sees a clean reply, then attach each image as MMS.
        const parsed = extractImageMarkers(reply);
        if (parsed.imagePaths.length === 0) {
          await sendImessage(from_number, parsed.text);
        } else if (parsed.imagePaths.length === 1) {
          // Single image: bundle the text as the MMS caption.
          await sendImessageWithMedia(from_number, parsed.text || " ", parsed.imagePaths[0]);
        } else {
          // Multiple images: text first (if any), then each image alone.
          if (parsed.text) await sendImessage(from_number, parsed.text);
          for (const imagePath of parsed.imagePaths) {
            await sendImessageWithMedia(from_number, " ", imagePath);
          }
        }
        await convex.mutation(api.messages.send, {
          conversationId,
          role: "assistant",
          content: parsed.text,
        });
      } else {
        console.log(`[turn ${turnTag}] → (no reply)`);
      }
    } catch (err) {
      console.error(`[turn ${turnTag}] handler error`, err);
    } finally {
      stopTyping();
    }
  });

  return router;
}
