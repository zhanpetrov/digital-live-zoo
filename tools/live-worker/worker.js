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
// Response: {"now": 3, "today": 12, "week": 38, "hours_week": 1.6, "countries_today": 5, "countries_week": 15,
//            "hourly": [0, 1, 4, …], "top": [{"id": "<video id>", "people": 4}, …], "at": "2026-10-22T10:00:00Z"}
//   now    = people with any event in the last 5 minutes (the page sends a heartbeat every 4 min)
//   today  = people since midnight Pacific time; week = last 7 days
//   hourly = people per hour for the last 24 hours, oldest first, the current hour last
//   top    = the 3 cams most people had on stage in the last 24 hours (YouTube video ids only)
// Answers are cached for 30 seconds, so PostHog sees at most 2 queries a minute
// however many people have the page open.

const ORIGINS = ["https://digitallivezoo.com", "https://www.digitallivezoo.com"];
const CACHE_SECONDS = 30;

const SQL = `
SELECT
  uniqIf(person_id, timestamp >= now() - INTERVAL 5 MINUTE) AS here_now,
  uniqIf(person_id, timestamp >= toStartOfDay(toTimeZone(now(), 'US/Pacific'))) AS today,
  uniq(person_id) AS week,
  round(sumIf(toFloat(properties.to_s) - toFloat(properties.from_s), event = 'stage_segment') / 3600, 1) AS hours_week,
  uniqIf(properties.$geoip_country_code, timestamp >= toStartOfDay(toTimeZone(now(), 'US/Pacific'))) AS countries_today,
  uniq(properties.$geoip_country_code) AS countries_week
FROM events
WHERE timestamp >= now() - INTERVAL 7 DAY
  AND properties.$host = 'digitallivezoo.com'
  AND coalesce(properties.$virt_is_bot, false) != true`;

const HOST = `properties.$host = 'digitallivezoo.com' AND coalesce(properties.$virt_is_bot, false) != true`;

const SQL_HOURLY = `
SELECT dateDiff('hour', toStartOfHour(timestamp), toStartOfHour(now())) AS ago, uniq(person_id) AS people
FROM events
WHERE timestamp >= toStartOfHour(now()) - INTERVAL 23 HOUR AND ${HOST}
GROUP BY ago`;

const SQL_TOP = `
SELECT properties.cam_id AS cam, uniq(person_id) AS people, count() AS plays
FROM events
WHERE timestamp >= now() - INTERVAL 24 HOUR AND event = 'cam_on_stage' AND ${HOST}
GROUP BY cam
ORDER BY people DESC, plays DESC
LIMIT 3`;

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
      const ask = async (query, name) => {
        const r = await fetch(`https://us.posthog.com/api/projects/${project}/query/`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.POSTHOG_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query: { kind: "HogQLQuery", query }, name }),
        });
        if (!r.ok) throw new Error(String(r.status));
        return (await r.json()).results || [];
      };
      let main;
      try { main = await ask(SQL, "zoo live widget"); } catch (e) { return json({ error: "analytics unavailable" }, 502, req); }
      // the chart and the top cams are extras: if either query fails the totals still go out
      const [hourlyRows, topRows] = await Promise.all([
        ask(SQL_HOURLY, "zoo live widget hourly").catch(() => []),
        ask(SQL_TOP, "zoo live widget top cams").catch(() => []),
      ]);
      const row = main[0] || [];
      const hourly = new Array(24).fill(0);
      for (const [ago, people] of hourlyRows) if (ago >= 0 && ago < 24) hourly[23 - ago] = +people || 0;
      const top = topRows.filter(r => /^[\w-]{11}$/.test(r[0] || "")).map(r => ({ id: r[0], people: +r[1] || 0 }));
      const body = {
        now: +row[0] || 0, today: +row[1] || 0, week: +row[2] || 0, hours_week: +row[3] || 0,
        countries_today: +row[4] || 0, countries_week: +row[5] || 0,
        hourly, top, at: new Date().toISOString(),
      };
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
