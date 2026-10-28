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
// Answers are cached for 60 seconds, so PostHog sees at most one round of queries a minute
// however many people have the page open.

const GEO_URL = "https://digitallivezoo.com/data/geo.json";
const MET_URL = "https://api.met.no/weatherapi/locationforecast/2.0/compact";
const UA = "DigitalLiveZoo/1.0 (+https://digitallivezoo.com)";   // MET Norway requires a User-Agent that identifies the site
const WX_BATCH = 24, WX_MIN = 15 * 60000, WX_MAX = 30 * 60000, WX_CACHE_SECONDS = 120;

const ORIGINS = ["https://digitallivezoo.com", "https://www.digitallivezoo.com"];
const CACHE_SECONDS = 60;

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
    const path = new URL(req.url).pathname;
    if (path === "/weather") return weather(req, env, ctx);
    if (path === "/chat") return joinChat(req, env);

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
      // when PostHog does not answer, hand out the last good numbers (kept an hour) instead of an error
      const lastKey = new Request(new URL("/live-last.json", req.url).toString());
      let main;
      try { main = await ask(SQL, "zoo live widget"); }
      catch (e) {
        const last = await cache.match(lastKey);
        if (!last) return json({ error: "analytics unavailable" }, 502, req);
        const out = new Response(last.body, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
        for (const [k, v] of Object.entries(cors(req))) out.headers.set(k, v);
        return out;
      }
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
      ctx.waitUntil(cache.put(lastKey, new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" } })));
    }

    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors(req))) out.headers.set(k, v);
    return out;
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshWeather(env));
    ctx.waitUntil(dispatchActivity(env, event.scheduledTime));
  },
};

// GitHub drops most scheduled runs of activity.yml (it ran every 2-5 hours instead of every 30 minutes),
// so this cron starts it instead. Needs the GH_DISPATCH_TOKEN secret: a fine-grained token for the
// digital-live-zoo repo with "Actions: Read and write". ACTIVITY_EVERY_MIN sets the pace (default 30).
const ACTIVITY_DISPATCH = "https://api.github.com/repos/zhanpetrov/digital-live-zoo/actions/workflows/activity.yml/dispatches";

async function dispatchActivity(env, now) {
  if (!env.GH_DISPATCH_TOKEN || !env.WX) return;
  const every = (+env.ACTIVITY_EVERY_MIN || 30) * 60000;
  const last = +(await env.WX.get("activity_dispatch")) || 0;
  if (now - last < every - 90000) return;          // a cron tick may run a little early or late
  const r = await fetch(ACTIVITY_DISPATCH, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.GH_DISPATCH_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "zoo-live-worker",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  await env.WX.put("activity_dispatch", String(r.status === 204 ? now : last));
  if (r.status !== 204) console.log("activity dispatch failed", r.status, await r.text());
}

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

// ---------- Zoo Chat: one public room for everyone on the site (GET /chat, WebSocket) ----------
// The page opens a WebSocket here after a Cloudflare Turnstile check. One Durable Object ("main") holds the room.
// Kept: the last 50 messages for at most 24 hours, and 24-hour mutes. Nothing else. People are not accounts:
// each gets a random animal name, and abuse controls key on a hash of the IP address salted with the date,
// so the hash changes every day and the IP itself is never stored.
// Settings: TURNSTILE_SECRET (secret, required), CHAT_OFF = "1" closes the room (kill switch),
// CHAT_DEV_ORIGINS (optional, comma-separated extra origins for local testing).
const CHAT = {
  KEEP: 50, KEEP_MS: 24 * 3600e3, MAX_LEN: 200,
  GAP_MS: 3000, BURST: 5, BURST_MS: 30000,     // at most one message per 3 s and 5 per 30 s
  PER_IP: 3, MAX_CONN: 500,                     // tabs per person, people in the room
  REPORTS: 3, MUTE_MS: 24 * 3600e3,             // reports from different people that hide a message and mute its author
};
const ADJ = ["Sleepy", "Curious", "Brave", "Fluffy", "Sneaky", "Happy", "Gentle", "Speedy", "Wise", "Cheeky",
  "Jolly", "Shy", "Mighty", "Tiny", "Dreamy", "Bouncy", "Clever", "Sunny", "Misty", "Wild"];
const ANIMALS = [["Otter", "🦦"], ["Panda", "🐼"], ["Fox", "🦊"], ["Owl", "🦉"], ["Penguin", "🐧"], ["Koala", "🐨"],
  ["Tiger", "🐯"], ["Elephant", "🐘"], ["Giraffe", "🦒"], ["Zebra", "🦓"], ["Sloth", "🦥"], ["Flamingo", "🦩"],
  ["Hedgehog", "🦔"], ["Seal", "🦭"], ["Bear", "🐻"], ["Lion", "🦁"], ["Turtle", "🐢"], ["Dolphin", "🐬"],
  ["Raccoon", "🦝"], ["Beaver", "🦫"]];
const NAMES = ADJ.length * ANIMALS.length;

async function joinChat(req, env) {
  if (env.CHAT_OFF === "1") return new Response("chat closed", { status: 503 });
  if (req.headers.get("Upgrade") !== "websocket") return new Response("expected a WebSocket", { status: 426 });
  const origins = ORIGINS.concat((env.CHAT_DEV_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean));
  if (!origins.includes(req.headers.get("Origin"))) return new Response("forbidden", { status: 403 });
  if (!env.TURNSTILE_SECRET || !env.CHAT) return new Response("chat not configured", { status: 503 });
  const url = new URL(req.url), ip = req.headers.get("CF-Connecting-IP") || "";
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", url.searchParams.get("ts") || "");
  form.append("remoteip", ip);
  const v = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form })
    .then(r => r.json()).catch(() => ({}));
  if (!v.success) return new Response("bot check failed", { status: 403 });
  const day = new Date().toISOString().slice(0, 10);
  const headers = new Headers(req.headers);
  headers.set("X-Chat-Who", await sha(`${env.CHAT_SALT || "dlz-chat"}|${day}|${ip}`));
  return env.CHAT.get(env.CHAT.idFromName("main")).fetch(new Request(req, { headers }));
}

async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].slice(0, 8).map(x => x.toString(16).padStart(2, "0")).join("");
}

// ---- what may be said ----
// Text only, up to 200 characters. No links, e-mail addresses, @handles or phone numbers (no way to lure anyone
// off the site, which matters with children watching), no slurs or swearing in English or Russian.
const LINK = /(https?:|www\.|\.(com|net|org|ru|рф|su|io|ly|me|gg|co|xyz|info|biz|tv|app|link|site|online|top|club|shop|live|fun)\b|discord|t\.me|telegram|whatsapp|snapchat|insta|tiktok|onlyfans|kik\b|скайп|телеграм|ватсап|инстаграм)/i;
const CONTACT = /([^\s@]+@[^\s@]+\.\w|@\w{2,})/;
// roots blocked anywhere in a word, after folding look-alike characters (f*ck, sh1t, хуй, ...)
const ROOTS = ["fuck", "cunt", "nigg", "fagg", "whore", "slut", "pedo", "paedo",
  "killyourself", "hitler", "nazi", "porn", "hentai", "nude", "nudes", "retard", "motherf", "bitch", "dickhead", "asshole",
  "хуй", "хуе", "хуё", "хуя", "пизд", "ебат", "ебан", "ебал", "заеб", "уеб", "бляд", "блят", "пидор", "пидар", "педик",
  "гандон", "залуп", "шлюх", "мудак", "мудил", "долбоеб", "долбаеб", "сучк", "дебил", "порно", "нацист", "гитлер"];
// whole words only, so Sussex, Dickens or "сукно" stay fine
const WORDS = new Set(["sex", "sexy", "dick", "cock", "pussy", "rape", "rapist", "shit", "cum", "fag", "fuk", "kys", "niga", "tits", "boobs",
  "сука", "суки", "бля", "секс", "член", "жопа", "срать", "сдохни", "ебу", "ёб", "еб"]);
const FOLD = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i", "|": "i", "ё": "е" };

function clean(t) {
  return String(t || "").normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]/g, "")   // control and invisible characters
    .replace(/(\p{M}{2})\p{M}+/gu, "$1")                                                             // "zalgo" stacks
    .replace(/(.)\1{4,}/gu, "$1$1$1$1")                                                              // loooooooong repeats
    .replace(/\s+/g, " ").trim().slice(0, CHAT.MAX_LEN);
}

function problem(t) {
  if (!t) return "empty";
  if (LINK.test(t)) return "link";
  if (CONTACT.test(t) || (t.match(/\d/g) || []).length >= 7) return "contact";
  const lower = t.toLowerCase();
  const words = lower.split(/[^\p{L}\p{N}@$!|]+/u).filter(Boolean);
  const folded = words.map(w => [...w].map(ch => FOLD[ch] || ch).join("").replace(/[^\p{L}]/gu, ""));
  // letters spaced out one by one ("f u c k") count as one word
  folded.push(...(folded.map(w => w.length === 1 ? w : " ").join("").split(" ").filter(w => w.length >= 3)));
  if (folded.some(w => WORDS.has(w))) return "words";
  const joined = folded.join("");                      // catches "f u c k" spelled across spaces too
  if (ROOTS.some(r => folded.some(w => w.includes(r)) || (r.length >= 5 && joined.includes(r)))) return "words";
  const letters = t.replace(/[^\p{L}]/gu, "");
  if (letters.length > 12 && letters.replace(/[^\p{Lu}]/gu, "").length / letters.length > 0.7) return "caps";
  return "";
}

export class ChatRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.msgs = null;   // [{id, n: name, e: emoji, t: text, c: cam id, ts, w: who hash, r: [reporter hashes]}]
    this.mutes = null;  // {who: until}
  }

  async load() {
    if (this.msgs) return;
    this.msgs = (await this.ctx.storage.get("msgs")) || [];
    this.mutes = (await this.ctx.storage.get("mutes")) || {};
  }

  async fetch(req) {
    await this.load();
    const who = req.headers.get("X-Chat-Who") || "";
    const socks = this.ctx.getWebSockets();
    if (socks.length >= CHAT.MAX_CONN) return new Response("room full", { status: 503 });
    if (socks.filter(s => (s.deserializeAttachment() || {}).who === who).length >= CHAT.PER_IP)
      return new Response("too many tabs", { status: 429 });
    const seed = Math.abs(parseInt(new URL(req.url).searchParams.get("seed"), 10) || 0) % NAMES;
    const [n, e] = [ADJ[seed % ADJ.length] + " " + ANIMALS[Math.floor(seed / ADJ.length)][0], ANIMALS[Math.floor(seed / ADJ.length)][1]];
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ who, n, e, cam: "", sent: [], last: "" });
    const now = Date.now();
    pair[1].send(JSON.stringify({ type: "hello", you: { n, e }, msgs: this.recent(now).map(pub), muted: this.muteLeft(who, now) }));
    this.presence();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  recent(now) { return this.msgs.filter(m => now - m.ts < CHAT.KEEP_MS); }
  muteLeft(who, now) { const u = this.mutes[who] || 0; return u > now ? u - now : 0; }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 2000) return;
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    await this.load();
    const a = ws.deserializeAttachment() || {}, now = Date.now();
    if (m.type === "watch") {
      a.cam = /^[\w-]{11}$/.test(m.cam || "") ? m.cam : "";
      ws.serializeAttachment(a);
      return this.presence();
    }
    if (m.type === "report") return this.report(a.who, String(m.id || ""), now);
    if (m.type !== "say") return;

    const left = this.muteLeft(a.who, now);
    if (left) return ws.send(JSON.stringify({ type: "nope", why: "muted", left }));
    a.sent = (a.sent || []).filter(t => now - t < CHAT.BURST_MS);
    if ((a.sent.length && now - a.sent[a.sent.length - 1] < CHAT.GAP_MS) || a.sent.length >= CHAT.BURST)
      return ws.send(JSON.stringify({ type: "nope", why: "slow" }));
    const t = clean(m.text);
    const why = problem(t) || (t.toLowerCase() === a.last ? "repeat" : "");
    if (why) return ws.send(JSON.stringify({ type: "nope", why }));
    a.sent.push(now);
    a.last = t.toLowerCase();
    ws.serializeAttachment(a);

    const msg = { id: crypto.randomUUID().slice(0, 8), n: a.n, e: a.e, t, c: a.cam, ts: now, w: a.who, r: [] };
    this.msgs = this.recent(now).concat(msg).slice(-CHAT.KEEP);
    await this.ctx.storage.put("msgs", this.msgs);
    this.send({ type: "msg", m: pub(msg) });
  }

  // enough different people reporting one message hides everything its author wrote and mutes them for 24 hours;
  // in a small room two reports are enough
  async report(who, id, now) {
    const msg = this.msgs.find(m => m.id === id);
    if (!msg || msg.w === who || msg.r.includes(who)) return;
    msg.r.push(who);
    const online = new Set(this.ctx.getWebSockets().map(s => (s.deserializeAttachment() || {}).who)).size;
    const need = Math.max(2, Math.min(CHAT.REPORTS, online - 1));
    if (msg.r.length >= need) {
      const gone = this.msgs.filter(m => m.w === msg.w).map(m => m.id);
      this.msgs = this.msgs.filter(m => m.w !== msg.w);
      for (const [k, until] of Object.entries(this.mutes)) if (until < now) delete this.mutes[k];
      this.mutes[msg.w] = now + CHAT.MUTE_MS;
      await this.ctx.storage.put("mutes", this.mutes);
      this.send({ type: "hide", ids: gone });
    }
    await this.ctx.storage.put("msgs", this.msgs);
  }

  // how many are here and how many have each cam on their stage (counts only, no names)
  presence() {
    const socks = this.ctx.getWebSockets(), cams = {};
    for (const s of socks) { const c = (s.deserializeAttachment() || {}).cam; if (c) cams[c] = (cams[c] || 0) + 1; }
    this.send({ type: "here", online: socks.length, cams });
  }

  send(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(s); } catch (e) {} }
  }

  async webSocketClose(ws) { this.presence(); }
  async webSocketError(ws) { this.presence(); }
}

const pub = m => ({ id: m.id, n: m.n, e: m.e, t: m.t, c: m.c, ts: m.ts });
