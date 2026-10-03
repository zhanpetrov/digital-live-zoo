"""Score how much is happening on each cam right now, from YouTube's live thumbnails.

YouTube refreshes a live stream's thumbnail (mqdefault_live.jpg) about every
five minutes. Each run downloads all of them and compares every cam with
  - its previous frame (motion since the last run), and
  - its own slow-moving background (something in view that usually isn't).
A cam scores high when a lot changed compared with what is normal for that cam,
so a waterhole with elephants beats one that only has rippling water.

Writes activity.json for the site; keeps per-cam state in .state/ (cached
between runs by the workflow, never committed).

Usage: python tools/activity.py [catalog.json] [activity.json] [.state]
"""
import concurrent.futures as cf
import hashlib
import io
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

from PIL import Image, ImageFilter

W, H = 64, 36                # analysis size
PIX = 30                     # per-pixel change (0-255) that counts as "changed"
DARK = 28                    # mean brightness below this = too dark to judge
FLAT = 10                    # brightness spread below this = blank / "be right back" card
SCENE_CUT = 0.55             # more than this fraction changed = camera moved / switched
BG_ALPHA = 0.2               # background learning rate per run
NORM_ALPHA = 0.1             # learning rate of each cam's "usual" activity
STATIC_RUNS = 3              # same bytes this many runs in a row = promo image, not a live frame

catalog_path = sys.argv[1] if len(sys.argv) > 1 else "catalog.json"
out_path = sys.argv[2] if len(sys.argv) > 2 else "activity.json"
state_dir = sys.argv[3] if len(sys.argv) > 3 else ".state"
os.makedirs(state_dir, exist_ok=True)
state_file = os.path.join(state_dir, "state.json")

cams = json.load(open(catalog_path, encoding="utf-8"))["cams"]
try:
    state = json.load(open(state_file))
except Exception:
    state = {}


def fetch(cam_id):
    url = f"https://i.ytimg.com/vi/{cam_id}/mqdefault_live.jpg?r={int(time.time())}"
    for _ in range(2):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (digitallivezoo.com activity)"})
            return urllib.request.urlopen(req, timeout=20).read()
        except Exception:
            time.sleep(1)
    return None


def frac_changed(a, b):
    """Fraction of pixels that differ by more than PIX, after removing a global brightness shift."""
    d = sorted(abs(x - y) for x, y in zip(a, b))
    med = d[len(d) // 2]
    return sum(1 for v in d if v - med > PIX) / len(d)


def analyse(cam_id, data, st):
    h = hashlib.md5(data).hexdigest()
    st["static"] = st.get("static", 0) + 1 if st.get("hash") == h else 0
    st["hash"] = h
    if st["static"] >= STATIC_RUNS:
        return None, "s"          # promo thumbnail, no signal
    if st["static"] > 0:
        return st.get("last"), ""  # YouTube hasn't refreshed it yet; keep the last score

    img = Image.open(io.BytesIO(data)).convert("L").resize((W, H), Image.BOX).filter(ImageFilter.GaussianBlur(1))
    cur = list(img.get_flattened_data() if hasattr(img, "get_flattened_data") else img.getdata())
    lum = sum(cur) / len(cur)
    spread = (sum((v - lum) ** 2 for v in cur) / len(cur)) ** 0.5
    prev, bg = st.get("prev"), st.get("bg")
    st["prev"] = cur
    st["runs"] = st.get("runs", 0) + 1

    if lum < DARK:
        st["bg"] = cur if bg is None else bg
        return 0, "d"
    if spread < FLAT:                 # blank frame: nothing to see, and no baseline to keep
        st["prev"] = prev
        return 0, "d"
    if prev is None or max(prev) - min(prev) < 3 * FLAT:
        st["bg"] = cur
        return None, ""

    motion = frac_changed(cur, prev)
    if motion > SCENE_CUT:            # camera moved or the channel switched angles
        st["bg"] = cur
        return 30, "c"
    fg = frac_changed(cur, bg) if bg is not None and st["runs"] > 3 else 0.0
    st["bg"] = [b + BG_ALPHA * (c - b) for b, c in zip(bg or cur, cur)]
    st["bg"] = [round(v, 1) for v in st["bg"]]

    raw = max(motion, 0.8 * fg)
    usual = st.get("usual", raw)
    st["usual"] = round(usual + NORM_ALPHA * (raw - usual), 4)
    # half "a lot is changing", half "more than usual for this cam"
    score = 100 * (0.5 * min(raw / 0.2, 1) + 0.5 * min(raw / (usual + 0.02) / 3, 1))
    return int(round(score)), ""


def work(cam):
    data = fetch(cam["id"])
    st = state.get(cam["id"], {})
    if data is None:
        return cam["id"], st, None, "x"
    score, flag = analyse(cam["id"], data, st)
    st["last"] = score
    return cam["id"], st, score, flag


with cf.ThreadPoolExecutor(16) as ex:
    results = list(ex.map(work, cams))

new_state, out = {}, {}
for cam_id, st, score, flag in results:
    new_state[cam_id] = st
    if score is not None:
        out[cam_id] = [score, flag] if flag else [score]

json.dump(new_state, open(state_file, "w"), separators=(",", ":"))
json.dump({"v": 1, "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "cams": out},
          open(out_path, "w"), separators=(",", ":"))
top = sorted(((v[0], k) for k, v in out.items()), reverse=True)[:10]
names = {c["id"]: c["n"] for c in cams}
print(f"{len(out)} cams scored, {sum(1 for r in results if r[3] == 's')} promo thumbs, {sum(1 for r in results if r[3] == 'x')} failed")
for s, k in top:
    print(f"  {s:3d}  {names.get(k, k)}")
