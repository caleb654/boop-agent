import { describe, expect, it } from "vitest";
import { isClearConversationCommand } from "../server/interaction-agent.js";

describe("isClearConversationCommand", () => {
  it("matches only a standalone clear command", () => {
    expect(isClearConversationCommand("clear")).toBe(true);
    expect(isClearConversationCommand(" CLEAR ")).toBe(true);
    expect(isClearConversationCommand("clear context")).toBe(false);
    expect(isClearConversationCommand("please clear")).toBe(false);
    expect(isClearConversationCommand("clear?")).toBe(false);
  });
});
