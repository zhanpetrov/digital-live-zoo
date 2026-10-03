# Digital Live Zoo

Every free live animal cam on YouTube we could find, in one zoo: safari waterholes, pandas, bears, penguins, eagles, storks, coral reefs and more, on six continents.

- **Main Stage** plays a live cam right on the page and tours the planet, going where it is most worth watching right now: cams with animals in view, movement, a big live audience, or a sudden jump in viewers (🔥 trending). It skips cams that show nothing (dark, empty, blank) or are off air, stays up to 3 minutes on trending or action cams, and falls back to the most-watched daytime cams every 45 seconds when it has no data. It follows the filters, so picking Africa tours Africa.
- **Badges** on the cards: 🔥 TRENDING, ● ACTION NOW, OFF AIR NOW, plus the live viewer count. The "Most interesting now" sort uses the same score.
- **Filters** by continent and habitat, plus "Awake now" (local time between 5 am and 8 pm), search and sorting.
- **Wall** plays up to 9 cams at once for multicam watching or recording.

## Files

- `index.html` — the whole site, no build step.
- `activity.json` — how worth watching each cam is right now, rewritten every 30 minutes by `.github/workflows/activity.yml` running `tools/activity.py`. Per cam: a 0–100 score, flags and live viewers. The score mixes: something to look at in the live thumbnail (a small CLIP image model, prompts in `tools/clip_prompts.json`, compared with the cam's own norm), movement since the last frame, live viewers, and viewers versus the cam's usual audience (spikes = trending).
- `privacy.html` — privacy page (YouTube player, PostHog, AdSense).
- `catalog.json` — the cam list. Each cam: `id` (YouTube video id), `n` name, `p` place, `k` country, `c` continent, `tz` IANA time zone, `ty` habitat (`safari`, `zoo`, `aqua`, `birds`, `wild`, `pets`), `ch` / `cid` channel, `w` viewers at last check, `mfk` true if YouTube marks the video Made for Kids.
- `mfk.json` — cams YouTube marks Made for Kids, written daily by `.github/workflows/mfk.yml` running `tools/mfk.py` (needs a `YT_API_KEY` repository secret with a YouTube Data API v3 key). The site leaves these cams out, because YouTube's API policy requires tracking to be off around them.

The list is refreshed every hour: restarted streams get their new id, dead ones are dropped, and new cams are added a few times a day.

## Cam pages (search)

Every camera also has a permanent page, `/live/<slug>/`, plus hub pages under `/animals/`, `/places/` and `/habitats/`, so search engines can find the cams one by one. `tools/build_pages.py` writes them from `catalog.json`, and `.github/workflows/pages.yml` reruns it whenever the list or the data changes, and daily.

- `data/cams.json` — one entry per camera, keyed by a slug that never changes. A restarted stream keeps its page: the new YouTube id is added to `ids`. Also holds `animals`, `species`, the written `note`, and the days it was seen live. Edit `note`, `title`, `desc` and `species` here.
- `data/hubs.json` — titles and intro text for animal hubs.
- A cam page is indexed only when `note_ok` is true and the cam is live; an animal hub only when `intro_ok` is true. Everything else is `noindex, follow` and stays out of `sitemap.xml`.
- `slugs.json` maps video ids to slugs for the home page; `assets/pages.css` and `assets/pages.js` style the generated pages and fill in local time and activity.

## Ads

One ad slot only, in the header: 728×90 on desktop, 468×60 on tablets, 320×50 on phones. Nothing in the player, the wall or the cam grid, and no Auto ads. It stays off until `window.ZOO_ADS` in `index.html` gets the AdSense publisher id and ad unit slot id. Open the site with `?adpreview` to see the slot with a sample.

## Rights

Every video plays from its owner's channel through YouTube's embedded player. Some owners block embedding; those cams open on YouTube. Recording or re-editing a stream for anything public needs the cam owner's permission.

Built with Claude.
