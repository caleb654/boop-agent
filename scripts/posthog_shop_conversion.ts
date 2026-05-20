/**
 * Shop conversion rate report.
 *
 * Run: `npx tsx scripts/posthog_shop_conversion.ts`
 *
 * Phase 1: discovery — lists candidate checkout/purchase events in the window.
 * Phase 2: prints /shop unique visitors, unique converters, and conversion %.
 *
 * Override the conversion event with CONVERSION_EVENT=<name>.
 *
 * Window: most recent Thursday 00:00 UTC back 7 days (matches
 * scripts/posthog_weekly_visitors.ts).
 */

import fs from "node:fs";
import path from "node:path";

const PROJECT_ID = "35046";
const POSTHOG_HOST = "https://us.posthog.com";

function loadEnvLocal(): void {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) throw new Error(`.env.local not found at ${envPath}`);
  const text = fs.readFileSync(envPath, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

function mostRecentThursday(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = d.getUTCDay();
  const daysBack = (dow - 4 + 7) % 7;
  d.setUTCDate(d.getUTCDate() - daysBack);
  return d;
}

function fmtHogQL(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da} 00:00:00`;
}

async function runHogQL(query: string): Promise<unknown[][]> {
  const apiKey = process.env.POSTHOG_API_KEY;
  if (!apiKey) throw new Error("POSTHOG_API_KEY not set");
  const url = `${POSTHOG_HOST}/api/projects/${PROJECT_ID}/query/`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`posthog query failed ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { results?: unknown[][] };
  return data.results ?? [];
}

const COMPLETION_PRIORITY = [
  "Order Completed",
  "Purchase Completed",
  "Checkout Completed",
  "Payment Completed",
  "Order Placed",
  "Purchase",
  "order_completed",
  "purchase_completed",
  "checkout_completed",
  "payment_completed",
];

async function main(): Promise<void> {
  loadEnvLocal();

  const now = new Date();
  const end = mostRecentThursday(now);
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  const startStr = fmtHogQL(start);
  const endStr = fmtHogQL(end);

  console.log(`[shop-conv] window ${startStr} → ${endStr}`);

  // Phase 1: list all events matching purchase/order/checkout/payment vocabulary
  console.log("\n=== Candidate checkout/purchase events in window ===");
  const candidateRows = await runHogQL(`
SELECT event, count() AS n, count(DISTINCT person_id) AS uniq
FROM events
WHERE timestamp >= toDateTime('${startStr}')
  AND timestamp <  toDateTime('${endStr}')
  AND (
    positionCaseInsensitive(event, 'order')    > 0 OR
    positionCaseInsensitive(event, 'purchase') > 0 OR
    positionCaseInsensitive(event, 'checkout') > 0 OR
    positionCaseInsensitive(event, 'payment')  > 0 OR
    positionCaseInsensitive(event, 'complete') > 0
  )
GROUP BY event
ORDER BY n DESC
LIMIT 50
  `.trim());
  if (candidateRows.length === 0) {
    console.log("  (none found)");
  }
  for (const row of candidateRows) {
    const [evt, n, uniq] = row;
    console.log(`  ${String(evt).padEnd(40)}  count=${n}  unique_persons=${uniq}`);
  }

  // Phase 2: pick the conversion event
  const eventNames = new Set(candidateRows.map((r) => String(r[0])));
  const envOverride = process.env.CONVERSION_EVENT?.trim();
  let conversionEvent: string | undefined;
  if (envOverride) {
    conversionEvent = envOverride;
  } else {
    for (const name of COMPLETION_PRIORITY) {
      if (eventNames.has(name)) {
        conversionEvent = name;
        break;
      }
    }
    if (!conversionEvent) {
      // Fall back to anything containing "complet" (most reliable bottom-of-funnel marker),
      // else "order", else "purchase", else "checkout".
      const ordered = [...eventNames];
      conversionEvent =
        ordered.find((n) => /complet/i.test(n)) ??
        ordered.find((n) => /order/i.test(n)) ??
        ordered.find((n) => /purchase/i.test(n)) ??
        ordered.find((n) => /checkout/i.test(n));
    }
  }

  if (!conversionEvent) {
    console.log("\n[shop-conv] could not auto-detect a conversion event.");
    console.log("           Set CONVERSION_EVENT=<event_name> and re-run.");
    return;
  }
  console.log(`\n[shop-conv] using conversion event: '${conversionEvent}'`);

  // Phase 3: compute conversion rate
  const rows = await runHogQL(`
SELECT
  count(DISTINCT if(event = '$pageview' AND properties.$pathname = '/shop', person_id, NULL)) AS shop_visitors,
  count(DISTINCT if(event = '${conversionEvent.replace(/'/g, "''")}', person_id, NULL))      AS converters
FROM events
WHERE timestamp >= toDateTime('${startStr}')
  AND timestamp <  toDateTime('${endStr}')
  AND (event = '$pageview' OR event = '${conversionEvent.replace(/'/g, "''")}')
  `.trim());

  const shopVisitors = Number(rows[0]?.[0] ?? 0);
  const converters = Number(rows[0]?.[1] ?? 0);
  const rate = shopVisitors > 0 ? (converters / shopVisitors) * 100 : 0;

  console.log("\n=== Shop conversion (last 7 days) ===");
  console.log(`  /shop unique visitors:  ${shopVisitors}`);
  console.log(`  unique converters:      ${converters}  (event='${conversionEvent}')`);
  console.log(`  conversion rate:        ${rate.toFixed(2)}%`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
