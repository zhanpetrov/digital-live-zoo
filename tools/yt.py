"""Small helpers for reading public YouTube data without an API key (same endpoints the YouTube site uses)."""
import json
import re
import time
import urllib.request

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
_ctx = {}


def get(url, data=None, headers=None, timeout=25, tries=2):
    h = {"User-Agent": UA, "Accept-Language": "en"}
    h.update(headers or {})
    for i in range(tries):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h), timeout=timeout).read()
        except Exception:
            time.sleep(1 + i)
    return None


def client():
    """Client version and visitor id, read once from a watch page."""
    if not _ctx:
        s = (get("https://www.youtube.com/watch?v=jfKfPfyJRdk", timeout=30) or b"").decode("utf-8", "ignore")
        cv = re.search(r'"INNERTUBE_CLIENT_VERSION":"([^"]+)"', s)
        vd = re.search(r'"VISITOR_DATA":"([^"]+)"', s)
        _ctx["cv"] = cv.group(1) if cv else "2.20261002.01.00"
        _ctx["vd"] = vd.group(1) if vd else ""
    return _ctx["cv"], _ctx["vd"]


def api(endpoint, body):
    cv, vd = client()
    body = dict(body, context={"client": {"clientName": "WEB", "clientVersion": cv, "hl": "en", "gl": "US", "visitorData": vd}})
    r = get(f"https://www.youtube.com/youtubei/v1/{endpoint}?prettyPrint=false", json.dumps(body).encode(),
            {"Content-Type": "application/json", "X-Youtube-Client-Name": "1", "X-Youtube-Client-Version": cv,
             "Origin": "https://www.youtube.com"})
    if r is None:
        return None
    try:
        return json.loads(r)
    except Exception:
        return None


def _walk(o):
    if isinstance(o, dict):
        yield o
        for v in o.values():
            yield from _walk(v)
    elif isinstance(o, list):
        for v in o:
            yield from _walk(v)


def _texts(o):
    out = []
    for d in _walk(o):
        for k in ("text", "simpleText", "content"):
            if isinstance(d.get(k), str):
                out.append(d[k])
    return out


def _viewers(texts):
    for t in texts:
        m = re.match(r"^\s*([\d,.]+)\s*([KM]?)\s+watching", t)
        if m:
            n = float(m.group(1).replace(",", ""))
            return int(n * {"": 1, "K": 1000, "M": 1000000}[m.group(2)])
    return None


def videos(data):
    """Every video tile in a search / browse response: {id, title, channel, cid, live, viewers}."""
    seen, out = set(), []
    for d in _walk(data):
        v = d.get("videoRenderer") or d.get("gridVideoRenderer")
        if v and v.get("videoId"):
            vid = v["videoId"]
            title = "".join(_texts(v.get("title", {})))
            texts = _texts(v.get("viewCountText", {})) + _texts(v.get("shortViewCountText", {}))
            badges = json.dumps(v.get("badges", [])) + json.dumps(v.get("thumbnailOverlays", []))
            owner = (v.get("ownerText") or v.get("longBylineText") or {})
            ch = "".join(_texts(owner))
            cid = next((x["browseEndpoint"]["browseId"] for x in _walk(owner) if "browseEndpoint" in x), "")
            live = "LIVE" in badges or _viewers(texts) is not None
        elif "lockupViewModel" in d and d["lockupViewModel"].get("contentId"):
            v = d["lockupViewModel"]
            vid = v["contentId"]
            meta = v.get("metadata", {})
            title = next((x["content"] for x in _walk(meta) if "content" in x and isinstance(x["content"], str)), "")
            texts = _texts(meta)
            badges = json.dumps(v.get("contentImage", {}))
            ch, cid = "", next((x["browseEndpoint"]["browseId"] for x in _walk(meta) if "browseEndpoint" in x), "")
            live = "LIVE" in badges and _viewers(texts) is not None or _viewers(texts) is not None
        else:
            continue
        if vid in seen:
            continue
        seen.add(vid)
        out.append({"id": vid, "title": title, "channel": ch, "cid": cid, "live": bool(live), "viewers": _viewers(texts)})
    return out


def search_live(query):
    return [v for v in videos(api("search", {"query": query, "params": "EgJAAQ=="}) or {}) if v["live"]]


def channel_live(cid):
    """Live streams on a channel's Live tab."""
    page = (get(f"https://www.youtube.com/channel/{cid}/streams") or b"").decode("utf-8", "ignore")
    m = re.search(r"var ytInitialData\s*=\s*(\{.*?\});</script>", page, re.S)
    if not m:
        return []
    try:
        return [v for v in videos(json.loads(m.group(1))) if v["live"]]
    except Exception:
        return []


def live_status(vid):
    """(viewers, is_live) from the light metadata endpoint; (None, None) if YouTube didn't answer."""
    d = api("updated_metadata", {"videoId": vid})
    if d is None:
        return None, None
    s = json.dumps(d)
    m = re.search(r'"originalViewCount": "(\d+)"', s)
    if m:
        renderer = s[s.rfind("videoViewCountRenderer", 0, m.start()):m.start()]
        if '"isLive": true' in renderer:
            return int(m.group(1)), True
    return None, False


def watch_info(vid):
    """Facts from the watch page: embeddable, made for kids, live now, title, channel."""
    s = (get(f"https://www.youtube.com/watch?v={vid}") or b"").decode("utf-8", "ignore")
    f = lambda k: (re.search(k, s) or [None, None])[1]
    return {"embeddable": '"playableInEmbed":false' not in s, "kids": '"isFamilySafe":true' in s and '"madeForKids":true' in s,
            "live": '"isLiveNow":true' in s, "title": f(r'"title":"((?:[^"\\]|\\.)*)","lengthSeconds"'),
            "channel": f(r'"ownerChannelName":"((?:[^"\\]|\\.)*)"'), "cid": f(r'"channelId":"(UC[\w-]{22})"'),
            "ok": bool(s)}
