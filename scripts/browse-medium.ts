/**
 * Headed Playwright demo: opens a visible Chromium window, browses Medium's
 * homepage, scrapes the top ~10 article cards, prints them, then idles ~15s
 * so you can watch.
 *
 * Run: `npx tsx scripts/browse-medium.ts`
 */

import { chromium } from "playwright";

const HOLD_MS = 15_000;
// Medium's root gates the feed when logged out. The /tag/* pages are public
// and render real article cards. Override via MEDIUM_URL env var.
const TARGET_URL = process.env.MEDIUM_URL ?? "https://medium.com/tag/programming";

interface Article {
  title: string;
  author: string | null;
  url: string;
}

async function main() {
  console.log("[browse-medium] launching headed Chromium…");
  const browser = await chromium.launch({
    headless: false,
    slowMo: 500,
  });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await ctx.newPage();

  console.log(`[browse-medium] navigating to ${TARGET_URL}`);
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // Medium's homepage has a few possible layouts depending on auth state /
  // experiments. Wait for ANY <article> to render, then scroll a bit to
  // trigger lazy-loaded cards.
  try {
    await page.waitForSelector("article", { timeout: 15_000 });
  } catch {
    console.warn("[browse-medium] no <article> within 15s — continuing anyway");
  }
  await page.evaluate(() => window.scrollBy(0, 800));
  await page.waitForTimeout(1_500);

  const articles: Article[] = await page.evaluate(() => {
    const seen = new Set<string>();
    const out: { title: string; author: string | null; url: string }[] = [];
    const cards = Array.from(document.querySelectorAll("article")).slice(0, 30);
    for (const card of cards) {
      // Title is usually the first h2/h3 inside the card.
      const titleEl = card.querySelector("h1, h2, h3");
      const title = titleEl?.textContent?.trim();
      if (!title) continue;

      // Pick the first link that looks like a story (skip /tag, /m/, etc.).
      const link = Array.from(card.querySelectorAll("a")).find((a) => {
        const href = a.getAttribute("href") ?? "";
        return /\/[^/]+\/[^/?#]+/.test(href) && !href.startsWith("/m/") && !href.startsWith("/tag");
      });
      const href = link?.getAttribute("href") ?? "";
      const url = href.startsWith("http") ? href : `https://medium.com${href}`;
      if (seen.has(url)) continue;
      seen.add(url);

      // Author: look for a link whose href starts with /@.
      const authorEl = Array.from(card.querySelectorAll("a")).find((a) =>
        (a.getAttribute("href") ?? "").startsWith("/@"),
      );
      const author = authorEl?.textContent?.trim() || null;

      out.push({ title, author, url });
      if (out.length >= 10) break;
    }
    return out;
  });

  console.log(`\n=== Top ${articles.length} Medium articles ===`);
  articles.forEach((a, i) => {
    console.log(`\n${i + 1}. ${a.title}`);
    if (a.author) console.log(`   by ${a.author}`);
    console.log(`   ${a.url}`);
  });
  if (articles.length === 0) {
    console.log("(no article cards parsed — Medium may be showing a logged-out gate)");
  }

  console.log(`\n[browse-medium] holding window open for ${HOLD_MS / 1000}s…`);
  await page.waitForTimeout(HOLD_MS);

  await browser.close();
  console.log("[browse-medium] done.");
}

main().catch((err) => {
  console.error("[browse-medium] FAILED:", err);
  process.exit(1);
});
