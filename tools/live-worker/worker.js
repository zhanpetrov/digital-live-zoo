// Digital Live Zoo — live visitor numbers for the home page.
//
// A Cloudflare Worker (free plan) that asks PostHog how many people are on the
// site right now and returns only those totals as JSON. The PostHog key stays
// here, as a Worker secret, and never reaches the browser.
//
// Settings (Cloudflare → Workers → this worker → Settings → Variables and secrets):
//   POSTHOG_API_KEY     secret. PostHog personal API key, scope "query:read" only.
//   POSTHOG_PROJECT_ID  optional, defaults to 641044 (the "Digital Live Zoo" project).
//
// Response: {"now": 3, "today": 12, "week": 38, "hours_week": 1.6, "at": "2026-10-22T10:00:00Z"}
//   now   = people with any event in the last 5 minutes (the page sends a heartbeat every 4 min)
//   today = people since midnight Pacific time; week = last 7 days
// Answers are cached for 30 seconds, so PostHog sees at most 2 queries a minute
// however many people have the page open.

const ORIGINS = ["https://digitallivezoo.com", "https://www.digitallivezoo.com"];
const CACHE_SECONDS = 30;

const SQL = `
SELECT
  uniqIf(person_id, timestamp >= now() - INTERVAL 5 MINUTE) AS here_now,
  uniqIf(person_id, timestamp >= toStartOfDay(toTimeZone(now(), 'US/Pacific'))) AS today,
  uniq(person_id) AS week,
  round(sumIf(toFloat(properties.to_s) - toFloat(properties.from_s), event = 'stage_segment') / 3600, 1) AS hours_week
FROM events
WHERE timestamp >= now() - INTERVAL 7 DAY
  AND properties.$host = 'digitallivezoo.com'
  AND coalesce(properties.$virt_is_bot, false) != true`;

function cors(req) {
  const o = req.headers.get("Origin");
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
  };
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });

    const cache = caches.default;
    const key = new Request(new URL("/live.json", req.url).toString());
    let res = await cache.match(key);

    if (!res) {
      if (!env.POSTHOG_API_KEY) return json({ error: "not configured" }, 503, req);
      const project = env.POSTHOG_PROJECT_ID || "641044";
      const r = await fetch(`https://us.posthog.com/api/projects/${project}/query/`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.POSTHOG_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: { kind: "HogQLQuery", query: SQL }, name: "zoo live widget" }),
      });
      if (!r.ok) return json({ error: "analytics unavailable" }, 502, req);
      const data = await r.json();
      const row = (data.results && data.results[0]) || [0, 0, 0, 0];
      const body = { now: +row[0] || 0, today: +row[1] || 0, week: +row[2] || 0, hours_week: +row[3] || 0, at: new Date().toISOString() };
      res = new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_SECONDS}` },
      });
      ctx.waitUntil(cache.put(key, res.clone()));
    }

    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors(req))) out.headers.set(k, v);
    return out;
  },
};

function json(obj, status, req) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors(req) } });
}
