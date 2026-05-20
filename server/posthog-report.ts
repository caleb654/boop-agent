/**
 * Weekly PostHog /shop page traffic report.
 *
 * System handler: `posthog_weekly_report`
 *
 * Schedule: every Thursday at 00:15 UTC ("15 0 * * 4").
 *
 * On each run it:
 *   1. Snaps to the most recent Thursday 00:00 UTC (in case cron fires off-day).
 *   2. Queries PostHog for unique /shop page visitors in the 7-day window
 *      [last-Thursday 00:00 UTC, this-Thursday 00:00 UTC).
 *   3. Texts Ferdinand Haag exactly: "<N> website visitors" — nothing else.
 */

import { getHomePageStats } from "./integrations/posthog.js";
import { sendLocalImessage } from "./local-imessage.js";

/** Ferdinand Haag's number. Override via POSTHOG_REPORT_TO env var if needed. */
const DEFAULT_RECIPIENT = "+17277713363";

/** Format a UTC midnight Date as a HogQL-compatible datetime string. */
function toHogQLDate(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${day} 00:00:00`;
}

/**
 * Return the most recent Thursday 00:00:00 UTC on or before `now`.
 * Day-of-week: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat.
 */
function mostRecentThursday(now: Date): Date {
  // Strip to UTC midnight
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = d.getUTCDay();
  const daysBack = (dow - 4 + 7) % 7; // 0 if today IS Thursday
  d.setUTCDate(d.getUTCDate() - daysBack);
  return d;
}

export async function runPosthogWeeklyReport(): Promise<{ result: string }> {
  const now = new Date();
  const end = mostRecentThursday(now);
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);

  const startStr = toHogQLDate(start);
  const endStr = toHogQLDate(end);

  console.log(`[posthog-report] querying window ${startStr} → ${endStr}`);

  const stats = await getHomePageStats(startStr, endStr);
  const { uniqueVisitors } = stats;

  const recipient = (process.env.POSTHOG_REPORT_TO ?? DEFAULT_RECIPIENT).trim();
  const message = `${uniqueVisitors} website visitors`;

  await sendLocalImessage(recipient, message);

  const summary = `Sent "${message}" to ${recipient} (window: ${startStr} → ${endStr}, pageviews: ${stats.pageviews}, sessions: ${stats.sessions})`;
  console.log(`[posthog-report] ${summary}`);
  return { result: summary };
}
