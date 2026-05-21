/**
 * Weekly PostHog homepage traffic report.
 *
 * System handler: `posthog_weekly_report`
 *
 * Schedule: every Thursday in Eastern Time after the Wednesday reporting
 * window closes.
 *
 * On each run it:
 *   1. Snaps to the most recent Thursday 00:00 America/New_York.
 *   2. Queries PostHog for unique homepage visitors in the 7-day window
 *      [last-Thursday 00:00 ET, this-Thursday 00:00 ET).
 *   3. Texts Ferdinand Haag exactly: "<N> website visitors" — nothing else.
 */

import { getHomePageStats } from "./integrations/posthog.js";
import { sendLocalImessage } from "./local-imessage.js";

/** Ferdinand Haag's number. Override via POSTHOG_REPORT_TO env var if needed. */
const DEFAULT_RECIPIENT = "+17277713363";
const REPORT_TIMEZONE = "America/New_York";

/** Format a UTC midnight Date as a HogQL-compatible datetime string. */
function toHogQLDate(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${day} 00:00:00`;
}

function localDateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour") % 24,
    value("minute"),
    value("second"),
  );
  return asUtc - date.getTime();
}

function zonedMidnightToUtc(year: number, month: number, day: number, timeZone: string): Date {
  const utcGuess = Date.UTC(year, month - 1, day);
  let utc = utcGuess - timeZoneOffsetMs(new Date(utcGuess), timeZone);
  const corrected = utcGuess - timeZoneOffsetMs(new Date(utc), timeZone);
  if (corrected !== utc) utc = corrected;
  return new Date(utc);
}

export function weeklyHomepageWindow(now = new Date()): {
  start: Date;
  end: Date;
  timeZone: string;
} {
  const local = localDateParts(now, REPORT_TIMEZONE);
  const localMidnight = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const dow = localMidnight.getUTCDay();
  const daysBack = (dow - 4 + 7) % 7;
  const endLocal = new Date(localMidnight);
  endLocal.setUTCDate(endLocal.getUTCDate() - daysBack);
  const startLocal = new Date(endLocal);
  startLocal.setUTCDate(startLocal.getUTCDate() - 7);

  return {
    start: zonedMidnightToUtc(
      startLocal.getUTCFullYear(),
      startLocal.getUTCMonth() + 1,
      startLocal.getUTCDate(),
      REPORT_TIMEZONE,
    ),
    end: zonedMidnightToUtc(
      endLocal.getUTCFullYear(),
      endLocal.getUTCMonth() + 1,
      endLocal.getUTCDate(),
      REPORT_TIMEZONE,
    ),
    timeZone: REPORT_TIMEZONE,
  };
}

export async function runPosthogWeeklyReport(): Promise<{ result: string }> {
  const { start, end, timeZone } = weeklyHomepageWindow();

  const startStr = toHogQLDate(start);
  const endStr = toHogQLDate(end);

  console.log(`[posthog-report] querying window ${startStr} → ${endStr}`);

  const stats = await getHomePageStats(startStr, endStr);
  const { uniqueVisitors } = stats;

  const recipient = (process.env.POSTHOG_REPORT_TO ?? DEFAULT_RECIPIENT).trim();
  const message = `${uniqueVisitors} website visitors`;

  await sendLocalImessage(recipient, message);

  const summary = `Sent "${message}" to ${recipient} (window: ${startStr} → ${endStr} UTC, timezone: ${timeZone}, pageviews: ${stats.pageviews}, sessions: ${stats.sessions})`;
  console.log(`[posthog-report] ${summary}`);
  return { result: summary };
}
