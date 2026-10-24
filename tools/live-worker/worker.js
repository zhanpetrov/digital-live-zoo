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
//
// Weather (GET /weather): current conditions and the next 6 hours for every camera place, from MET Norway
// (api.met.no, free incl. commercial use, credit "MET Norway" on the site). A Cron Trigger (every 2 minutes)
// refreshes up to 24 places per run, oldest first, so each place is re-fetched every 15 to 30 minutes; the
// results live in the Workers KV namespace bound as WX. Places come from https://digitallivezoo.com/data/geo.json,
// rounded to 2 decimals (about 1 km) so cams at the same place share one forecast.
//
// Answers are cached for 30 seconds, so PostHog sees at most 2 queries a minute
// however many people have the page open.

const GEO_URL = "https://digitallivezoo.com/data/geo.json";
const MET_URL = "https://api.met.no/weatherapi/locationforecast/2.0/compact";
const UA = "DigitalLiveZoo/1.0 (+https://digitallivezoo.com)";   // MET Norway requires a User-Agent that identifies the site
const WX_BATCH = 24, WX_MIN = 15 * 60000, WX_MAX = 30 * 60000, WX_CACHE_SECONDS = 120;

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
    if (new URL(req.url).pathname === "/weather") return weather(req, env, ctx);

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

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshWeather(env));
  },
};

const wxKey = (lat, lon) => (+lat).toFixed(2) + "," + (+lon).toFixed(2);

async function refreshWeather(env) {
  if (!env.WX) return;
  const g = await fetch(GEO_URL, { cf: { cacheTtl: 900 } });
  if (!g.ok) return;
  const geo = await g.json();
  const keys = [...new Set(Object.values(geo.places || {}).filter(p => typeof p.lat === "number").map(p => wxKey(p.lat, p.lon)))];
  const store = (await env.WX.get("wx", "json")) || { v: 1, w: {} };
  const live = new Set(keys);
  for (const k of Object.keys(store.w)) if (!live.has(k)) delete store.w[k];   // no cam there any more
  const now = Date.now();
  const due = keys.filter(k => !store.w[k] || now >= store.w[k].exp)
    .sort((a, b) => ((store.w[a] || {}).got || 0) - ((store.w[b] || {}).got || 0))
    .slice(0, WX_BATCH);
  if (!due.length) return;
  await Promise.all(due.map(async k => {
    try { store.w[k] = await met(k); }
    catch (e) { if (store.w[k]) store.w[k].exp = now + WX_MIN; }   // keep the old reading, try again later
  }));
  store.at = new Date().toISOString();
  await env.WX.put("wx", JSON.stringify(store));
}

async function met(k) {
  const [lat, lon] = k.split(",");
  const r = await fetch(`${MET_URL}?lat=${lat}&lon=${lon}`, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(String(r.status));
  const d = await r.json();
  const ts = (d.properties && d.properties.timeseries) || [];
  const hour = Date.now() - 3600000;
  const i0 = Math.max(0, ts.findIndex(t => Date.parse(t.time) > hour));
  const sym = t => ((t.data.next_1_hours || t.data.next_6_hours || {}).summary || {}).symbol_code || "";
  const cur = ts[i0];
  if (!cur) throw new Error("no data");
  const x = cur.data.instant.details;
  const now = Date.now(), expires = Date.parse(r.headers.get("expires") || "") || 0;
  return {
    t: x.air_temperature, s: sym(cur), ws: x.wind_speed, wd: x.wind_from_direction, h: x.relative_humidity,
    p: ((cur.data.next_1_hours || {}).details || {}).precipitation_amount ?? null,
    n: ts.slice(i0 + 1, i0 + 7).map(t => [t.time, t.data.instant.details.air_temperature, sym(t)]),
    got: now, exp: Math.min(now + WX_MAX, Math.max(now + WX_MIN, expires)),
  };
}

async function weather(req, env, ctx) {
  if (!env.WX) return json({ error: "not configured" }, 503, req);
  const cache = caches.default;
  const key = new Request(new URL("/weather.json", req.url).toString());
  let res = await cache.match(key);
  if (!res) {
    const store = (await env.WX.get("wx", "json")) || { w: {} };
    const w = {};
    for (const [k, v] of Object.entries(store.w || {})) w[k] = { t: v.t, s: v.s, ws: v.ws, wd: v.wd, h: v.h, p: v.p, n: v.n, got: v.got };
    res = new Response(JSON.stringify({ at: store.at || null, credit: "MET Norway", w }), {
      headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${WX_CACHE_SECONDS}` },
    });
    ctx.waitUntil(cache.put(key, res.clone()));
  }
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors(req))) out.headers.set(k, v);
  return out;
}

function json(obj, status, req) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors(req) } });
}
