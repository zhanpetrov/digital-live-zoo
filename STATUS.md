# Status and open items

Snapshot of where things stand (2026-10-03), so the next session can pick up. The repo moved from `zhanpetrov8-svg/digital-live-zoo` to `zhanpetrov/digital-live-zoo`; start new sessions with the new one. How the project is laid out: `CONTRIBUTING.md`.

## Working
- Site: single `index.html` on GitHub Pages (digitallivezoo.com), deployed straight from `main`.
- Analytics: PostHog (US cloud), project "Digital Live Zoo", dashboard "Digital Live Zoo". Custom events: `cam_on_stage` (with `activity` score), `cam_embed_blocked`, `wall_opened`, `wall_cam_added` / `wall_cam_removed`, `filter_changed`, `search`, `sound_toggled`, `tour_toggled`, `stage_fullscreen` (`on`, `mode`: `native` = browser full screen, `page` = fixed layer on phones like iPhone that can't put a page element full screen).
- Full screen: a button on the Main Stage player (also F key, double-click) puts the stage player alone on the screen; cam name, Sound / Touring / Next cam sit in a bar that hides after 3 s idle. Both stacked players go full screen together, so crossfades keep working.
- Smart tour: `tools/activity.py` scores each cam (CLIP "something to look at", movement, live viewers, viewer spikes) into `activity.json`; the Main Stage tour follows it, skips blank and off-air cams, and falls back to the 45-second tour without data (data counts for up to 3 hours).
- Learning from skips: every stage visit is logged as a PostHog `stage_segment` event (cam, habitat, daypart, activity level, viewers, seconds watched, how it ended: `skip` / `pick` / `tour` / `early` / `trouble` / `wall` / `hidden` / `leave` / `hold` / `resume` / `first`). A skip-hazard model sets how long the tour holds each cam and which cam comes next. Each browser learns its own viewer's skips (localStorage `zoo-segs`); `tools/attention.py` (daily, `attention.yml`) fits the shared model on all viewers into `attention.json`.
- Daily cam-list refresh: a Claude routine on Zhan's Mac updates `catalog.json`. Its prompt still names the old repo `zhanpetrov8-svg/digital-live-zoo` (GitHub redirects git, so it should keep working); switching it to `zhanpetrov/digital-live-zoo` needs Zhan's approval in a session linked to the Mac. Note it writes `catalog.json` whole, so keys other tools add to it (e.g. `mfk`) must also exist in the artifact's master list.
- Cam pages (`/live`, `/animals`, `/places`, `/habitats`) are built by `tools/build_pages.py` via `pages.yml`.
- AdSense: verification meta tag, `ads.txt` and privacy page are live; the ad slot stays off until `window.ZOO_ADS.slot` is set.

## Open
1. **Activity schedule does not fire** (checked until 11:00 UTC on 2026-10-03, before the repo moved; check again in the new repo). `.github/workflows/activity.yml` has `cron: "13,43 * * * *"`, but GitHub has not run it on schedule once; only manual `workflow_dispatch` runs work. Options: an hourly Claude routine that dispatches the workflow (recommended), or dispatch from the daily Mac routine.
2. **Actions minutes.** Each activity run is ~2 billed minutes; every 30 minutes is ~2,900 min/month, above the 2,000 free minutes for a private repo. Decide: make the repo public, run hourly, or stay on a paid plan.
3. **AdSense.** First review (2026-10-13): "Low value content". Fixed on 2026-10-14: About and Contact pages, field guide on the home page, notes for 43 more cams (61 cam pages indexable), intros for all 33 animal hubs (96 indexable pages in total). Contact form messages arrive in PostHog as `contact_message` (table "Contact messages" on the dashboard). Still to do in the AdSense UI: add payment info, request a new review. After approval, create a 728x90 display unit and put its slot id in `window.ZOO_ADS.slot` in `index.html`.
4. **Off-air cams.** ~21 catalog cams are no longer live (flag `x` in `activity.json`); the daily refresh should replace or drop them.
5. **Collaborator.** Invite Ilya (GitHub `Fominfo`) with Write access from Settings → Collaborators; this has to be done in the browser.
6. **Bot-to-bot channel with Ilya's agent (Claudia).** Waiting on her script, launcher and README for review before anything is installed on the Mac; GitHub Issues on this repo is the simpler alternative.
7. **`mfk.yml`** (Made for Kids check) does nothing until a `YT_API_KEY` repository secret is set.
8. **`attention.yml`** (shared boredom model) does nothing until a `POSTHOG_API_KEY` repository secret is set (PostHog → Settings → Personal API keys, scope `query:read`); set the `POSTHOG_PROJECT_ID` repository variable too if `@current` is rejected. Like `activity.yml`, its schedule may need a manual or routine dispatch.

## Ideas not started
- Vision-model captions for the top cams ("a bear is fishing").
- A "Highlights" mode that shows only trending/action cams.
- Video-content features for the boredom model (e.g. V-JEPA or CLIP embeddings of short clips), so it predicts boredom from what is on screen, not only from cam, habitat and activity score.
