import { describe, expect, it } from "vitest";
import {
  resolvePosthogReportRecipient,
  weeklyHomepageWindow,
} from "../server/posthog-report.js";

describe("weeklyHomepageWindow", () => {
  it("uses Thursday-through-Wednesday Eastern calendar days during daylight saving time", () => {
    const window = weeklyHomepageWindow(new Date("2026-05-21T17:00:00.000Z"));

    expect(window.timeZone).toBe("America/New_York");
    expect(window.start.toISOString()).toBe("2026-05-14T04:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-05-21T04:00:00.000Z");
  });

  it("uses the correct Eastern offset outside daylight saving time", () => {
    const window = weeklyHomepageWindow(new Date("2026-01-08T17:00:00.000Z"));

    expect(window.start.toISOString()).toBe("2026-01-01T05:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-01-08T05:00:00.000Z");
  });
});

describe("resolvePosthogReportRecipient", () => {
  it("falls back to Ferdinand when POSTHOG_REPORT_TO is blank", () => {
    const original = process.env.POSTHOG_REPORT_TO;
    process.env.POSTHOG_REPORT_TO = "  ";
    try {
      expect(resolvePosthogReportRecipient()).toBe("+17277713363");
    } finally {
      if (original === undefined) {
        delete process.env.POSTHOG_REPORT_TO;
      } else {
        process.env.POSTHOG_REPORT_TO = original;
      }
    }
  });
});
