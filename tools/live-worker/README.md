# Live visitor numbers

The home page shows a "Live now" card under the header stats: people here now, a visitors-per-hour chart for the last 24 hours,
visitors today and this week, hours watched, visitor countries, and the 3 most watched cams of the day (click one to put it on stage).
The numbers come from PostHog, which needs a secret key, so a tiny Cloudflare Worker (`worker.js`)
holds the key and hands the page only the totals. Answers are cached for 60 s; if PostHog fails to answer, the last good numbers are served.

The page side is already live in `index.html` and stays hidden until `window.ZOO_LIVE.url` is set.
It also sends a `zoo_here` heartbeat every 4 minutes while the tab is visible, so people who stay
on one cam still count as "here now".

## Switch it on (about 10 minutes)

1. **PostHog key.** PostHog → Settings → Personal API keys → Create key.
   Scope: **Query: Read** only, project "Digital Live Zoo". Copy the key.
2. **Worker.** Cloudflare dashboard (free account) → Workers & Pages → Create → "Hello World" worker,
   name it `zoo-live` → Deploy → Edit code → replace everything with `worker.js` → Deploy.
3. **Secret.** The worker → Settings → Variables and secrets → Add → type **Secret**,
   name `POSTHOG_API_KEY`, value = the key from step 1 → Deploy.
4. Open the worker URL (`https://zoo-live.<account>.workers.dev`). It should show JSON like
   `{"now":1,"today":4,"week":38,...}`.
5. Put that URL in `index.html`: `window.ZOO_LIVE = {url: "https://zoo-live.<account>.workers.dev"};`

## Starting the cam-activity job

GitHub skips most scheduled runs of `activity.yml`, so the Worker's cron (the same one that refreshes the weather)
starts it through the GitHub API, every 30 minutes by default (free: the repo is public).

1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.
   Repository access: only `zhanpetrov/digital-live-zoo`. Permissions: **Actions: Read and write**. Copy the token.
2. The worker → Settings → Variables and secrets → Add → type **Secret**, name `GH_DISPATCH_TOKEN`, value = the token → Deploy.
3. Optional: a plain variable `ACTIVITY_EVERY_MIN` (e.g. `60`) to change the pace. If the repo is ever made private
   again, every run bills ~3 Actions minutes.

The last start time is kept in the `WX` KV namespace under `activity_dispatch`.

## Zoo Chat

One public room (`GET /chat`, WebSocket), held by the Durable Object class `ChatRoom` in `worker.js`; the page side is
`assets/chat.js` / `assets/chat.css`, switched on by `window.ZOO_CHAT = {url, sitekey}` in `index.html` (empty url = no chat).

- Safety: Cloudflare Turnstile before joining; only the zoo's own origin; text only, 200 characters; no links, e-mail,
  @handles or phone numbers; English and Russian swear and slur filter; 1 message per 3 s and 5 per 30 s; 3 tabs per person;
  enough reports (3, or 2 in a small room) hide everything the author wrote and mute them for 24 hours.
- Kept: the last 50 messages for 24 hours and the mutes. People are a daily-salted hash of the IP, never the IP.
- Settings: `TURNSTILE_SECRET` (secret, from Cloudflare → Turnstile → the zoo widget), `CHAT_OFF` = `1` closes the room at once
  (kill switch, no deploy needed), `CHAT_SALT` (optional secret), `CHAT_DEV_ORIGINS` (local testing only).
- Deploy with Wrangler, because a Durable Object needs a migration: `npx wrangler login` once, then
  `cd tools/live-worker && npx wrangler deploy`. `wrangler.toml` keeps the cron and the `WX` KV binding and has `keep_vars = true`.
- Local test: `npx wrangler dev` (uses `.dev.vars` with Cloudflare's always-pass Turnstile test secret) and open the site
  from `http://localhost:8791`; `assets/chat.js` then talks to `ws://127.0.0.1:8787/chat` with the test site key.

## Privacy

Only totals and YouTube video ids of the most watched cams leave the Worker: no person IDs, places or pages. The privacy page says the home page shows visitor totals.
