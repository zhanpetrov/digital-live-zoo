# Digital Live Zoo

Every free live animal cam on YouTube we could find, in one zoo: safari waterholes, pandas, bears, penguins, eagles, storks, coral reefs and more, on six continents.

- **Main Stage** plays a live cam right on the page and tours the planet, following the action: it jumps to cams where something is moving right now and stays up to 3 minutes while the action lasts. When nothing stands out it falls back to the most-watched daytime cams every 45 seconds. It follows the filters, so picking Africa tours Africa.
- **Action now** badges and the "Most action now" sort show which cams have movement at the moment.
- **Filters** by continent and habitat, plus "Awake now" (local time between 5 am and 8 pm), search and sorting.
- **Wall** plays up to 9 cams at once for multicam watching or recording.

## Files

- `index.html` — the whole site, no build step.
- `activity.json` — how much is happening on each cam (0–100), rewritten every 20 minutes by `.github/workflows/activity.yml` running `tools/activity.py`. It compares each cam's live YouTube thumbnail with its previous frame and with its usual background, relative to what is normal for that cam.
- `privacy.html` — privacy page (YouTube player, PostHog, AdSense).
- `catalog.json` — the cam list. Each cam: `id` (YouTube video id), `n` name, `p` place, `k` country, `c` continent, `tz` IANA time zone, `ty` habitat (`safari`, `zoo`, `aqua`, `birds`, `wild`, `pets`), `ch` / `cid` channel, `w` viewers at last check, `mfk` true if YouTube marks the video Made for Kids (those cams are not shown, because YouTube's API policy requires tracking to be off around them).

The list is refreshed every hour: restarted streams get their new id, dead ones are dropped, and new cams are added a few times a day.

## Ads

One ad slot only, in the header: 728×90 on desktop, 468×60 on tablets, 320×50 on phones. Nothing in the player, the wall or the cam grid, and no Auto ads. It stays off until `window.ZOO_ADS` in `index.html` gets the AdSense publisher id and ad unit slot id. Open the site with `?adpreview` to see the slot with a sample.

## Rights

Every video plays from its owner's channel through YouTube's embedded player. Some owners block embedding; those cams open on YouTube. Recording or re-editing a stream for anything public needs the cam owner's permission.

Built with Claude.
