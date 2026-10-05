"""Learn when viewers get bored of a cam, from when they press "Next cam".

Every visit of a cam on the Main Stage is a segment: how long it was watched and how it ended.
The home page logs them to PostHog as `stage_segment` events. Ends that mean "bored of this cam"
count as events (Next cam = 1, picking another cam from the grid = 0.6); everything else (the tour
moved on, the wall opened, the tab was hidden or closed, the stream died) means "still watching
when we stopped looking" (censored).

Model: piecewise-exponential survival, i.e. a Poisson regression on (segment x time-bin) rows with
log(exposure) as offset. The chance per second that a viewer skips:

    h(t) = exp( bin[t] + act[level] + ty[habitat] + dp[daypart] + cam[id] + lv * (log10(1+viewers) - 1.5) )

  bin    - how boredom grows with time on stage (0-10 s, 10-20 s, ... 300 s+)
  act    - activity level from activity.json when it went on stage: none / low / good / hot
  ty, dp - habitat and the cam's local daypart (day, dusk, night)
  cam    - the cam itself
Fitted by Newton's method with a ridge penalty pulling every coefficient toward the page's PRIOR,
so a little data moves things a little. The page (index.html) reads attention.json, adds each
viewer's own skips on top, and holds a cam until the chance they'd still be watching falls to 60%.

Older visits are rebuilt from `cam_on_stage` events (the time to the next one, and whether that
one says the viewer skipped or picked) for sessions that have no `stage_segment` events.

Usage:
  python tools/attention.py [catalog.json] [attention.json] [--events rows.json] [--dump rows.json]
Reads PostHog with POSTHOG_API_KEY (personal API key with query:read), POSTHOG_PROJECT_ID
(numeric id; default "@current") and POSTHOG_HOST (default https://us.posthog.com).
Without a key and without --events it does nothing and leaves attention.json alone.
"""
import json
import math
import os
import sys
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import numpy as np

args = [a for a in sys.argv[1:]]
def opt(name):
    if name in args:
        i = args.index(name); v = args[i + 1]; del args[i:i + 2]; return v
    return None
events_file, dump_file = opt("--events"), opt("--dump")
catalog_path = args[0] if len(args) > 0 else "catalog.json"
out_path = args[1] if len(args) > 1 else "attention.json"

# must match index.html
BINS = [0, 10, 20, 40, 70, 120, 200, 300]
STAY = 0.6
W_END = {"skip": 1.0, "pick": 0.6}
LEVELS = ["none", "low", "good", "hot"]
TYPES = ["safari", "zoo", "aqua", "birds", "wild", "pets"]
DPS = ["day", "dusk", "night"]
B0 = math.log(-math.log(STAY) / 45)
PRIOR_ACT = {"none": 0.0, "low": 0.0, "good": -math.log(2), "hot": -2 * math.log(2)}
# ridge strength per group (bigger = harder to move away from the prior)
PEN = {"bin": 2.0, "act": 4.0, "ty": 4.0, "dp": 4.0, "cam": 3.0, "lv": 10.0}
LEGACY_MAX_S = 400      # rebuilt visits longer than this probably include time away; dropped
SESSION_GAP_S = 1800

cams = {c["id"]: c for c in json.load(open(catalog_path, encoding="utf-8"))["cams"]}

def daypart(tz, ts):
    try:
        h = datetime.fromtimestamp(ts, ZoneInfo(tz)).hour
    except Exception:
        return "day"
    return "day" if 7 <= h < 18 else "dusk" if (5 <= h < 7 or 18 <= h < 20) else "night"

def hogql(sql):
    host = os.environ.get("POSTHOG_HOST", "https://us.posthog.com").rstrip("/")
    proj = os.environ.get("POSTHOG_PROJECT_ID") or "@current"
    req = urllib.request.Request(f"{host}/api/projects/{proj}/query/", method="POST",
        data=json.dumps({"query": {"kind": "HogQLQuery", "query": sql}}).encode(),
        headers={"Authorization": "Bearer " + os.environ["POSTHOG_API_KEY"], "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)["results"]

def fetch_rows():
    seg = hogql("""SELECT toUnixTimestamp(timestamp), distinct_id, properties.$session_id, properties.cam_id, properties.habitat,
        properties.daypart, properties.act_level, properties.viewers, properties.from_s, properties.to_s, properties.end
        FROM events WHERE event = 'stage_segment' AND timestamp > now() - INTERVAL 90 DAY ORDER BY timestamp LIMIT 200000""")
    legacy = hogql("""SELECT toUnixTimestamp(timestamp), distinct_id, properties.$session_id, properties.cam_id, properties.habitat,
        properties.reason, properties.activity
        FROM events WHERE event = 'cam_on_stage' AND timestamp > now() - INTERVAL 90 DAY ORDER BY distinct_id, timestamp LIMIT 200000""")
    return {"segments": seg, "legacy": legacy}

if events_file:
    raw = json.load(open(events_file))
elif os.environ.get("POSTHOG_API_KEY"):
    raw = fetch_rows()
else:
    print("No POSTHOG_API_KEY and no --events file: attention.json left as is.")
    sys.exit(0)
if dump_file:
    json.dump(raw, open(dump_file, "w"))

# ---------- segments: (viewer, cam, habitat, daypart, act level, viewers, from, to, weight) ----------
segs = []
seg_sessions = set()
for ts, did, sid, cid, ty, dp, al, v, a, b, end in raw.get("segments", []):
    if not cid or a is None or b is None:
        continue
    a, b = float(a), float(b)
    if b - a < 1 or b > 3600:
        continue
    c = cams.get(cid, {})
    segs.append((did, cid, ty or c.get("ty"), dp or daypart(c.get("tz"), ts - (b - a)), al if al in LEVELS else "none",
                 float(v or c.get("w") or 0), a, b, W_END.get(end, 0.0)))
    if sid:
        seg_sessions.add(sid)
n_new = len(segs)

def end_of(reason):
    r = (reason or "").lower()
    if r.startswith("you skipped ahead"):
        return "skip"
    if r.startswith("you picked this cam"):
        return "pick"
    return "tour"

legacy = [r for r in raw.get("legacy", []) if r[3]]
for cur, nxt in zip(legacy, legacy[1:]):
    ts, did, sid, cid, ty, reason, act = cur
    if sid in seg_sessions or nxt[1] != did or (sid and nxt[2] != sid):
        continue
    dur = nxt[0] - ts
    if dur < 1 or dur > LEGACY_MAX_S or dur > SESSION_GAP_S:
        continue
    c = cams.get(cid, {})
    al = "none" if act in (None, "", 0) else ("good" if float(act) >= 45 else "low")
    segs.append((did, cid, ty or c.get("ty"), daypart(c.get("tz"), ts), al, float(c.get("w") or 0), 0.0, float(dur),
                 W_END.get(end_of(nxt[5]), 0.0)))
n_legacy = len(segs) - n_new
if not segs:
    print("No stage visits to learn from yet: attention.json left as is.")
    sys.exit(0)

# ---------- design matrix: one row per (segment, time bin) it covers ----------
cam_ids = sorted({s[1] for s in segs})
cols = ([("bin", k) for k in range(len(BINS))] + [("act", l) for l in LEVELS] + [("ty", t) for t in TYPES] +
        [("dp", d) for d in DPS] + [("cam", c) for c in cam_ids] + [("lv", None)])
ix = {c: i for i, c in enumerate(cols)}
prior = np.array([B0 if g == "bin" else PRIOR_ACT[k] if g == "act" else 0.0 for g, k in cols])
pen = np.array([PEN[g] for g, _ in cols])

# Poisson counts are additive, so rows with the same covariates are summed (events and exposure).
# Each row has five one-hot columns (bin, act, cam, habitat, daypart; a dummy column when unknown)
# plus the viewers term, so the Hessian is built from index pairs instead of a dense matrix.
DUMMY = len(cols)
agg = {}
for did, cid, ty, dp, al, v, a, b, w in segs:
    lv = round(math.log10(1 + v) - 1.5, 1)
    for k in range(len(BINS)):
        lo, hi = BINS[k], (BINS[k + 1] if k + 1 < len(BINS) else math.inf)
        o = min(b, hi) - max(a, lo)
        if o <= 0:
            continue
        key = (ix[("bin", k)], ix[("act", al)], ix[("cam", cid)], ix.get(("ty", ty), DUMMY), ix.get(("dp", dp), DUMMY), lv)
        e = agg.setdefault(key, [0.0, 0.0])
        e[0] += w if (lo < b <= hi) else 0.0
        e[1] += o
keys = list(agg)
I = np.array([k[:5] for k in keys], dtype=np.int64)
LV = np.array([k[5] for k in keys])
y = np.array([agg[k][0] for k in keys])
off = np.log(np.array([agg[k][1] for k in keys]))
LVI = ix[("lv", None)]
P = len(cols) + 1                                     # + dummy column, pinned at 0
prior_x, pen_x = np.append(prior, 0.0), np.append(pen, 1e9)

def linpred(beta):
    return beta[I].sum(axis=1) + beta[LVI] * LV + off

def loglik(beta):
    eta = linpred(np.append(beta, 0.0) if len(beta) < P else beta)
    return float(y @ eta - np.exp(eta).sum())

beta = prior_x.copy()
for it in range(60):
    mu = np.exp(linpred(beta))
    r = y - mu
    g = np.zeros(P)
    for a in range(5):
        np.add.at(g, I[:, a], r)
    g[LVI] += (r * LV).sum()
    g -= pen_x * (beta - prior_x)
    Hm = np.diag(pen_x)
    for a in range(5):
        for b in range(5):
            np.add.at(Hm, (I[:, a], I[:, b]), mu)
        np.add.at(Hm[:, LVI], I[:, a], mu * LV)
        np.add.at(Hm[LVI, :], I[:, a], mu * LV)
    Hm[LVI, LVI] += (mu * LV * LV).sum()
    step = np.linalg.solve(Hm, g)
    beta += step
    if np.abs(step).max() < 1e-6:
        break
beta = beta[:len(cols)]

coef = {"bin": [round(float(beta[ix[("bin", k)]]), 4) for k in range(len(BINS))],
        "act": {l: round(float(beta[ix[("act", l)]]), 4) for l in LEVELS},
        "ty": {t: round(float(beta[ix[("ty", t)]]), 4) for t in TYPES},
        "dp": {d: round(float(beta[ix[("dp", d)]]), 4) for d in DPS},
        "cam": {c: round(float(beta[ix[("cam", c)]]), 4) for c in cam_ids if abs(beta[ix[("cam", c)]]) >= 0.01},
        "lv": round(float(beta[ix[("lv", None)]]), 4)}

def dwell(e):
    target, H = -math.log(STAY), 0.0
    for k in range(len(BINS)):
        lo, hi = BINS[k], (BINS[k + 1] if k + 1 < len(BINS) else math.inf)
        r = math.exp(coef["bin"][k] + e)
        if H + r * (hi - lo) >= target:
            return min(240, max(20, lo + (target - H) / r))
        H += r * (hi - lo)
    return 240

skips = sum(s[8] for s in segs)
out = {"v": 1, "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
       "n_segments": len(segs), "n_new": n_new, "n_legacy": n_legacy, "n_viewers": len({s[0] for s in segs}),
       "n_skips": round(skips, 1), "gain": round(loglik(beta) - loglik(prior), 2),
       "w": W_END, "bins": BINS, "coef": coef}
with open(out_path, "w") as f:
    json.dump(out, f, separators=(",", ":"))

by_ty = Counter(s[2] for s in segs)
print(f"Learned from {len(segs)} visits ({n_new} logged, {n_legacy} rebuilt) by {out['n_viewers']} viewers, "
      f"{skips:.0f} skips; fit gain {out['gain']:+.1f} log-lik over prior")
for t in TYPES:
    if by_ty[t]:
        print(f"  {t:7s} {by_ty[t]:5d} visits, hold ~{dwell(coef['ty'][t] + coef['act']['none']):.0f} s with no activity data")
top = sorted(coef["cam"].items(), key=lambda kv: kv[1])
for cid, b in dict(top[:5] + top[-5:]).items():
    print(f"  cam {cid} {cams.get(cid, {}).get('n', '?')[:40]:40s} {b:+.2f} -> hold ~{dwell(b):.0f} s")
