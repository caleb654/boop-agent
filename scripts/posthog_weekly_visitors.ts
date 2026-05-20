/**
 * Standalone weekly PostHog home-page visitor report.
 *
 * Run: `npx tsx scripts/posthog_weekly_visitors.ts`
 *
 * Reads POSTHOG_API_KEY from .env.local. Queries the most recent completed
 * Thu→Wed UTC week for COUNT(DISTINCT person_id) on $pageview '/shop'.
 * Sends the result via the local imsg CLI to the configured recipient.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROJECT_ID = "35046";
const POSTHOG_HOST = "https://us.posthog.com";
const RECIPIENT = "+16165282825";

function loadEnvLocal(): void {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env.local not found at ${envPath}`);
  }
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

/** Most recent Thursday 00:00:00 UTC on or before `now`. */
function mostRecentThursday(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = d.getUTCDay(); // 0=Sun..4=Thu..6=Sat
  const daysBack = (dow - 4 + 7) % 7;
  d.setUTCDate(d.getUTCDate() - daysBack);
  return d;
}

function fmtHogQL(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${y}-${mo}-${da} ${hh}:${mm}:${ss}`;
}

async function runHogQL(query: string): Promise<unknown[][]> {
  const apiKey = process.env.POSTHOG_API_KEY;
  if (!apiKey) throw new Error("POSTHOG_API_KEY not set (checked process.env after loading .env.local)");

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

function sendLocalImessage(to: string, body: string): void {
  execFileSync(
    "imsg",
    ["send", "--to", to, "--text", body, "--service", "imessage"],
    { stdio: "inherit" },
  );
}

async function main(): Promise<void> {
  loadEnvLocal();

  const now = new Date();
  const thisThursday = mostRecentThursday(now);
  // Window: [last Thu 00:00 UTC, this Thu 00:00 UTC) — equivalent to "last Thu
  // through this Wed 23:59:59".
  const start = new Date(thisThursday.getTime() - 7 * 24 * 60 * 60 * 1000);
  const end = thisThursday;

  const startStr = fmtHogQL(start);
  const endStr = fmtHogQL(end);

  const hogql = `
SELECT count(DISTINCT person_id) AS unique_visitors
FROM events
WHERE event = '$pageview'
  AND properties.$pathname = '/shop'
  AND timestamp >= toDateTime('${startStr}')
  AND timestamp <  toDateTime('${endStr}')
  `.trim();

  console.log(`[posthog-weekly] window ${startStr} → ${endStr}`);
  const rows = await runHogQL(hogql);
  const uniqueVisitors = Number(rows[0]?.[0] ?? 0);

  const message = `${uniqueVisitors} website visitors`;
  console.log(`[posthog-weekly] result: ${message}`);

  sendLocalImessage(RECIPIENT, message);
  console.log(`[posthog-weekly] sent to ${RECIPIENT}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
