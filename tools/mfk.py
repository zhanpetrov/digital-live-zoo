"""Write mfk.json: the cams in catalog.json that YouTube marks Made for Kids.

YouTube's API Services Developer Policies require tracking to be turned off for every embedded video
designated Made for Kids. The site has analytics and an ad slot, so it leaves those cams out instead.
Needs a YouTube Data API v3 key in the YT_API_KEY environment variable (one unit per 50 cams).
"""
import json, os, sys, urllib.request, urllib.parse, datetime

def main(catalog="catalog.json", out="mfk.json"):
    key = os.environ.get("YT_API_KEY", "").strip()
    if not key:
        print("YT_API_KEY not set, skipping"); return 0
    ids = [c["id"] for c in json.load(open(catalog, encoding="utf-8"))["cams"]]
    mfk, seen = [], set()
    for i in range(0, len(ids), 50):
        q = urllib.parse.urlencode({"part": "status", "id": ",".join(ids[i:i+50]), "key": key, "maxResults": 50})
        with urllib.request.urlopen("https://www.googleapis.com/youtube/v3/videos?" + q, timeout=30) as r:
            for v in json.load(r).get("items", []):
                seen.add(v["id"])
                if v.get("status", {}).get("madeForKids"):
                    mfk.append(v["id"])
    old = None
    try: old = json.load(open(out, encoding="utf-8"))
    except Exception: pass
    if old and sorted(old.get("ids", [])) == sorted(mfk):
        print(f"unchanged: {len(mfk)} of {len(seen)} checked are Made for Kids"); return 0
    json.dump({"updated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
               "checked": len(seen), "ids": sorted(mfk)}, open(out, "w", encoding="utf-8"), separators=(",", ":"))
    print(f"{len(mfk)} of {len(seen)} checked are Made for Kids")
    return 0

if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:]))
