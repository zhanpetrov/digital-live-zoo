# Digital Live Zoo

Every free live animal cam on YouTube we could find, in one zoo: safari waterholes, pandas, bears, penguins, eagles, storks, coral reefs and more, on six continents.

- **Main Stage** plays a live cam right on the page and tours the planet every 45 seconds, showing cams where it is daytime. It follows the filters, so picking Africa tours Africa.
- **Filters** by continent and habitat, plus "Awake now" (local time between 5 am and 8 pm), search and sorting.
- **Wall** plays up to 9 cams at once for multicam watching or recording.

## Files

- `index.html` — the whole site, no build step.
- `catalog.json` — the cam list. Each cam: `id` (YouTube video id), `n` name, `p` place, `k` country, `c` continent, `tz` IANA time zone, `ty` habitat (`safari`, `zoo`, `aqua`, `birds`, `wild`, `pets`), `ch` / `cid` channel, `w` viewers at last check.

The list is refreshed every hour: restarted streams get their new id, dead ones are dropped, and new cams are added a few times a day.

## Rights

Every video plays from its owner's channel through YouTube's embedded player. Some owners block embedding; those cams open on YouTube. Recording or re-editing a stream for anything public needs the cam owner's permission.

Built with Claude.
