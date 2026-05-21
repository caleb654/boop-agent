/**
 * PostHog API client.
 *
 * Credentials are read from environment variables:
 *   POSTHOG_API_KEY      – personal API key (Bearer token)
 *   POSTHOG_PROJECT_ID   – numeric project ID (e.g. 35046)
 *   POSTHOG_HOST         – optional, defaults to https://us.posthog.com
 */

export interface PostHogQueryResponse {
  results: Array<Array<number | string | null>>;
  columns?: string[];
  types?: string[];
  timings?: unknown;
  next_allowed_client_refresh?: number;
}

/**
 * Execute a raw HogQL query against the configured PostHog project.
 * Throws on HTTP errors or missing credentials.
 */
export async function runHogQLQuery(hogql: string): Promise<PostHogQueryResponse> {
  const apiKey = process.env.POSTHOG_API_KEY;
  const projectId = process.env.POSTHOG_PROJECT_ID;
  const host = (process.env.POSTHOG_HOST?.trim() || "https://us.posthog.com").replace(/\/$/, "");

  if (!apiKey) throw new Error("[posthog] POSTHOG_API_KEY is not set");
  if (!projectId) throw new Error("[posthog] POSTHOG_PROJECT_ID is not set");

  const url = `${host}/api/projects/${projectId}/query/`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: {
        kind: "HogQLQuery",
        query: hogql,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[posthog] query failed ${res.status}: ${body}`);
  }

  return res.json() as Promise<PostHogQueryResponse>;
}

/**
 * Query unique homepage visitors on the website for a given UTC window.
 * Returns { uniqueVisitors, pageviews, sessions }.
 *
 * Excludes pageviews fired from inside the mobile app's embedded WebView.
 * Those events carry `source: "mobile-app"` as a super-property (set by
 * new-atg-website's PostHogProvider when the `embed=app` cookie is
 * present) — counting them here would double-count app traffic (the
 * same visitor already shows up via the `$screen /inventory` query).
 */
export async function getHomePageStats(
  startISO: string,
  endISO: string,
): Promise<{ uniqueVisitors: number; pageviews: number; sessions: number }> {
  const hogql = `
SELECT
  count()                                    AS pageviews,
  count(DISTINCT person_id)                  AS unique_visitors,
  count(DISTINCT properties.$session_id)     AS sessions
FROM events
WHERE event = '$pageview'
  AND properties.$pathname = '/'
  AND coalesce(properties.source, '') != 'mobile-app'
  AND timestamp >= toDateTime('${startISO}')
  AND timestamp <  toDateTime('${endISO}')
  `.trim();

  const data = await runHogQLQuery(hogql);
  const row = data.results?.[0];
  if (!row || row.length < 3) {
    throw new Error(`[posthog] unexpected result shape: ${JSON.stringify(data.results)}`);
  }

  return {
    pageviews: Number(row[0] ?? 0),
    uniqueVisitors: Number(row[1] ?? 0),
    sessions: Number(row[2] ?? 0),
  };
}

/**
 * Query unique visitors to the mobile app's store tab (`/inventory` screen)
 * for a given UTC window. The client app fires `$screen` events with
 * `properties.screen_name = "/inventory"` from its GoRouter listener.
 */
export async function getAppStoreScreenStats(
  startISO: string,
  endISO: string,
): Promise<{ uniqueVisitors: number; screenViews: number }> {
  const hogql = `
SELECT
  count()                       AS screen_views,
  count(DISTINCT person_id)     AS unique_visitors
FROM events
WHERE event = '$screen'
  AND properties.screen_name = '/inventory'
  AND timestamp >= toDateTime('${startISO}')
  AND timestamp <  toDateTime('${endISO}')
  `.trim();

  const data = await runHogQLQuery(hogql);
  const row = data.results?.[0];
  if (!row || row.length < 2) {
    throw new Error(`[posthog] unexpected result shape: ${JSON.stringify(data.results)}`);
  }

  return {
    screenViews: Number(row[0] ?? 0),
    uniqueVisitors: Number(row[1] ?? 0),
  };
}
