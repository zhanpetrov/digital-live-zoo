# Live visitor numbers

The home page can show "● 3 people here now · 12 visitors today · 38 this week" under the header stats.
The numbers come from PostHog, which needs a secret key, so a tiny Cloudflare Worker (`worker.js`)
holds the key and hands the page only the totals. Answers are cached for 30 s.

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

## Privacy

Only totals leave the Worker: no IDs, places or pages. The privacy page says the home page shows visitor totals.
