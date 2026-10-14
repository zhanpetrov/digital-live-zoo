"""Keep catalog.json in step with what is actually live on YouTube. Runs daily in GitHub Actions.

1. Liveness: asks YouTube whether every cam is live right now and updates "w" (viewers).
2. Restarted streams: when a cam is not live, looks at its channel's Live tab and, if the channel is
   streaming something that matches the old cam, swaps in the new video id (the cam keeps its page).
3. Dead cams: a cam that is off air with no replacement on three daily runs in a row is dropped.
4. Discovery: searches YouTube for live animal cams and checks the Live tabs of channels already in the
   zoo. New, embeddable live streams go to data/candidates.json for a person (or Claude) to name, place
   and approve; nothing is added to the zoo automatically.

State between runs: data/refresh_state.json. Usage: python tools/refresh.py [--no-discovery]
"""
import concurrent.futures as cf
import json
import os
import re
import sys
import time
import urllib.parse
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import yt  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAT, STATE, CAND = (os.path.join(ROOT, p) for p in ("catalog.json", "data/refresh_state.json", "data/candidates.json"))
DROP_AFTER = 3          # daily runs off air with no replacement before a cam leaves the zoo
MIN_CAMS = 150

QUERIES = ["zoo live cam", "wildlife live cam", "safari live cam", "waterhole live cam", "panda live cam", "bear cam live",
           "aquarium live cam", "penguin cam live", "eagle nest live cam", "osprey cam live", "owl cam live", "falcon cam live",
           "stork nest live cam", "hummingbird live cam", "bird feeder live cam", "sea otter cam", "seal live cam",
           "wolf live cam", "gorilla live cam", "elephant live cam", "giraffe live cam", "tiger live cam", "koala live cam",
           "underwater live cam", "explore.org live cam", "africam live", "動物園 ライブカメラ", "水族館 ライブカメラ", "动物园 直播",
           "Tierpark live", "Storchennest live", "dierentuin live", "зоопарк онлайн камера", "zoológico cámara en vivo"]
SKIP = re.compile(r"\b(asmr|lofi|lo-fi|relax|relaxing|sleep|music|tv for (cats|dogs)|cat tv|dog tv|for cats to watch|"
                  r"documentary|full episode|compilation|highlights|replay|rerun|kids|cartoon|traffic|weather|"
                  r"city ?cam|street|beach|airport|train|railway|station|news|crossing|harbou?r|ferry|pier|marina|skyline|downtown|"
                  r"bridge|memorial|hotel|resort|boat ramp|aurora|northern lights|times square|minecraft|game|gaming|"
                  r"roblox|nature sounds|members)\b|ニュース|速報|ライブカメラ\s*\|?\s*(空港|港)", re.I)


def load(path, default):
    try:
        return json.load(open(path, encoding="utf-8"))
    except Exception:
        return default


# words that say nothing about which cam it is (channel boilerplate)
STOP = {"live", "cam", "cams", "camera", "webcam", "stream", "streaming", "the", "and", "with", "from", "for", "powered",
        "explore", "org", "earthcam", "hd", "4k", "24h", "247", "channel", "official", "watch", "now", "today"}


def words(s):
    return set(w for w in re.findall(r"[^\W_]{3,}", (s or "").lower()) if w not in STOP)


def similarity(a, b):
    a, b = words(a), words(b)
    return len(a & b) / max(1, min(len(a), len(b)))


def oembed(vid):
    """Title and channel if the video exists and may be embedded on other sites; None otherwise."""
    r = yt.get("https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(f"https://www.youtube.com/watch?v={vid}"))
    try:
        return json.loads(r) if r else None
    except Exception:
        return None


def main():
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    cat = load(CAT, None)
    state = load(STATE, {})
    cams = cat["cams"]
    ids = {c["id"] for c in cams}

    # 1. liveness
    def check(c):
        time.sleep(0.2)
        return yt.live_status(c["id"])
    with cf.ThreadPoolExecutor(6) as ex:
        status = list(ex.map(check, cams))

    answered = [s for s in status if s[1] is not None]
    if len(answered) < len(cams) * 0.8:
        print(f"YouTube answered for only {len(answered)} of {len(cams)} cams; leaving the list unchanged.")
        return 1

    # 2. restarted streams
    by_channel = {}
    for c in cams:
        by_channel.setdefault(c.get("cid"), []).append(c)
    channel_cache = {}

    def channel(cid):
        if cid not in channel_cache:
            channel_cache[cid] = yt.channel_live(cid) if cid else []
            time.sleep(0.5)
        return channel_cache[cid]

    replaced, dropped, keep = [], [], []
    for c, (viewers, live) in zip(cams, status):
        st = state.setdefault(c["id"], {})
        if live is None:                      # YouTube didn't answer for this one: leave it alone
            keep.append(c)
            continue
        if live:
            c["w"] = viewers or c.get("w", 0)
            st.pop("misses", None)
            st["last_live"] = today
            keep.append(c)
            continue
        old = oembed(c["id"]) or {}
        ref = (old.get("title") or "") + " " + c["n"]
        options = [v for v in channel(c.get("cid")) if v["id"] not in ids]
        best = max(options, key=lambda v: similarity(v["title"], ref), default=None)
        score = similarity(best["title"], ref) if best else 0
        # a channel's only live stream is a weaker match, but it still has to share words with the old cam
        single = len(options) == 1 and len(by_channel.get(c.get("cid"), [])) == 1 and score >= 0.2
        if best and (score >= 0.34 or single) and not SKIP.search(best["title"]) and oembed(best["id"]):
            ids.discard(c["id"])
            ids.add(best["id"])
            replaced.append((c["n"], c["id"], best["id"], best["title"]))
            state[best["id"]] = {"last_live": today, "was": c["id"]}
            state.pop(c["id"], None)
            c["id"] = best["id"]
            c["w"] = best["viewers"] or c.get("w", 0)
            keep.append(c)
            continue
        if st.get("last_check") != today:
            st["misses"] = st.get("misses", 0) + 1
            st["last_check"] = today
        if st["misses"] >= DROP_AFTER:
            dropped.append((c["n"], c["id"]))
            state.pop(c["id"], None)
            continue
        keep.append(c)

    if len(keep) < MIN_CAMS:
        print(f"Only {len(keep)} cams would remain; refusing to write a list that small.")
        return 1
    for i, c in enumerate(keep):
        if "i" in c:
            c["i"] = i
    cat["cams"] = keep
    cat["updated"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with open(CAT, "w", encoding="utf-8") as f:
        json.dump(cat, f, ensure_ascii=False, separators=(",", ":"))
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")

    # 4. discovery -> candidates for review
    found = {}
    if "--no-discovery" not in sys.argv:
        pool = []
        for q in QUERIES:
            pool += [dict(v, via="search: " + q) for v in yt.search_live(q)]
            time.sleep(0.5)
        for cid in list(by_channel):
            pool += [dict(v, via="channel already in the zoo") for v in channel(cid)]
        old = load(CAND, {}).get("candidates", {})
        rejected = set(load(CAND, {}).get("rejected", []))
        for v in pool:
            vid = v["id"]
            if vid in ids or vid in found or vid in rejected or SKIP.search(v["title"] or "") or "kids" in (v["channel"] or "").lower():
                continue
            meta = oembed(vid)
            if not meta or "kids" in (meta.get("author_name") or "").lower() or SKIP.search(meta.get("title") or ""):
                continue                      # gone, private, not embeddable, or not an animal cam
            found[vid] = {"title": meta.get("title") or v["title"], "channel": meta.get("author_name") or v["channel"],
                          "channel_url": meta.get("author_url", ""), "cid": v.get("cid") or "", "viewers": v.get("viewers"),
                          "via": v["via"], "first_seen": old.get(vid, {}).get("first_seen", today)}
        with open(CAND, "w", encoding="utf-8") as f:
            json.dump({"updated": cat["updated"], "note": "Live, embeddable streams not yet in the zoo. To add one, write a "
                       "catalog entry for it; to hide it for good, move its id to 'rejected'.",
                       "candidates": dict(sorted(found.items(), key=lambda kv: -(kv[1]["viewers"] or 0))),
                       "rejected": sorted(rejected)}, f, ensure_ascii=False, indent=1)
            f.write("\n")

    live_now = sum(1 for s in status if s[1])
    print(f"{len(cams)} cams checked, {live_now} live, {len(replaced)} replaced, {len(dropped)} dropped, "
          f"{len(keep)} in the zoo, {len(found)} discovery candidates")
    for n, a, b, t in replaced:
        print(f"  replaced {n}: {a} -> {b} ({t})")
    for n, a in dropped:
        print(f"  dropped {n} ({a})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
