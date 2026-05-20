/**
 * Shopify Admin API client.
 *
 * Credentials are read from environment variables:
 *   SHOPIFY_SHOP              – myshopify.com domain (e.g. atgbuddies.myshopify.com)
 *   SHOPIFY_ADMIN_API_TOKEN   – Admin API access token with `read_orders` scope
 *
 * Optional:
 *   SHOPIFY_ADMIN_API_VERSION – API version, defaults to `2025-01`
 */

function shop(): string {
  const s = process.env.SHOPIFY_SHOP;
  if (!s) throw new Error("[shopify] SHOPIFY_SHOP is not set");
  return s;
}

function token(): string {
  const t = process.env.SHOPIFY_ADMIN_API_TOKEN;
  if (!t) throw new Error("[shopify] SHOPIFY_ADMIN_API_TOKEN is not set");
  return t;
}

function apiVersion(): string {
  return process.env.SHOPIFY_ADMIN_API_VERSION ?? "2025-01";
}

/**
 * Count paid orders in a half-open time window [startISO, endISO).
 *
 * Uses the lightweight `/orders/count.json` endpoint so this stays a single
 * request regardless of order volume.
 */
export async function countPaidOrders(
  startISO: string,
  endISO: string,
): Promise<number> {
  const params = new URLSearchParams({
    status: "any",
    financial_status: "paid",
    created_at_min: startISO,
    created_at_max: endISO,
  });
  const url = `https://${shop()}/admin/api/${apiVersion()}/orders/count.json?${params.toString()}`;

  const res = await fetch(url, {
    headers: { "X-Shopify-Access-Token": token() },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[shopify] orders/count failed ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { count?: number };
  if (typeof data.count !== "number") {
    throw new Error(`[shopify] unexpected orders/count response: ${JSON.stringify(data)}`);
  }
  return data.count;
}

type ShopifyNoteAttribute = { name: string; value: string };
type ShopifyOrderRow = {
  id: number;
  source_name?: string | null;
  note_attributes?: ShopifyNoteAttribute[] | null;
};
type OrdersListResponse = { orders?: ShopifyOrderRow[] };

export type OrderSourceBreakdown = {
  website: number;
  app: number;
  other: number;
  total: number;
};

// Shopify sales channel ID shared by the Next.js storefront and the Flutter
// app (both use the same Storefront access token, so they appear under one
// channel). Pre-source-tag orders from this channel WITHOUT a
// `_posthog_distinct_id` attribute are almost certainly app purchases —
// the website always sets the distinct_id when the user has analytics on.
const SHARED_STOREFRONT_CHANNEL = "20073709569";

function classifyOrder(o: ShopifyOrderRow): "website" | "app" | "other" {
  const attrs = new Map<string, string>(
    (o.note_attributes ?? []).map((a) => [a.name, a.value]),
  );

  const explicit = attrs.get("_source");
  if (explicit === "mobile-app") return "app";
  if (explicit === "website") return "website";

  // Legacy classification for orders placed before the source-tag rollout.
  if (attrs.has("_posthog_distinct_id")) return "website";
  if (o.source_name === SHARED_STOREFRONT_CHANNEL) return "app";
  return "other";
}

/**
 * List all paid orders in a window and classify each by source.
 * Pages through the REST `/orders.json` endpoint (250 per page) and follows
 * the `Link: <…>; rel="next"` header for cursor pagination.
 */
export async function countPaidOrdersBySource(
  startISO: string,
  endISO: string,
): Promise<OrderSourceBreakdown> {
  const params = new URLSearchParams({
    status: "any",
    financial_status: "paid",
    created_at_min: startISO,
    created_at_max: endISO,
    limit: "250",
    fields: "id,source_name,note_attributes",
  });

  let url: string | null =
    `https://${shop()}/admin/api/${apiVersion()}/orders.json?${params.toString()}`;
  const breakdown: OrderSourceBreakdown = {
    website: 0,
    app: 0,
    other: 0,
    total: 0,
  };

  while (url) {
    const res: Response = await fetch(url, {
      headers: { "X-Shopify-Access-Token": token() },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`[shopify] orders.json failed ${res.status}: ${body}`);
    }

    const data = (await res.json()) as OrdersListResponse;
    for (const order of data.orders ?? []) {
      breakdown.total++;
      breakdown[classifyOrder(order)]++;
    }

    const linkHeader: string = res.headers.get("Link") ?? "";
    const match: RegExpMatchArray | null = linkHeader.match(
      /<([^>]+)>;\s*rel="next"/,
    );
    url = match ? match[1] : null;
  }

  return breakdown;
}
