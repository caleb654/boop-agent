/**
 * CardTool integration (https://cardtool.app).
 *
 * Custom HTTP integration — NOT a Composio toolkit. CardTool isn't in
 * Composio's catalog yet, so we hand-roll an MCP server that wraps the REST
 * API and register it through the same `IntegrationModule` interface that
 * Composio toolkits use. From `spawn_agent`'s perspective the tools look
 * identical (`mcp__cardtool__get_credits`, …).
 *
 * Configuration:
 *   CARDTOOL_API_KEY   – Bearer token (e.g. ct_live_…). Required.
 *   CARDTOOL_BASE_URL  – Optional override. Defaults to https://cardtool.app/api/v1.
 *
 * Auth: every request sends `Authorization: Bearer ${CARDTOOL_API_KEY}` except
 * GET /offers, which is documented as public — we still send the header when
 * available since it's harmless and keeps the call path uniform.
 *
 * Note: CardTool also exposes an MCP server at https://cardtool.app/api/mcp,
 * but it requires Clerk OAuth (separate from this static API key). Wiring
 * Clerk OAuth into Boop's session model is out of scope for this integration —
 * follow up if/when there's user demand.
 */

import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { IntegrationModule } from "./registry.js";

const DEFAULT_BASE_URL = "https://cardtool.app/api/v1";

function getBaseUrl(): string {
  return (process.env.CARDTOOL_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
}

function getApiKey(): string | undefined {
  return process.env.CARDTOOL_API_KEY;
}

/** Low-level GET helper. Builds the URL, sends the bearer header, surfaces
 *  HTTP errors with their response body so the model can react sensibly.
 *  Returns parsed JSON. */
async function ctGet(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<unknown> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("[cardtool] CARDTOOL_API_KEY is not set");
  }
  const url = new URL(`${getBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[cardtool] GET ${url.pathname} failed ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

// ---- Typed wrappers (used by tools and importable from other modules) ----

export interface CardtoolListResponse<T = unknown> {
  object?: string;
  data: T[];
  [k: string]: unknown;
}

export async function getCredits(): Promise<CardtoolListResponse> {
  return ctGet("/credits") as Promise<CardtoolListResponse>;
}

export async function getWallet(): Promise<CardtoolListResponse> {
  return ctGet("/wallet") as Promise<CardtoolListResponse>;
}

export async function getPoints(): Promise<CardtoolListResponse> {
  return ctGet("/points") as Promise<CardtoolListResponse>;
}

export async function getUpcoming(): Promise<CardtoolListResponse> {
  return ctGet("/upcoming") as Promise<CardtoolListResponse>;
}

export async function getInventory(opts?: { include_used?: boolean }): Promise<CardtoolListResponse> {
  return ctGet("/inventory", { include_used: opts?.include_used }) as Promise<CardtoolListResponse>;
}

export async function getOffers(opts?: {
  sort?: string;
  issuer?: string;
  card_slug?: string;
  limit?: number;
}): Promise<CardtoolListResponse> {
  return ctGet("/offers", opts) as Promise<CardtoolListResponse>;
}

export async function compareCards(opts: {
  category: string;
  wallet_only?: boolean;
  limit?: number;
}): Promise<CardtoolListResponse> {
  return ctGet("/compare", opts) as Promise<CardtoolListResponse>;
}

export async function getCategories(): Promise<CardtoolListResponse> {
  return ctGet("/categories") as Promise<CardtoolListResponse>;
}

export async function getPayments(): Promise<CardtoolListResponse> {
  return ctGet("/payments") as Promise<CardtoolListResponse>;
}

export async function getCardCatalog(opts?: {
  slug?: string;
  issuer?: string;
  network?: string;
  active?: boolean;
}): Promise<CardtoolListResponse> {
  return ctGet("/cards/catalog", opts) as Promise<CardtoolListResponse>;
}

export async function getCardDetail(slug: string): Promise<unknown> {
  return ctGet(`/cards/catalog/${encodeURIComponent(slug)}`);
}

// ---- MCP server ----

/** Wrap a JSON value as an MCP text content block. */
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

function createCardtoolMcp(): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "cardtool",
    version: "0.1.0",
    tools: [
      tool(
        "get_credits",
        "List the user's credit-card statement credits with current usage (used / remaining count and value, current period dates). Use when the user asks about credits, perks, what's been used, or what's expiring on their cards.",
        {},
        async () => jsonText(await getCredits()),
      ),
      tool(
        "get_wallet",
        "List the cards in the user's wallet with earning rates, annual fees, and balances. Use when the user asks about their cards, fees, balances, or which cards they have.",
        {},
        async () => jsonText(await getWallet()),
      ),
      tool(
        "get_points",
        "List points / miles balances across the user's loyalty programs (e.g. Chase UR, Amex MR, airline miles, hotel points).",
        {},
        async () => jsonText(await getPoints()),
      ),
      tool(
        "get_upcoming",
        "List upcoming events: expiring credits, expiring points, annual-fee renewals, and upcoming card payments. Use when the user asks 'what's coming up' or 'what do I need to use'.",
        {},
        async () => jsonText(await getUpcoming()),
      ),
      tool(
        "get_inventory",
        "List inventory items the user holds — gift cards, free-night certificates, lounge visits, etc. Pass include_used=true to include redeemed items.",
        {
          include_used: z
            .boolean()
            .optional()
            .describe("Include items that have already been used / redeemed."),
        },
        async (args) => jsonText(await getInventory({ include_used: args.include_used })),
      ),
      tool(
        "get_offers",
        "List public credit-card offers (sign-up bonuses, intro APRs). Filterable by issuer, card_slug, or sorted (e.g. by bonus value). Public endpoint — no user data.",
        {
          sort: z.string().optional().describe("Sort key, e.g. 'bonus_value'."),
          issuer: z.string().optional().describe("Issuer slug, e.g. 'chase', 'amex'."),
          card_slug: z.string().optional().describe("Filter to a specific card slug."),
          limit: z.number().int().positive().optional().describe("Max results."),
        },
        async (args) => jsonText(await getOffers(args)),
      ),
      tool(
        "compare_cards",
        "Compare earning rates across cards for a spending category. Use when the user asks 'which card should I use for X'. Pass wallet_only=true to limit to cards in the user's wallet.",
        {
          category: z.string().describe("Spending category slug (see /v1/categories for valid values), e.g. 'dining', 'groceries'."),
          wallet_only: z.boolean().optional().describe("Restrict to cards already in the user's wallet."),
          limit: z.number().int().positive().optional(),
        },
        async (args) => jsonText(await compareCards(args)),
      ),
      tool(
        "get_categories",
        "List all spending categories used for rewards optimization (e.g. dining, travel, groceries, gas). Use this to discover valid category slugs before calling compare_cards.",
        {},
        async () => jsonText(await getCategories()),
      ),
      tool(
        "get_payments",
        "Get card payment settings: due dates, autopay configuration, minimum payments, and linked bank accounts. Use when the user asks about upcoming bills, autopay, or due dates.",
        {},
        async () => jsonText(await getPayments()),
      ),
      tool(
        "get_card_catalog",
        "Browse the full CardTool card catalog — earning rates, annual fees, currencies. Filter by issuer (e.g. 'chase'), network ('visa'/'mastercard'/'amex'), or card slug.",
        {
          slug: z.string().optional().describe("Filter to a specific card slug."),
          issuer: z.string().optional().describe("Filter by issuer name, e.g. 'chase', 'amex'."),
          network: z.enum(["visa", "mastercard", "amex"]).optional().describe("Filter by card network."),
          active: z.boolean().optional().describe("false = include inactive/discontinued cards. Default: true (active only)."),
        },
        async (args) => jsonText(await getCardCatalog(args)),
      ),
      tool(
        "get_card_detail",
        "Get full details for a single card by slug: all earning rules, spend multipliers, credits, and benefits. Use when the user asks about a specific card's perks or rewards structure.",
        {
          slug: z.string().describe("Card slug (e.g. 'chase-sapphire-preferred', 'amex-gold'). Use get_card_catalog to discover slugs."),
        },
        async (args) => jsonText(await getCardDetail(args.slug)),
      ),
    ],
  });
}

/** Build an IntegrationModule the registry can register. Mirrors the shape of
 *  `buildComposioIntegrationModule(slug)` so spawn_agent treats it the same. */
export function buildCardtoolIntegrationModule(): IntegrationModule {
  return {
    name: "cardtool",
    description: "CardTool — credit-card rewards, credits, points, and wallet (https://cardtool.app)",
    requiredEnv: ["CARDTOOL_API_KEY"],
    createServer: async () => createCardtoolMcp(),
  };
}
