#!/usr/bin/env node
/**
 * Headful Playwright demo: opens medium.com in a visible Chromium window,
 * scrolls past the trending feed, takes a screenshot, then idles so the
 * user can keep watching. Stop by killing the tmux session that launched it.
 *
 * Usage (typically launched from tmux so the window outlives the parent shell):
 *   tmux new-session -d -s boop-boop-agent-medium "node scripts/browse-medium.mjs"
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const SHOT_DIR = path.resolve(process.cwd(), "debug/screenshots");
const SHOT_PATH = path.join(SHOT_DIR, "medium-headful.png");

const browser = await chromium.launch({
  headless: false,
  slowMo: 500,
  args: ["--start-maximized"],
});
const ctx = await browser.newContext({ viewport: null });
const page = await ctx.newPage();

console.log("[browse-medium] navigating to https://medium.com");
await page.goto("https://medium.com", { waitUntil: "domcontentloaded", timeout: 45_000 });

// Give the JS-rendered feed a moment to populate, then scroll a bit so the
// trending stories scroll into view.
await page.waitForTimeout(2_000);
for (let i = 0; i < 4; i++) {
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(800);
}

await mkdir(SHOT_DIR, { recursive: true });
await page.screenshot({ path: SHOT_PATH, fullPage: false });
console.log(`[browse-medium] screenshot saved → ${SHOT_PATH}`);

// Try to follow the "Latest" / trending link if one is visible, just to make
// the browsing visibly active.
const latest = page.getByRole("link", { name: /latest|trending|for you/i }).first();
if (await latest.count()) {
  try {
    await latest.click({ timeout: 3_000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 });
    console.log(`[browse-medium] navigated to: ${page.url()}`);
  } catch (err) {
    console.log("[browse-medium] no clickable Latest link, staying on homepage");
  }
}

// Idle so the window stays visible. Kill via:
//   tmux kill-session -t boop-boop-agent-medium
console.log("[browse-medium] idling. kill the tmux session to close the browser.");
await new Promise(() => {});
