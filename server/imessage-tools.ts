import { z } from "zod";
import {
  describeChatCandidate,
  readRecentImessagesFromContact,
  type ImessageLookupResult,
} from "./imessage-lookup.js";
import { createClaudeMcpServer } from "./runtimes/claude.js";
import { defineRuntimeTool } from "./runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "./runtimes/types.js";

const NAMESPACE = "boop-imessage";

function fmtWhen(ms: number): string {
  if (!ms) return "unknown time";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

function formatLookup(result: ImessageLookupResult): string {
  const header = [
    `Query: ${result.query}`,
    `Reader: ${result.reader}`,
    `Matched chats: ${result.chats.length}`,
  ];

  if (result.messages.length === 0) {
    const chatHints = result.chats
      .slice(0, 8)
      .map((chat) => `- ${describeChatCandidate(chat)}`)
      .join("\n");
    return [
      ...header,
      "",
      `No recent readable messages found for "${result.query}".`,
      chatHints ? `Possible chat matches:\n${chatHints}` : "No possible chat matches found.",
    ].join("\n");
  }

  const preferredChat = result.chats.find((chat) => !chat.isGroup) ?? result.chats[0];
  const preferredName =
    preferredChat?.contactName ??
    preferredChat?.displayName ??
    preferredChat?.name ??
    result.query;
  const lines = result.messages.map((msg) => {
    const speaker = msg.isFromMe ? "Me" : msg.handle ?? preferredName;
    const text = msg.text?.trim() || "(attachment)";
    const attachments =
      msg.attachments.length > 0
        ? ` Attachments: ${msg.attachments
            .map((att) => `${att.displayName} ${att.filename}`)
            .join("; ")}`
        : "";
    return `[${fmtWhen(msg.date)}] ${speaker}: ${text}${attachments}`;
  });

  return [...header, "", "Recent messages, oldest first:", ...lines].join("\n");
}

export function createImessageTools(): RuntimeTool[] {
  return [
      defineRuntimeTool(
        NAMESPACE,
        "recent_messages_from_contact",
        `Read the user's recent local iMessage/SMS history with a named contact. Use ONLY when the user explicitly asks to look at recent messages/texts/iMessages from someone, summarize what someone said, or inspect a named conversation. The contact can be a normal name like "Isaac"; the tool resolves names through the imsg CLI chat metadata and reads history through imsg.`,
        {
          contact: z
            .string()
            .describe('Name, phone number, email, or chat label to look up, e.g. "Isaac".'),
          limit: z
            .number()
            .optional()
            .describe("How many recent messages to return. Default 12, max 40."),
        },
        async (args) => {
          const result = readRecentImessagesFromContact(args.contact, args.limit ?? 12);
          return runtimeText(formatLookup(result));
        },
      ),
    ];
}

export function createImessageMcp() {
  return createClaudeMcpServer(NAMESPACE, createImessageTools());
}
