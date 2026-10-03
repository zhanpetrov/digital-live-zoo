# Status and open items

Snapshot of where things stand (2026-10-03), so the next session can pick up.

## Working
- Site: single `index.html` on GitHub Pages (digitallivezoo.com), deployed straight from `main`.
- Analytics: PostHog (US cloud), project "Digital Live Zoo", dashboard "Digital Live Zoo". Custom events: `cam_on_stage` (with `activity` score), `cam_embed_blocked`, `wall_opened`, `wall_cam_added` / `wall_cam_removed`, `filter_changed`, `search`, `sound_toggled`, `tour_toggled`.
- Smart tour: `tools/activity.py` scores each cam (CLIP "something to look at", movement, live viewers, viewer spikes) into `activity.json`; the Main Stage tour follows it, skips blank and off-air cams, and falls back to the 45-second tour without data (data counts for up to 3 hours).
- Daily cam-list refresh: a Claude routine on Zhan's Mac updates `catalog.json`.
- AdSense: verification meta tag, `ads.txt` and privacy page are live; the ad slot stays off until `window.ZOO_ADS.slot` is set.

## Open
1. **Activity schedule does not fire.** `.github/workflows/activity.yml` has `cron: "13,43 * * * *"`, but GitHub has not run it on schedule once; only manual `workflow_dispatch` runs work. Options: an hourly Claude routine that dispatches the workflow (recommended), or dispatch from the daily Mac routine.
2. **Actions minutes.** Each activity run is ~2 billed minutes; every 30 minutes is ~2,900 min/month, above the 2,000 free minutes for a private repo. Decide: make the repo public, run hourly, or stay on a paid plan.
3. **AdSense.** In the AdSense UI: connect the site, request review, add payment info. After approval, create a 728x90 display unit and put its slot id in `window.ZOO_ADS.slot` in `index.html`.
4. **Off-air cams.** ~21 catalog cams are no longer live (flag `x` in `activity.json`); the daily refresh should replace or drop them.
5. **Collaborator.** Invite Ilya (GitHub `Fominfo`) with Write access from Settings → Collaborators; this has to be done in the browser.
6. **Bot-to-bot channel with Ilya's agent (Claudia).** Waiting on her script, launcher and README for review before anything is installed on the Mac; GitHub Issues on this repo is the simpler alternative.
7. **`mfk.yml`** (Made for Kids check) does nothing until a `YT_API_KEY` repository secret is set.

## Ideas not started
- Vision-model captions for the top cams ("a bear is fishing").
- A "Highlights" mode that shows only trending/action cams.
