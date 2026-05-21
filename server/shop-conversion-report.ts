/**
 * Periodic store conversion-rate report, split by surface.
 *
 * System handler: `shop_conversion_report`
 *
 * Website denominator: PostHog unique `$pageview` persons where
 *   `$pathname == '/shop'` (the new-atg-website store landing).
 * App denominator: PostHog unique `$screen` persons where
 *   `screen_name == '/inventory'` (the Flutter client_app store tab).
 *
 * Numerator for each surface: Shopify paid orders classified by source.
 * Classification reads the `_source` cart attribute set by the website and
 * (once the app update ships) the Flutter app. For orders predating that
 * tagging, falls back to a heuristic: a `_posthog_distinct_id` attribute
 * indicates a website checkout; otherwise, orders on the shared storefront
 * sales channel are treated as app orders. Manual draft orders and orders
 * from unrelated channels land in `other` and are excluded from both rates.
 *
 * Window: last 7 UTC days, anchored to today's 00:00 UTC.
 *
 * Recipients: comma-separated phone numbers in SHOP_CONVERSION_REPORT_TO.
 * Falls back to BOOP_USER_PHONE if the explicit list is unset.
 */

import { getAppStoreScreenStats, getShopPageStats } from "./integrations/posthog.js";
import { countPaidOrdersBySource } from "./integrations/shopify.js";
import { sendLocalImessage } from "./local-imessage.js";

function toHogQLDate(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${day} 00:00:00`;
}

function toShopifyDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function rate(num: number, denom: number): string {
  if (denom <= 0) return "n/a";
  return ((num / denom) * 100).toFixed(2) + "%";
}

function resolveRecipients(): string[] {
  const list = (process.env.SHOP_CONVERSION_REPORT_TO ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length > 0) return list;
  const fallback = (process.env.BOOP_USER_PHONE ?? "").trim();
  return fallback ? [fallback] : [];
}

export async function runShopConversionReport(): Promise<{ result: string }> {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);

  const startHogQL = toHogQLDate(start);
  const endHogQL = toHogQLDate(end);
  const startIso = toShopifyDate(start);
  const endIso = toShopifyDate(end);

  console.log(
    `[shop-conversion-report] window ${startHogQL} → ${endHogQL}`,
  );

  const [webStats, appStats, orderSplit] = await Promise.all([
    getShopPageStats(startHogQL, endHogQL),
    getAppStoreScreenStats(startHogQL, endHogQL),
    countPaidOrdersBySource(startIso, endIso),
  ]);

  const webRate = rate(orderSplit.website, webStats.uniqueVisitors);
  const appRate = rate(orderSplit.app, appStats.uniqueVisitors);

  const message =
    `Store last 7d\n` +
    `\n` +
    `Website\n` +
    `${fmt(webStats.uniqueVisitors)} visitors · ${fmt(orderSplit.website)} orders · ${webRate}\n` +
    `\n` +
    `App\n` +
    `${fmt(appStats.uniqueVisitors)} visitors · ${fmt(orderSplit.app)} orders · ${appRate}`;

  const recipients = resolveRecipients();
  if (recipients.length === 0) {
    throw new Error(
      "[shop-conversion-report] no recipients configured (set SHOP_CONVERSION_REPORT_TO or BOOP_USER_PHONE)",
    );
  }

  const deliveries: Array<{ to: string; status: "ok" | "failed"; error?: string }> = [];
  for (const recipient of recipients) {
    try {
      await sendLocalImessage(recipient, message);
      deliveries.push({ to: recipient, status: "ok" });
    } catch (err) {
      deliveries.push({ to: recipient, status: "failed", error: String(err) });
      console.error(
        `[shop-conversion-report] send to ${recipient} failed:`,
        err,
      );
    }
  }

  const okCount = deliveries.filter((d) => d.status === "ok").length;
  const summary =
    `Sent store conversion report to ${okCount}/${deliveries.length} recipient(s) ` +
    `(window ${startHogQL} → ${endHogQL}, ` +
    `web: ${webStats.uniqueVisitors} visitors / ${orderSplit.website} orders / ${webRate}, ` +
    `app: ${appStats.uniqueVisitors} visitors / ${orderSplit.app} orders / ${appRate}, ` +
    `other orders: ${orderSplit.other}, total paid: ${orderSplit.total})`;
  console.log(`[shop-conversion-report] ${summary}`);
  return { result: summary };
}
