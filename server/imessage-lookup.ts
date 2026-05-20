import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface AttachmentMeta {
  filename: string;
  displayName: string;
  mimeType: string;
  isImage: boolean;
}

export interface ChatCandidate {
  id: number;
  identifier: string | null;
  contactName: string | null;
  name: string | null;
  displayName: string | null;
  service: string | null;
  isGroup: boolean;
  participants: string[];
  lastMessageAt: string | null;
}

export interface RecentImessage {
  guid: string;
  text: string | null;
  date: number;
  isFromMe: boolean;
  handle: string | null;
  chatId: number | null;
  attachments: AttachmentMeta[];
}

export interface ImessageLookupResult {
  query: string;
  chats: ChatCandidate[];
  messages: RecentImessage[];
  reader: "imsg" | "none";
}

function expandTilde(p: string | null): string | null {
  if (!p) return null;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function nonEmpty(s: unknown): string | null {
  return typeof s === "string" && s.trim() ? s.trim() : null;
}

function runImsg(args: string[], timeout = 10_000): string {
  return execFileSync("imsg", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    maxBuffer: 25 * 1024 * 1024,
  });
}

function parseJsonLines(raw: string): unknown[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

function normalizeHandle(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const variants = new Set<string>([trimmed.toLowerCase()]);
  const digits = trimmed.replace(/\D/g, "");
  if (digits) {
    variants.add(digits);
    if (digits.length === 10) variants.add(`+1${digits}`);
    if (digits.length === 11 && digits.startsWith("1")) variants.add(`+${digits}`);
  }
  return [...variants];
}

function chatFromRow(row: Record<string, unknown>): ChatCandidate | null {
  const id = Number(row.id);
  if (!Number.isFinite(id)) return null;
  return {
    id,
    identifier: nonEmpty(row.identifier),
    contactName: nonEmpty(row.contact_name) ?? nonEmpty(row.contactName),
    name: nonEmpty(row.name),
    displayName: nonEmpty(row.display_name) ?? nonEmpty(row.displayName),
    service: nonEmpty(row.service),
    isGroup: row.is_group === true || row.isGroup === true,
    participants: Array.isArray(row.participants)
      ? row.participants.map((p) => String(p)).filter(Boolean)
      : [],
    lastMessageAt: nonEmpty(row.last_message_at) ?? nonEmpty(row.lastMessageAt),
  };
}

function allChats(limit = 1000): ChatCandidate[] {
  const raw = runImsg(["chats", "--limit", String(limit), "--json"]);
  return parseJsonLines(raw)
    .map((row) => (row && typeof row === "object" ? chatFromRow(row as Record<string, unknown>) : null))
    .filter((chat): chat is ChatCandidate => Boolean(chat));
}

function chatLabel(chat: ChatCandidate): string {
  return (
    chat.contactName ??
    chat.displayName ??
    chat.name ??
    chat.identifier ??
    chat.participants.join(", ") ??
    `chat ${chat.id}`
  );
}

function chatMatches(chat: ChatCandidate, query: string): boolean {
  const q = query.toLowerCase();
  const qHandles = normalizeHandle(query);
  const textFields = [
    chat.contactName,
    chat.displayName,
    chat.name,
    chat.identifier,
    ...chat.participants,
  ]
    .filter(Boolean)
    .map((v) => String(v).toLowerCase());

  if (textFields.some((field) => field.includes(q))) return true;

  const chatHandles = [chat.identifier, ...chat.participants]
    .filter(Boolean)
    .flatMap((handle) => normalizeHandle(String(handle)));
  return qHandles.some((handle) => chatHandles.includes(handle));
}

function attachmentFromRow(att: Record<string, unknown>): AttachmentMeta | null {
  const rawPath =
    nonEmpty(att.path) ??
    nonEmpty(att.filename) ??
    nonEmpty(att.resolved_path) ??
    nonEmpty(att.resolvedPath) ??
    nonEmpty(att.converted_path) ??
    nonEmpty(att.convertedPath);
  const abs = expandTilde(rawPath);
  if (!abs || !fs.existsSync(abs)) return null;
  const mime =
    nonEmpty(att.mime_type) ??
    nonEmpty(att.mimeType) ??
    nonEmpty(att.converted_mime_type) ??
    nonEmpty(att.convertedMimeType) ??
    "application/octet-stream";
  return {
    filename: abs,
    displayName:
      nonEmpty(att.transfer_name) ??
      nonEmpty(att.transferName) ??
      nonEmpty(att.name) ??
      nonEmpty(att.display_name) ??
      nonEmpty(att.displayName) ??
      path.basename(abs),
    mimeType: mime,
    isImage: mime.startsWith("image/"),
  };
}

function messageFromRow(row: Record<string, unknown>): RecentImessage | null {
  const dateRaw = nonEmpty(row.created_at) ?? nonEmpty(row.createdAt);
  const date = dateRaw ? Date.parse(dateRaw) : NaN;
  const chatId = Number(row.chat_id ?? row.chatId);
  const attachments = Array.isArray(row.attachments)
    ? row.attachments
        .map((att) =>
          att && typeof att === "object" ? attachmentFromRow(att as Record<string, unknown>) : null,
        )
        .filter((att): att is AttachmentMeta => Boolean(att))
    : [];

  return {
    guid:
      nonEmpty(row.guid) ??
      `imsg:${Number.isFinite(chatId) ? chatId : "unknown"}:${nonEmpty(row.id) ?? randomUUID()}`,
    text: nonEmpty(row.text),
    date: Number.isFinite(date) ? date : 0,
    isFromMe: row.is_from_me === true || row.isFromMe === true,
    handle: nonEmpty(row.sender),
    chatId: Number.isFinite(chatId) ? chatId : null,
    attachments,
  };
}

function historyForChat(chatId: number, limit: number): RecentImessage[] {
  const raw = runImsg([
    "history",
    "--chat-id",
    String(chatId),
    "--limit",
    String(limit),
    "--attachments",
    "--convert-attachments",
    "--json",
  ]);
  return parseJsonLines(raw)
    .map((row) =>
      row && typeof row === "object" ? messageFromRow(row as Record<string, unknown>) : null,
    )
    .filter((msg): msg is RecentImessage => Boolean(msg))
    .filter((msg) => Boolean(msg.text?.trim()) || msg.attachments.length > 0);
}

export function readRecentImessagesFromContact(
  query: string,
  requestedLimit = 12,
): ImessageLookupResult {
  const cleanQuery = query.trim();
  if (!cleanQuery) return { query, chats: [], messages: [], reader: "none" };

  const limit = Math.min(Math.max(Math.floor(requestedLimit), 1), 40);
  const matches = allChats().filter((chat) => chatMatches(chat, cleanQuery)).slice(0, 8);

  const messages = matches
    .flatMap((chat) => historyForChat(chat.id, limit))
    .sort((a, b) => a.date - b.date)
    .slice(-limit);

  return {
    query: cleanQuery,
    chats: matches,
    messages,
    reader: "imsg",
  };
}

export function describeChatCandidate(chat: ChatCandidate): string {
  const participants = chat.participants.length ? ` participants=${chat.participants.join(",")}` : "";
  return `${chatLabel(chat)} (chat_id=${chat.id}${participants})`;
}
