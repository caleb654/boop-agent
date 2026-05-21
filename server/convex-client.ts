import { ConvexHttpClient } from "convex/browser";

const url = process.env.CONVEX_URL ?? process.env.VITE_CONVEX_URL;
if (!url) {
  throw new Error(
    "Convex URL is not set. Run `npm run setup` or `npx convex dev` to configure VITE_CONVEX_URL.",
  );
}

const convexFetch: typeof globalThis.fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (response.ok) return response;

  const body = await response
    .clone()
    .text()
    .catch(() => "");
  if (body.trim()) return response;

  const detail = describeConvexRequest(input, init);
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  return new Response(`[convex] ${detail} failed with HTTP ${status}`, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

function describeConvexRequest(input: RequestInfo | URL, init?: RequestInit): string {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const rawUrl =
    typeof input === "string" || input instanceof URL ? String(input) : input.url;
  let endpoint = rawUrl;
  try {
    endpoint = new URL(rawUrl).pathname;
  } catch {
    // Keep the raw URL if it is not absolute.
  }

  const functionPath = parseConvexFunctionPath(init?.body);
  return `${method} ${endpoint}${functionPath ? ` (${functionPath})` : ""}`;
}

function parseConvexFunctionPath(body: BodyInit | null | undefined): string | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const parsed = JSON.parse(body) as { path?: unknown };
    return typeof parsed.path === "string" ? parsed.path : undefined;
  } catch {
    return undefined;
  }
}

export const convex = new ConvexHttpClient(url, { fetch: convexFetch });
