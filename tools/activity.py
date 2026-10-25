"""Score how worth watching each cam is right now.

Signals, per cam, every run:
  look    - is there something to look at? A small CLIP model compares the live thumbnail with
            descriptions like "a bird sitting on its nest", "an animal sleeping" against
            "an empty nest", "a dark night camera image with nothing visible". Also how much
            higher that is than the cam's own norm (an empty-nest cam that suddenly has a stork).
  motion  - how much changed since the last frame / versus the cam's usual background.
  viewers - live concurrent viewers from YouTube right now (popularity) and how far above the
            cam's own normal audience that is (a spike = something is going on, maybe viral).

YouTube refreshes a live stream's thumbnail (mqdefault_live.jpg) about every five minutes.
Some channels show a fixed promo image instead; those get viewer signals only.

Writes activity.json for the site:
  {"v":2,"updated":ISO,"cams":{id:[score 0-100, flags, viewers]}}
  flags: "t" trending (viewer spike), "a" action (motion), "e" nothing to see (dark/empty/blank),
         "x" stream offline, "s" no picture signal (fixed promo thumbnail and no live storyboard)
  Cams whose thumbnail stays the same for hours get their picture from the live storyboard instead.
Keeps per-cam state in .state/ (cached between runs by the workflow, never committed).

Usage: python tools/activity.py [catalog.json] [activity.json] [.state] [clip_model.onnx]
"""
import concurrent.futures as cf
import hashlib
import io
import json
import math
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone

import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
catalog_path = sys.argv[1] if len(sys.argv) > 1 else "catalog.json"
out_path = sys.argv[2] if len(sys.argv) > 2 else "activity.json"
state_dir = sys.argv[3] if len(sys.argv) > 3 else ".state"
model_path = sys.argv[4] if len(sys.argv) > 4 else os.path.join(state_dir, "clip_vision.onnx")
os.makedirs(state_dir, exist_ok=True)
state_file = os.path.join(state_dir, "state.json")

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
W, H = 64, 36            # motion analysis size
PIX = 30                 # per-pixel change (0-255) that counts as "changed"
DARK, FLAT = 28, 10      # too dark / too uniform (blank card) to judge
SCENE_CUT = 0.55         # more than this changed = camera moved or switched angles
STATIC_SECS = 3 * 3600   # same bytes this long = promo image, not a live frame
LOOK_EMPTY = 0.3         # CLIP "something to look at" below this = nothing to see

cams = json.load(open(catalog_path, encoding="utf-8"))["cams"]
try:
    state = json.load(open(state_file))
except Exception:
    state = {}


def get(url, data=None, headers=None, timeout=20):
    h = {"User-Agent": UA, "Accept-Language": "en"}
    h.update(headers or {})
    for i in range(2):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h), timeout=timeout).read()
        except Exception:
            time.sleep(1 + i)
    return None


# ---------- viewers ----------
def innertube():
    """Client version + visitor id from one watch page, needed for the light metadata endpoint."""
    page = get(f"https://www.youtube.com/watch?v={cams[0]['id']}", timeout=30) or b""
    s = page.decode("utf-8", "ignore")
    cv = re.search(r'"INNERTUBE_CLIENT_VERSION":"([^"]+)"', s)
    vd = re.search(r'"VISITOR_DATA":"([^"]+)"', s)
    return (cv.group(1) if cv else "2.20261002.01.00"), (vd.group(1) if vd else "")


CV, VD = innertube()


def viewers(cam_id):
    body = {"context": {"client": {"clientName": "WEB", "clientVersion": CV, "hl": "en", "visitorData": VD}}, "videoId": cam_id}
    r = get("https://www.youtube.com/youtubei/v1/updated_metadata?prettyPrint=false", json.dumps(body).encode(),
            {"Content-Type": "application/json", "X-Youtube-Client-Name": "1", "X-Youtube-Client-Version": CV,
             "Origin": "https://www.youtube.com"})
    if r is None:
        return None, False
    s = r.decode("utf-8", "ignore")
    m = re.search(r'"originalViewCount":"(\d+)"', s)
    if m:
        renderer = s[s.rfind("videoViewCountRenderer", 0, m.start()):m.start()]
        if '"isLive":true' in renderer:                    # "N watching now"; "N views" means it is not live
            return int(m.group(1)), True
        return None, True
    # answered, but no live audience: the stream has ended (or this is not a live video any more)
    return None, '"updatedMetadataEndpoint"' in s or '"responseContext"' in s


# ---------- picture ----------
def thumb(cam_id):
    return get(f"https://i.ytimg.com/vi/{cam_id}/mqdefault_live.jpg?r={int(time.time())}")


# Most cam owners set a custom thumbnail, and then mqdefault_live.jpg is that fixed image, not a live frame.
# The live storyboard (the scrub-preview sprite sheets) is real frames from the stream: sheet M<n>.jpg, a
# grid of small frames, n counting up as the stream runs. Its URL template comes from the watch page.
SB_SPEC_SECS = 12 * 3600   # re-read the watch page for a fresh storyboard URL this often


def sb_spec(cam_id):
    page = get(f"https://www.youtube.com/watch?v={cam_id}", headers={"Accept-Encoding": "gzip"}, timeout=30)
    if not page:
        return None
    if page[:2] == b"\x1f\x8b":
        import gzip
        page = gzip.decompress(page)
    m = re.search(r'"playerLiveStoryboardSpecRenderer":\{"spec":"([^"]+)"', page.decode("utf-8", "ignore"))
    if not m:
        return None
    url, *dims = m.group(1).replace("\\u0026", "&").split("#")
    try:
        w, h, cols, rows = (int(x) for x in dims[:4])
    except ValueError:
        return None
    return {"url": url, "w": w, "h": h, "cols": cols, "rows": rows, "t": time.time()}


def sb_ok(spec, n):
    try:
        req = urllib.request.Request(spec["url"].replace("$M", str(n)), method="HEAD", headers={"User-Agent": UA})
        return urllib.request.urlopen(req, timeout=10).status == 200
    except Exception:
        return False


def sb_latest(spec, start):
    """Highest sheet number that exists: gallop up from the last one we saw, then bisect."""
    if start >= 1 and sb_ok(spec, start):
        lo, step = start, 1
        while step < 1 << 24 and sb_ok(spec, lo + step):
            lo, step = lo + step, step * 2
        hi = lo + step
    elif sb_ok(spec, 0):
        lo, hi = 0, 1 << 24                   # first look: plain bisection, ~24 requests
    else:
        return None
    while hi - lo > 1:
        mid = (lo + hi) // 2
        lo, hi = (mid, hi) if sb_ok(spec, mid) else (lo, mid)
    return lo


def sb_frame(cam_id, st):
    """Newest live frame from the storyboard as PNG bytes, or None."""
    spec = st.get("sb")
    if not spec or time.time() - spec.get("t", 0) > SB_SPEC_SECS:
        spec = sb_spec(cam_id) or (spec if spec and sb_ok(spec, st.get("sbn", 0)) else None)
        st["sb"] = spec
    if not spec:
        return None
    n = sb_latest(spec, st.get("sbn", 0))
    if n is None:
        st["sb"] = None                       # stale URL or stream restarted: re-read the page next run
        return None
    st["sbn"] = n
    data = get(spec["url"].replace("$M", str(n)))
    try:
        sheet = Image.open(io.BytesIO(data)).convert("RGB")
    except Exception:
        return None
    w, h = spec["w"], spec["h"]
    tiles = [sheet.crop((c * w, r * h, c * w + w, r * h + h))
             for r in range(spec["rows"]) for c in range(spec["cols"])
             if c * w + w <= sheet.width and r * h + h <= sheet.height]
    if not tiles:
        return None
    filled = [t for t in tiles if np.asarray(t.convert("L"), dtype=np.float32).std() >= FLAT]
    buf = io.BytesIO()
    (filled or tiles)[-1].save(buf, "PNG")   # the newest frame on the newest sheet
    return buf.getvalue()


def frac_changed(a, b):
    d = np.abs(a - b)
    return float(((d - np.median(d)) > PIX).mean())


def motion(st, img):
    """0-1: how much moved, relative to what is usual for this cam."""
    g = np.asarray(img.convert("L").resize((W, H), Image.BOX).filter(ImageFilter.GaussianBlur(1)), dtype=np.float32)
    def arr(k):   # tolerate missing or malformed state from older versions
        v = st.get(k)
        return np.array(v, dtype=np.float32).reshape(H, W) if isinstance(v, list) and len(v) == W * H else None
    prev, bg = arr("prev"), arr("bg")
    st["prev"] = g.astype(np.uint8).ravel().tolist()
    st["runs"] = st.get("runs", 0) + 1
    if g.mean() < DARK or g.std() < FLAT:
        return 0.0, True
    if prev is None or prev.std() < FLAT:
        st["bg"] = st["prev"]
        return 0.0, False
    m = frac_changed(g, prev)
    if m > SCENE_CUT:                       # camera moved / switched angles: interesting, but not "action"
        st["bg"] = st["prev"]
        return 0.3, False
    fg = frac_changed(g, bg) if bg is not None and st["runs"] > 3 else 0.0
    st["bg"] = (bg + 0.2 * (g - bg)).astype(np.uint8).ravel().tolist() if bg is not None else st["prev"]
    raw = max(m, 0.8 * fg)
    usual = st.get("usual", raw)
    st["usual"] = round(usual + 0.1 * (raw - usual), 4)
    return 0.5 * min(raw / 0.2, 1) + 0.5 * min(raw / (usual + 0.02) / 3, 1), False


class Clip:
    MEAN = np.array([0.48145466, 0.4578275, 0.40821073])
    STD = np.array([0.26862954, 0.26130258, 0.27577711])

    def __init__(self):
        import onnxruntime as ort
        cfg = json.load(open(os.path.join(HERE, "clip_prompts.json")))
        self.P, self.N = np.array(cfg["pos_emb"]), np.array(cfg["neg_emb"])
        self.sess = ort.InferenceSession(model_path)

    def prep(self, img):
        im = img.convert("RGB")
        im.thumbnail((224, 224), Image.BICUBIC)
        sq = Image.new("RGB", (224, 224))            # letterbox: keep the whole frame, animals sit at the edges too
        sq.paste(im, ((224 - im.width) // 2, (224 - im.height) // 2))
        return ((np.asarray(sq) / 255.0 - self.MEAN) / self.STD).transpose(2, 0, 1).astype(np.float32)

    def look(self, imgs):
        """0-1 per image: something to look at vs nothing to see."""
        out = []
        for i in range(0, len(imgs), 32):
            e = self.sess.run(None, {"pixel_values": np.stack([self.prep(x) for x in imgs[i:i + 32]])})[0]
            e = e / np.linalg.norm(e, axis=1, keepdims=True)
            def lme(x):  # mean of exp at CLIP's temperature, so 41 animal prompts don't outvote 18 empty ones
                m = x.max(1, keepdims=True)
                return (m + np.log(np.exp(100 * (x - m)).mean(1, keepdims=True)) / 100)[:, 0]
            out += (1 / (1 + np.exp(-100 * (lme(e @ self.P.T) - lme(e @ self.N.T))))).tolist()
        return out


try:
    clip = Clip()
except Exception as ex:
    print("CLIP unavailable, picture signal = motion only:", ex)
    clip = None


# ---------- run ----------
def fetch(cam):
    cam_id = cam["id"]
    st = state[cam_id]
    data = thumb(cam_id)
    if data is not None:
        h = hashlib.md5(data).hexdigest()
        now = time.time()
        if st.get("hash") != h or "since" not in st:
            st["since"] = now                                  # when this exact thumbnail first appeared
        st["hash"] = h
        st["promo"] = now - st["since"] > STATIC_SECS
        if st["promo"]:                                        # fixed image: take a real frame from the storyboard
            frame = sb_frame(cam_id, st)
            st["src"] = "sb" if frame else "promo"
            data = frame or data
        else:
            st["src"] = "thumb"
    return cam_id, data, viewers(cam_id)


for cam in cams:
    state.setdefault(cam["id"], {})
with cf.ThreadPoolExecutor(24) as ex:
    fetched = list(ex.map(fetch, cams))

fresh = []          # (id, image) whose picture changed since last run
unjudged = []       # (id, image) the picture model hasn't looked at yet (new cam, or state from an older version)
for cam_id, data, _ in fetched:
    st = state[cam_id]
    if data is None:
        continue
    h = hashlib.md5(data).hexdigest()
    st["static"] = 0 if st.get("fhash") != h else 1
    st["fhash"] = h
    try:
        img = Image.open(io.BytesIO(data))
    except Exception:
        continue
    if st["static"] == 0:
        fresh.append((cam_id, img))
    elif "look" not in st:
        unjudged.append((cam_id, img))

for cam_id, img in fresh:
    st = state[cam_id]
    st["mot"], st["blank"] = motion(st, img)
if clip and (fresh or unjudged):
    for (cam_id, _), lk in zip(fresh + unjudged, clip.look([im for _, im in fresh + unjudged])):
        st = state[cam_id]
        st["look"] = round(lk, 3)
        base = st.get("lbase", lk)
        st["lbase"] = round(base + 0.05 * (lk - base), 3)     # slow: this cam's usual picture

out, names = {}, {c["id"]: c["n"] for c in cams}
viewer_ok = 0
for cam, (cam_id, data, (v, answered)) in zip(cams, fetched):
    st = state[cam_id]
    flags = ""
    # audience
    if v is not None:
        viewer_ok += 1
        st["v"] = v
        vb = st.get("vbase", max(cam.get("w") or v, 1))
        spike = v / max(vb, 5)
        st["vbase"] = round(vb + 0.04 * (v - vb), 1)          # ~12 h memory at 30-min runs
        st["vn"] = st.get("vn", 0) + 1
    elif answered:
        flags += "x"
        spike, v = 0, 0
    else:
        v, spike = st.get("v", cam.get("w") or 0), 1.0          # couldn't ask: assume normal
    pop = min(math.log10(v + 1) / math.log10(3000), 1)
    if st.get("vn", 0) < 3:                                    # no baseline of our own yet
        spike = min(spike, 1.0)
    trending = spike >= 1.8 and v >= 80
    surge = min(max(spike - 1.3, 0) / 1.5, 1) if v >= 50 else 0

    # picture
    static = st.get("src") == "promo"                         # fixed thumbnail and no live storyboard
    look, lbase, mot = st.get("look"), st.get("lbase"), st.get("mot", 0.0)
    if static:
        flags += "s"
        look = None
    if look is not None:
        lift = max(look - (lbase or look), 0)
        pic = 0.55 * look + 0.25 * min(lift * 4, 1) + 0.2 * mot
        empty = st.get("blank") or look < LOOK_EMPTY
    else:
        pic, empty = (0.35 if static else 0.3 + 0.4 * mot), bool(st.get("blank"))
    if mot >= 0.6 and not empty:
        flags += "a"
    if trending and "x" not in flags:
        flags += "t"

    score = 100 * (0.6 * pic + 0.25 * pop + 0.15 * min(spike / 2, 1)) + 30 * surge
    if look is not None:
        score *= 0.5 + 0.5 * look                               # a big audience doesn't make an empty frame worth showing
    if empty:
        flags += "e"
        score = min(score, 15)
    if "x" in flags:
        score = 0
    out[cam_id] = [int(round(min(score, 100))), flags, v] if flags else [int(round(min(score, 100))), "", v]

json.dump(state, open(state_file, "w"), separators=(",", ":"))
json.dump({"v": 2, "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "cams": out},
          open(out_path, "w"), separators=(",", ":"))

cnt = lambda f: sum(1 for x in out.values() if f in x[1])
print(f"{len(out)} cams | fresh frames {len(fresh)} | viewers ok {viewer_ok} | trending {cnt('t')} | action {cnt('a')} "
      f"| nothing to see {cnt('e')} | offline {cnt('x')} | storyboard frames {sum(1 for c in cams if state[c['id']].get('src') == 'sb')} "
      f"| no picture {cnt('s')} | clip {'on' if clip else 'off'}")
for k, x in sorted(out.items(), key=lambda kv: -kv[1][0])[:12]:
    print(f"  {x[0]:3d} {x[1]:4s} {x[2]:6d}  {names.get(k, k)}")
