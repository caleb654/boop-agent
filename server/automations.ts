import { Cron } from "croner";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { spawnExecutionAgent } from "./execution-agent.js";
import { sendLocalImessage } from "./local-imessage.js";
import { broadcast } from "./broadcast.js";
import { getUserTimezone } from "./timezone-config.js";
import { runPosthogWeeklyReport } from "./posthog-report.js";
import { runShopConversionReport } from "./shop-conversion-report.js";
import { runFlightPriceWatch } from "./flight-price-watch.js";
import { formatError } from "./error-format.js";

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Registry of system-handler implementations. An automation row with
// kind="system" looks up its handler here by `systemHandler` name. Returning
// a result string lets the run log capture what happened, just like task
// automations capture the sub-agent's output.
const SYSTEM_HANDLERS: Record<
  string,
  () => Promise<{ result: string }>
> = {
  posthog_weekly_report: runPosthogWeeklyReport,
  shop_conversion_report: runShopConversionReport,
  flight_price_watch: runFlightPriceWatch,
};

function automationError(err: unknown): string {
  const formatted = formatError(err).trim();
  if (formatted) return formatted;
  if (err instanceof Error) return err.name || "Error";
  return String(err);
}

// When a timezone is present, croner evaluates the expression in that zone.
// Without it, croner falls back to the host zone.
export function nextRunFor(schedule: string, timezone?: string): number | null {
  try {
    const c = new Cron(schedule, { paused: true, ...(timezone ? { timezone } : {}) });
    const next = c.nextRun();
    return next ? next.getTime() : null;
  } catch {
    return null;
  }
}

export function nextRunAfter(schedule: string, afterMs: number, timezone?: string): number | null {
  try {
    const c = new Cron(schedule, { paused: true, ...(timezone ? { timezone } : {}) });
    const next = c.nextRun(new Date(afterMs + 1000));
    return next ? next.getTime() : null;
  } catch {
    return null;
  }
}

export function validateSchedule(
  schedule: string,
  timezone?: string,
): { valid: boolean; error?: string } {
  try {
    new Cron(schedule, { paused: true, ...(timezone ? { timezone } : {}) }).nextRun();
    return { valid: true };
  } catch (err) {
    return { valid: false, error: String(err) };
  }
}

async function runAutomation(a: {
  automationId: string;
  name: string;
  task: string;
  integrations: string[];
  schedule: string;
  timezone?: string;
  conversationId?: string;
  notifyConversationId?: string;
  kind?: "task" | "system";
  systemHandler?: string;
}): Promise<void> {
  const runId = randomId("run");
  await convex.mutation(api.automations.createRun, {
    runId,
    automationId: a.automationId,
  });
  broadcast("automation_started", { automationId: a.automationId, runId, name: a.name });

  try {
    if (a.kind === "system") {
      const handler = a.systemHandler ? SYSTEM_HANDLERS[a.systemHandler] : undefined;
      if (!handler) {
        throw new Error(`No registered system handler: ${a.systemHandler ?? "(undefined)"}`);
      }
      const res = await handler();
      await convex.mutation(api.automations.updateRun, {
        runId,
        status: "completed",
        result: res.result,
      });
      // System handlers handle their own user-facing notifications (via the
      // proposal flow inside the handler). We don't auto-pipe their result
      // string into iMessage — that's just for the run log.
    } else {
      const res = await spawnExecutionAgent({
        task: `AUTOMATION "${a.name}": ${a.task}`,
        integrations: a.integrations,
        conversationId: a.conversationId,
        name: `auto:${a.name}`,
      });
      await convex.mutation(api.automations.updateRun, {
        runId,
        status: res.status === "completed" ? "completed" : "failed",
        result: res.result,
        agentId: res.agentId,
      });

      if (a.notifyConversationId && res.result) {
        if (a.notifyConversationId.startsWith("sms:")) {
          const number = a.notifyConversationId.slice(4);
          const preamble = `[${a.name}]\n\n`;
          await sendLocalImessage(number, preamble + res.result);
        }
        await convex.mutation(api.messages.send, {
          conversationId: a.notifyConversationId,
          role: "assistant",
          content: `[${a.name}]\n\n${res.result}`,
        });
      }
    }

    broadcast("automation_completed", { automationId: a.automationId, runId });
  } catch (err) {
    await convex.mutation(api.automations.updateRun, {
      runId,
      status: "failed",
      error: String(err),
    });
    broadcast("automation_failed", { automationId: a.automationId, runId, error: String(err) });
  }

  // Pre-TZ automations have no stored timezone — fall back to whatever the
  // user's current setting is so they don't keep firing in the host zone.
  const tz = a.timezone ?? (await getUserTimezone());
  const next = nextRunFor(a.schedule, tz);
  await convex.mutation(api.automations.markRan, {
    automationId: a.automationId,
    lastRunAt: Date.now(),
    nextRunAt: next ?? undefined,
  });
}

/**
 * Manually trigger an automation regardless of its `nextRunAt`. Used by the
 * "Run now" button in the dashboard. Fire-and-forget at the call site (the
 * runner is async and writes its result to automationRuns).
 *
 * Returns false if the automation doesn't exist; true if the run was kicked
 * off (the run itself may still fail, surfaced via the run record).
 */
export async function triggerAutomation(automationId: string): Promise<boolean> {
  const a = await convex.query(api.automations.get, { automationId });
  if (!a) return false;
  runAutomation({
    automationId: a.automationId,
    name: a.name,
    task: a.task,
    integrations: a.integrations,
    schedule: a.schedule,
    timezone: a.timezone,
    conversationId: a.conversationId,
    notifyConversationId: a.notifyConversationId,
    kind: a.kind,
    systemHandler: a.systemHandler,
  }).catch((err) => console.error("[automations] manual run error", err));
  return true;
}

export async function skipNextAutomationRun(automationId: string): Promise<{
  ok: boolean;
  nextRunAt?: number;
  error?: string;
}> {
  const a = await convex.query(api.automations.get, { automationId });
  if (!a) return { ok: false, error: "automation not found" };
  const tz = a.timezone ?? (await getUserTimezone());
  const anchor = a.nextRunAt ?? Date.now();
  const next = nextRunAfter(a.schedule, anchor, tz);
  if (!next) return { ok: false, error: "could not compute next run" };
  await convex.mutation(api.automations.setNextRun, {
    automationId: a.automationId,
    nextRunAt: next,
  });
  broadcast("automation_skipped", { automationId: a.automationId, nextRunAt: next });
  return { ok: true, nextRunAt: next };
}

export async function tickAutomations(): Promise<void> {
  const all = await convex
    .query(api.automations.list, { enabledOnly: true })
    .catch((err) => {
      throw new Error(`list enabled automations failed: ${automationError(err)}`);
    });
  const now = Date.now();
  const due = all.filter((a) => a.nextRunAt !== undefined && a.nextRunAt <= now);
  for (const a of due) {
    // fire-and-forget so one slow automation doesn't block others
    runAutomation({
      automationId: a.automationId,
      name: a.name,
      task: a.task,
      integrations: a.integrations,
      schedule: a.schedule,
      timezone: a.timezone,
      conversationId: a.conversationId,
      notifyConversationId: a.notifyConversationId,
      kind: a.kind,
      systemHandler: a.systemHandler,
    }).catch((err) => console.error("[automations] run error", err));
  }
}

const POSTHOG_REPORT_AUTOMATION_ID = "system_posthog_weekly_report";

/**
 * Idempotent bootstrap: ensure the PostHog weekly report automation row exists.
 * Fires every Thursday at 00:15 UTC. Safe to call repeatedly on startup.
 */
export async function bootstrapPosthogWeeklyReport(): Promise<void> {
  if (process.env.BOOP_POSTHOG_SYSTEM_AUTOMATION_ENABLED !== "true") {
    console.log("[automations] PostHog system report bootstrap skipped");
    return;
  }
  // Weekly: Thursday at 00:15 UTC. In cron notation: min hour dom month dow
  // dow 4 = Thursday (0=Sun … 6=Sat).
  const schedule = "15 0 * * 4";
  const next = nextRunFor(schedule) ?? undefined;
  await convex.mutation(api.automations.upsertSystem, {
    automationId: POSTHOG_REPORT_AUTOMATION_ID,
    name: "PostHog: weekly homepage visitors → Ferdinand",
    schedule,
    systemHandler: "posthog_weekly_report",
    nextRunAt: next,
  });
  const nextStr = next ? new Date(next).toLocaleString() : "unknown";
  console.log(
    `[automations] PostHog weekly report bootstrapped (schedule "${schedule}", next: ${nextStr})`,
  );
}

const SHOP_CONVERSION_AUTOMATION_ID = "system_shop_conversion_report";
const SHOP_CONVERSION_TIMEZONE = "America/New_York";

/**
 * Idempotent bootstrap: ensure the store conversion-rate automation row
 * exists. Fires every Friday at 9:00 Eastern Time. Safe to call repeatedly
 * on startup.
 */
export async function bootstrapShopConversionReport(): Promise<void> {
  // Cron: minute hour dom month dow. dow 5 = Friday.
  const schedule = "0 9 * * 5";
  const next = nextRunFor(schedule, SHOP_CONVERSION_TIMEZONE) ?? undefined;
  await convex.mutation(api.automations.upsertSystem, {
    automationId: SHOP_CONVERSION_AUTOMATION_ID,
    name: "Store conversion: weekly App + Website visitors + Shopify orders",
    schedule,
    systemHandler: "shop_conversion_report",
    timezone: SHOP_CONVERSION_TIMEZONE,
    nextRunAt: next,
  });
  const nextStr = next ? new Date(next).toLocaleString() : "unknown";
  console.log(
    `[automations] store conversion report bootstrapped (schedule "${schedule}" ${SHOP_CONVERSION_TIMEZONE}, next: ${nextStr})`,
  );
}

const FLIGHT_PRICE_WATCH_AUTOMATION_ID = "system_flight_price_watch";
const FLIGHT_PRICE_WATCH_TIMEZONE = process.env.FLIGHT_PRICE_WATCH_TIMEZONE ?? "America/New_York";

/**
 * Idempotent bootstrap for recurring flight fare checks. Disabled unless
 * FLIGHT_PRICE_WATCH_ENABLED=true so an empty watch config cannot create a
 * noisy scheduled job.
 */
export async function bootstrapFlightPriceWatch(): Promise<void> {
  if (process.env.FLIGHT_PRICE_WATCH_ENABLED !== "true") {
    console.log("[automations] flight price watch bootstrap skipped");
    return;
  }
  const schedule = process.env.FLIGHT_PRICE_WATCH_SCHEDULE ?? "0 9 * * *";
  const next = nextRunFor(schedule, FLIGHT_PRICE_WATCH_TIMEZONE) ?? undefined;
  await convex.mutation(api.automations.upsertSystem, {
    automationId: FLIGHT_PRICE_WATCH_AUTOMATION_ID,
    name: "Flight prices: fli fare watch",
    schedule,
    systemHandler: "flight_price_watch",
    timezone: FLIGHT_PRICE_WATCH_TIMEZONE,
    nextRunAt: next,
  });
  const nextStr = next ? new Date(next).toLocaleString() : "unknown";
  console.log(
    `[automations] flight price watch bootstrapped (schedule "${schedule}" ${FLIGHT_PRICE_WATCH_TIMEZONE}, next: ${nextStr})`,
  );
}

export function startAutomationLoop(intervalMs = 30_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    tickAutomations()
      .catch((err) => console.error(`[automations] tick error: ${automationError(err)}`))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  return () => clearInterval(timer);
}
