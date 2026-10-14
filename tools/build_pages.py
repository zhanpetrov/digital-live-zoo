"""Build the static, indexable pages of Digital Live Zoo from catalog.json.

  python tools/build_pages.py            # build everything
  python tools/build_pages.py --dates    # also look up stream start times on YouTube (used in CI)

Every camera is an entity with a permanent slug (data/cams.json). Its YouTube video ID can change when
the owner restarts the stream; the page URL never does. Output:

  /live/<slug>/            one page per camera (watch page)
  /animals/, /animals/<a>/ animal hubs (3+ live cams)
  /places/, /places/<c>/   country hubs (3+ live cams)
  /habitats/, /habitats/<h>/
  /sitemap.xml + /sitemaps/*.xml   only pages marked index
  /robots.txt, /slugs.json (video id -> slug, for the home page)

A cam page is indexable only when its note is approved (note_ok) and the cam is live; an animal hub
only when its intro is approved (intro_ok). Everything else is built with noindex, follow.
"""
import datetime, hashlib, html, json, os, re, shutil, sys, unicodedata, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
from taxonomy import ANIMALS, HABITATS, CONTINENTS, guess_animals, one  # noqa: E402

SITE = "https://digitallivezoo.com"
BRAND = "Digital Live Zoo"
HUB_MIN = 3
INDEX_PLACES = False      # Phase 2
INDEX_HABITATS = False    # Phase 2
OFFLINE_NOINDEX_DAYS = 30
COUNTRY_NAMES = {"USA": "United States", "UK": "United Kingdom", "DR Congo": "DR Congo"}
GENERATED_DIRS = ["live", "animals", "places", "habitats", "sitemaps"]

esc = lambda s: html.escape(str(s), quote=True)


def slugify(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = s.lower().replace("&", " and ").replace("'", "").replace("explore.org", "explore")
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:70].strip("-")


def jload(path, default):
    try:
        with open(os.path.join(ROOT, path), encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def jsave(path, data, compact=False):
    full = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(full) or ROOT, exist_ok=True)
    with open(full, "w", encoding="utf-8") as f:
        if compact:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(data, f, ensure_ascii=False, indent=1)
        f.write("\n")


def write(rel, text):
    full = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8") as f:
        f.write(text)


def country_name(k):
    return COUNTRY_NAMES.get(k, k)


# ---------------------------------------------------------------- entities
def reconcile(catalog, store, mfk):
    """Attach every catalog cam to a permanent entity; create entities for new cams."""
    ents = {e["slug"]: e for e in store.get("cams", [])}
    by_id = {i: e for e in ents.values() for i in e["ids"]}
    by_key = {(e.get("cid"), e.get("n")): e for e in ents.values()}
    day = (catalog.get("updated") or datetime.datetime.utcnow().isoformat())[:10]
    live = {}
    names = {}
    for c in catalog["cams"]:
        names.setdefault(c["n"], []).append(c)
    for c in catalog["cams"]:
        if c["id"] in mfk:
            continue
        e = by_id.get(c["id"]) or by_key.get((c.get("cid"), c["n"]))
        if e is None:
            base = slugify(c["n"])
            place0 = slugify(c["p"].split(",")[0])
            generic = ("," not in c["n"] and len(c["n"].split()) <= 3) or len(names[c["n"]]) > 1
            if generic and place0 and place0 not in base:
                base = f"{base}-{place0}"
            slug, k = base, 2
            while slug in ents:
                slug, k = f"{base}-{k}", k + 1
            e = {"slug": slug, "ids": [], "cid": c.get("cid"), "n": c["n"], "animals": guess_animals(c["n"]),
                 "species": [], "note": "", "note_ok": False, "added": day, "seen": []}
            ents[slug] = e
        if c["id"] not in e["ids"]:
            e["ids"].append(c["id"])
        e["n"], e["cid"] = c["n"], c.get("cid")
        if day not in e["seen"]:
            e["seen"] = (e["seen"] + [day])[-60:]
        live[e["slug"]] = c
    store["cams"] = sorted(ents.values(), key=lambda e: e["slug"])
    return ents, live


def stream_starts(video_ids):
    """Start time of each live stream. Uses the YouTube Data API when YT_API_KEY is set (CI);
    otherwise reads the watch page, which YouTube often blocks from data centres."""
    out, key = {}, os.environ.get("YT_API_KEY", "").strip()
    ids = list(dict.fromkeys(video_ids))
    if key:
        for i in range(0, len(ids), 50):
            q = urllib.parse.urlencode({"part": "liveStreamingDetails,snippet", "id": ",".join(ids[i:i + 50]), "key": key})
            try:
                data = json.load(urllib.request.urlopen("https://www.googleapis.com/youtube/v3/videos?" + q, timeout=30))
            except Exception as ex:
                print(f"  YouTube API: {ex}")
                continue
            for v in data.get("items", []):
                t = (v.get("liveStreamingDetails") or {}).get("actualStartTime") or (v.get("snippet") or {}).get("publishedAt")
                if t:
                    out[v["id"]] = t
        return out
    for vid in ids:
        try:
            req = urllib.request.Request(f"https://www.youtube.com/watch?v={vid}",
                                         headers={"User-Agent": "Mozilla/5.0", "Accept-Language": "en-US,en;q=0.8"})
            page = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "replace")
        except Exception as ex:
            print(f"  start time for {vid}: {ex}")
            continue
        for pat in (r'"startTimestamp":"([^"]+)"', r'"uploadDate":"([^"]+)"'):
            m = re.search(pat, page)
            if m:
                out[vid] = m.group(1)
                break
    return out


# ---------------------------------------------------------------- html pieces
POSTHOG = None


def posthog_snippet():
    global POSTHOG
    if POSTHOG is None:
        src = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
        m = re.search(r"<script>\s*!function\(t,e\)\{var o,n,p,r;.*?posthog\.init\([^)]*\);\s*</script>", src, re.S)
        POSTHOG = m.group(0) if m else ""
    return POSTHOG


def head(title, desc, path, robots, og_image=None, og_type="website", jsonld=None):
    url = SITE + path
    parts = [
        "<!doctype html>", '<html lang="en">', "<head>", '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
        f"<title>{esc(title)}</title>",
        f'<meta name="description" content="{esc(desc)}">',
        f'<link rel="canonical" href="{esc(url)}">',
        f'<meta name="robots" content="{robots}">',
        f'<meta property="og:site_name" content="{BRAND}">',
        f'<meta property="og:title" content="{esc(title)}">',
        f'<meta property="og:description" content="{esc(desc)}">',
        f'<meta property="og:type" content="{og_type}">',
        f'<meta property="og:url" content="{esc(url)}">',
    ]
    if og_image:
        parts += [f'<meta property="og:image" content="{esc(og_image)}">', '<meta name="twitter:card" content="summary_large_image">']
    parts += [
        '<link rel="preconnect" href="https://fonts.googleapis.com">',
        '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Stencil+Display:wght@800&family=Figtree:wght@400;600;700&family=JetBrains+Mono:wght@400;500&display=swap">',
        '<link rel="stylesheet" href="/assets/pages.css">',
    ]
    if jsonld:
        parts.append('<script type="application/ld+json">' + json.dumps(jsonld, ensure_ascii=False).replace("</", "<\\/") + "</script>")
    parts += [posthog_snippet(), "</head>", "<body>"]
    return "\n".join(p for p in parts if p)


TOP = ('<header class="top"><a class="logo" href="/">Digital Live Zoo</a>'
       '<nav aria-label="Sections"><a href="/animals/">Animals</a><a href="/places/">Places</a><a href="/habitats/">Habitats</a></nav></header>')


def foot():
    return ('<footer class="foot"><a href="/">Watch the whole zoo</a> · <a href="/animals/">All animals</a> · '
            '<a href="/about.html">About</a> · <a href="/privacy.html">Privacy</a><p>Every stream plays from its owner\'s channel through YouTube\'s player. '
            'Digital Live Zoo is not affiliated with the zoos, parks and people who run these cams.</p></footer>'
            '<script src="/assets/pages.js" defer></script></body></html>\n')


def crumbs(items):
    """items: [(name, path or None)]. Returns (html, jsonld)."""
    out, ld = [], []
    for i, (name, path) in enumerate(items, 1):
        out.append(f'<a href="{path}">{esc(name)}</a>' if path else f'<span aria-current="page">{esc(name)}</span>')
        li = {"@type": "ListItem", "position": i, "name": name}
        if path:
            li["item"] = SITE + path
        ld.append(li)
    return ('<nav class="crumbs" aria-label="Breadcrumb">' + " <i>›</i> ".join(out) + "</nav>",
            {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": ld})


def thumb(vid, size="mqdefault_live"):
    return f"https://i.ytimg.com/vi/{vid}/{size}.jpg"


def card(e, c, sub=None):
    vid = c["id"]
    sub = sub or c["p"]
    return (f'<a class="card" href="/live/{e["slug"]}/"><span class="th"><img loading="lazy" src="{thumb(vid)}" alt="" width="320" height="180">'
            f'<span class="badge" data-act="{vid}" hidden></span></span><span class="cb"><b>{esc(c["n"])}</b>'
            f'<span class="where">{esc(sub)}</span><span class="when" data-tz="{esc(c["tz"])}"></span></span></a>')


def grid(cards):
    return '<div class="grid">' + "".join(cards) + "</div>"


# ---------------------------------------------------------------- pages
def cam_page(e, c, ctx):
    """c is the live catalog row, or None when the cam is offline."""
    slug = e["slug"]
    path = f"/live/{slug}/"
    last = c or ctx["last_rows"].get(slug)
    name = e["n"]
    place = last["p"] if last else ""
    city = place.split(",")[0].strip()
    vid = c["id"] if c else e["ids"][-1]
    animals = [a for a in e.get("animals", []) if a in ANIMALS]
    a0 = animals[0] if animals else None
    hub_a = a0 if a0 in ctx["animal_hubs"] else None
    offline_days = 0
    if not c and e.get("seen"):
        offline_days = (ctx["today"] - datetime.date.fromisoformat(e["seen"][-1])).days
    indexable = bool(c and e.get("note_ok") and e.get("note"))
    robots = "index, follow, max-image-preview:large" if indexable else "noindex, follow"

    title = e.get("title") or (f"{name} live cam" + ("" if city.lower() in name.lower() else f", {city}") + f" · {BRAND}")
    if e.get("desc"):
        desc = e["desc"]
    else:
        desc = f"Live cam: {name}" + (f", {place}" if place and city.lower() not in name.lower() else "") + f". Local time and what's happening now, on {BRAND}."
    h1 = e.get("h1") or name

    trail = [("Home", "/")]
    if hub_a:
        trail.append((ANIMALS[hub_a], f"/animals/{hub_a}/"))
    elif last:
        trail.append((HABITATS[last["ty"]][0], f"/habitats/{last['ty']}/"))
    trail.append((e.get("crumb") or (name.split(",")[-1].strip() if "," in name else name), None))
    crumb_html, crumb_ld = crumbs(trail)

    ld = [crumb_ld]
    started = (e.get("started") or {}).get(vid)
    if c and started:
        vo = {"@context": "https://schema.org", "@type": "VideoObject", "name": e.get("video_name") or f"{name} live cam",
              "description": e.get("note") or desc, "thumbnailUrl": thumb(vid, "hqdefault_live"), "uploadDate": started,
              "embedUrl": f"https://www.youtube.com/embed/{vid}"}
        if place:
            vo["contentLocation"] = {"@type": "Place", "name": place}
        ld.insert(0, vo)

    b = [head(title, desc, path, robots, og_image=thumb(vid, "hqdefault_live"), og_type="video.other", jsonld=ld), TOP, '<main class="wrap">', crumb_html]
    b.append(f'<h1>{esc(h1)}</h1>')
    kicker = [esc(place)] if place else []
    if last:
        kicker.append(f'<a href="/habitats/{last["ty"]}/">{esc(HABITATS[last["ty"]][0])}</a>')
    b.append('<p class="kicker">' + " · ".join(kicker) + "</p>")
    if c:
        b.append(f'<div class="player"><iframe src="https://www.youtube.com/embed/{vid}?autoplay=1&amp;mute=1&amp;playsinline=1&amp;rel=0" '
                 f'title="{esc(name)}, live stream" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>')
    else:
        b.append(f'<div class="offline"><b>This cam is off air.</b> It was last seen live on {e["seen"][-1] if e.get("seen") else "an earlier day"}. '
                 'Owners restart streams often; the zoo checks every day and brings it back here when it returns.</div>')

    facts = []
    if place:
        facts.append(("Where", esc(place)))
    if last:
        facts.append(("Local time", f'<span data-tz="{esc(last["tz"])}" data-long></span>'))
    if c:
        w = c.get("w") or 0
        facts.append(("Watching", f'<span data-watch="{vid}">{(f"{w:,} at the last check") if w else "a few people"}</span>'))
        facts.append(("Right now", f'<span data-now="{vid}">Checking…</span>'))
    if e.get("species"):
        facts.append(("Species", esc(", ".join(e["species"]))))
    if last and last.get("cid"):
        facts.append(("Stream by", f'<a href="https://www.youtube.com/channel/{esc(last["cid"])}" rel="noopener" target="_blank">{esc(last.get("ch") or "the owner")}</a> on YouTube'))
    b.append('<dl class="facts">' + "".join(f"<dt>{k}</dt><dd>{v}</dd>" for k, v in facts) + "</dl>")

    if e.get("note"):
        b.append(f'<section class="about"><h2>About this cam</h2><p>{esc(e["note"])}</p></section>')
    days = [d for d in e.get("seen", []) if (ctx["today"] - datetime.date.fromisoformat(d)).days < 30]
    rec = ""
    if e.get("added"):
        rec = "In the zoo since " + datetime.date.fromisoformat(e["added"]).strftime("%B %-d, %Y") + ". "
    if len(e.get("seen", [])) >= 7:
        rec = f"Seen live on {len(days)} of the last 30 days. " + rec
    if c:
        b.append(f'<p class="record">{rec}<a href="/#{vid}">Watch it on the Main Stage</a>.</p>')

    # related
    rel_html = []
    if hub_a:
        same = [s for s in ctx["animal_hubs"][hub_a] if s != slug][:6]
        if same:
            rel_html.append(f'<section><h2>More {esc(one(hub_a))} cams</h2>' + grid(card(ctx["ents"][s], ctx["live"][s]) for s in same)
                            + f'<p class="more"><a href="/animals/{hub_a}/">All {len(ctx["animal_hubs"][hub_a])} {esc(one(hub_a))} cams</a></p></section>')
    if last:
        k = last.get("k")
        near = [s for s in ctx["country_cams"].get(k, []) if s != slug and (not hub_a or s not in ctx["animal_hubs"][hub_a])][:3]
        if near:
            cpath = f"/places/{slugify(country_name(k))}/" if k in ctx["country_hubs"] else None
            more = f'<p class="more"><a href="{cpath}">All cams in {esc(country_name(k))}</a></p>' if cpath else ""
            rel_html.append(f'<section><h2>Also in {esc(country_name(k))}</h2>' + grid(card(ctx["ents"][s], ctx["live"][s]) for s in near) + more + "</section>")
    b += rel_html
    b.append("</main>")
    b.append(foot())
    core = json.dumps([title, desc, h1, e.get("note"), vid, robots, [x for x in rel_html]], ensure_ascii=False)
    return path, "\n".join(b), indexable, core


def hub_page(kind, key, slugs, ctx, title, desc, h1, intro, indexable, trail, extra=""):
    path = f"/{kind}/{key}/"
    robots = "index, follow" if indexable else "noindex, follow"
    crumb_html, crumb_ld = crumbs(trail)
    first = ctx["live"][slugs[0]]["id"] if slugs else None
    b = [head(title, desc, path, robots, og_image=thumb(first, "hqdefault_live") if first else None, jsonld=[crumb_ld]), TOP, '<main class="wrap">', crumb_html,
         f"<h1>{esc(h1)}</h1>"]
    if intro:
        b.append(f'<p class="intro">{esc(intro)}</p>')
    b.append(f'<p class="count">{len(slugs)} live cams, most watched first. Local times are live.</p>')

    def sub(s):
        e, c = ctx["ents"][s], ctx["live"][s]
        sp = ", ".join(e.get("species", []))
        return f"{sp} · {c['p']}" if sp and kind == "animals" else c["p"]
    b.append(grid(card(ctx["ents"][s], ctx["live"][s], sub(s)) for s in slugs))
    b.append(extra)
    b.append("</main>")
    b.append(foot())
    return path, "\n".join(b), indexable, json.dumps([title, desc, h1, intro, slugs, robots, extra], ensure_ascii=False)


def index_page(kind, title, desc, h1, intro, groups, indexable, trail):
    """groups: [(heading or None, [(href, name, count, video_id)])]."""
    path = f"/{kind}/"
    robots = "index, follow" if indexable else "noindex, follow"
    crumb_html, crumb_ld = crumbs(trail)
    b = [head(title, desc, path, robots, jsonld=[crumb_ld]), TOP, '<main class="wrap">', crumb_html, f"<h1>{esc(h1)}</h1>", f'<p class="intro">{esc(intro)}</p>']
    for heading, items in groups:
        if heading:
            b.append(f"<h2>{esc(heading)}</h2>")
        b.append('<div class="grid hubs">' + "".join(
            f'<a class="card" href="{href}"><span class="th"><img loading="lazy" src="{thumb(v)}" alt="" width="320" height="180"></span>'
            f'<span class="cb"><b>{esc(name)}</b><span class="where">{n} live cams</span></span></a>' for href, name, n, v in items) + "</div>")
    b.append("</main>")
    b.append(foot())
    return path, "\n".join(b), indexable, json.dumps([title, desc, intro, groups, robots], ensure_ascii=False)


# ---------------------------------------------------------------- build
def build(fetch_dates=False):
    catalog = jload("catalog.json", None)
    if not catalog:
        sys.exit("catalog.json missing")
    mfk = set((jload("mfk.json", {}) or {}).get("ids", []))
    store = jload("data/cams.json", {"v": 1, "cams": []})
    hubs_cfg = jload("data/hubs.json", {"animals": {}})
    state = jload("data/pages.json", {})
    today = datetime.date.fromisoformat((catalog.get("updated") or datetime.date.today().isoformat())[:10])

    ents, live = reconcile(catalog, store, mfk)
    last_rows = {e["slug"]: next((c for c in catalog["cams"] if c["id"] in e["ids"]), None) for e in ents.values()}
    # an offline cam keeps the last row it had, saved in the store
    for e in store["cams"]:
        if e["slug"] in live:
            r = live[e["slug"]]
            e["last"] = {k: r.get(k) for k in ("p", "tz", "ty", "c", "k", "ch", "cid")}
        if not last_rows.get(e["slug"]) and e.get("last"):
            last_rows[e["slug"]] = dict(e["last"], n=e["n"], id=e["ids"][-1], w=0)

    if fetch_dates:
        need = {e["slug"]: live[e["slug"]]["id"] for e in store["cams"]
                if e["slug"] in live and e.get("note_ok") and live[e["slug"]]["id"] not in (e.get("started") or {})}
        got = stream_starts(need.values()) if need else {}
        print(f"stream start times: {len(got)} of {len(need)} needed")
        for e in store["cams"]:
            vid = need.get(e["slug"])
            if vid and vid in got:
                e["started"] = {vid: got[vid]}

    by_w = lambda s: -(live[s].get("w") or 0)
    animal_cams = {}
    for s, e in ents.items():
        if s in live:
            for a in e.get("animals", []):
                animal_cams.setdefault(a, []).append(s)
    animal_hubs = {a: sorted(v, key=by_w) for a, v in animal_cams.items() if len(v) >= HUB_MIN and a in ANIMALS}
    country_cams, habitat_cams = {}, {}
    for s, c in live.items():
        if c.get("k"):
            country_cams.setdefault(c["k"], []).append(s)
        habitat_cams.setdefault(c["ty"], []).append(s)
    for d in (country_cams, habitat_cams):
        for k in d:
            d[k].sort(key=by_w)
    country_hubs = {k: v for k, v in country_cams.items() if len(v) >= HUB_MIN}
    ctx = dict(ents=ents, live=live, animal_hubs=animal_hubs, country_cams=country_cams, country_hubs=country_hubs,
               today=today, last_rows=last_rows)

    pages = []  # (path, html, indexable, core)
    for s, e in ents.items():
        c = live.get(s)
        if not c and not last_rows.get(s):
            continue
        pages.append(cam_page(e, c, ctx))

    # animal hubs
    habitat_of = {}
    for a, slugs in animal_hubs.items():
        tys = [live[s]["ty"] for s in slugs]
        habitat_of[a] = max(sorted(set(tys)), key=tys.count)
    for a, slugs in animal_hubs.items():
        cfg = hubs_cfg.get("animals", {}).get(a, {})
        name = ANIMALS[a]
        related = [x for x in animal_hubs if x != a and habitat_of[x] == habitat_of[a]]
        related.sort(key=lambda x: -len(animal_hubs[x]))
        extra = ""
        if related:
            extra = '<section><h2>Related animals</h2><p class="chips">' + "".join(
                f'<a href="/animals/{x}/">{esc(ANIMALS[x])} <small>{len(animal_hubs[x])}</small></a>' for x in related[:8]) + "</p></section>"
        countries = sorted({country_name(live[s]["k"]) for s in slugs if live[s].get("k")})
        title = (cfg.get("title") or f"{name} live cams: {{n}} cameras · {BRAND}").replace("{n}", str(len(slugs)))
        desc = (cfg.get("desc") or "").replace("{n}", str(len(slugs))) or f"Watch {len(slugs)} live {name.lower()} cams from {', '.join(countries[:4])}{' and more' if len(countries) > 4 else ''}, with local time and what's happening now."
        pages.append(hub_page("animals", a, slugs, ctx, title, desc, cfg.get("h1") or f"{name}: live cams", cfg.get("intro", ""),
                              bool(cfg.get("intro_ok") and cfg.get("intro")), [("Home", "/"), ("Animals", "/animals/"), (name, None)], extra))

    groups = {}
    for a in sorted(animal_hubs, key=lambda x: -len(animal_hubs[x])):
        groups.setdefault(HABITATS[habitat_of[a]][0], []).append((f"/animals/{a}/", ANIMALS[a], len(animal_hubs[a]), live[animal_hubs[a][0]]["id"]))
    order = [HABITATS[h][0] for h in HABITATS]
    pages.append(index_page("animals", f"Live animal cams by animal · {BRAND}",
                            f"{len(animal_hubs)} animals with live cams right now: penguins, eagles, bears, elephants, sharks and more.",
                            "Live cams by animal", "Pick an animal to see every live cam we found for it, around the world. Local times update live.",
                            [(h, groups[h]) for h in order if h in groups], True, [("Home", "/"), ("Animals", None)]))

    # country hubs
    cont_groups = {}
    for k, slugs in country_hubs.items():
        cname = country_name(k)
        key = slugify(cname)
        pages.append(hub_page("places", key, slugs, ctx, f"Live animal cams in {cname}: {len(slugs)} cameras · {BRAND}",
                              f"Watch {len(slugs)} live animal cams in {cname}, with local time and what's happening now.",
                              f"Live animal cams in {cname}", "", INDEX_PLACES, [("Home", "/"), ("Places", "/places/"), (cname, None)]))
        cont = live[slugs[0]]["c"]
        cont_groups.setdefault(cont, []).append((f"/places/{key}/", cname, len(slugs), live[slugs[0]]["id"]))
    pages.append(index_page("places", f"Live animal cams by country · {BRAND}", "Live animal cams grouped by country and continent.",
                            "Live cams by place", "Countries with three or more live cams. Smaller ones are on the home page.",
                            [(cn, sorted(cont_groups[cn], key=lambda t: -t[2])) for cn in CONTINENTS if cn in cont_groups], INDEX_PLACES,
                            [("Home", "/"), ("Places", None)]))

    # habitat hubs
    hab_items = []
    for h, (hname, hdesc) in HABITATS.items():
        slugs = habitat_cams.get(h, [])
        if not slugs:
            continue
        pages.append(hub_page("habitats", h, slugs, ctx, f"{hname}: {len(slugs)} live cams · {BRAND}", f"Live cams from {hdesc}, with local time and what's happening now.",
                              f"{hname}: live cams", "", INDEX_HABITATS, [("Home", "/"), ("Habitats", "/habitats/"), (hname, None)]))
        hab_items.append((f"/habitats/{h}/", hname, len(slugs), live[slugs[0]]["id"]))
    pages.append(index_page("habitats", f"Live animal cams by habitat · {BRAND}", "Live animal cams grouped by habitat.", "Live cams by habitat",
                            "Safari waterholes, zoos, aquariums, nests, forests and farms.", [(None, hab_items)], INDEX_HABITATS, [("Home", "/"), ("Habitats", None)]))

    # home page: a plain list of animal hubs that crawlers can follow without running JavaScript
    home = os.path.join(ROOT, "index.html")
    src = open(home, encoding="utf-8").read()
    links = "".join(f'<a href="/animals/{a}/">{esc(ANIMALS[a])}</a>' for a in sorted(animal_hubs, key=lambda x: -len(animal_hubs[x])))
    out = re.sub(r"<!--hubs:start-->.*?<!--hubs:end-->", lambda m: f"<!--hubs:start--><p>{links}</p><!--hubs:end-->", src, flags=re.S)
    if out != src:
        with open(home, "w", encoding="utf-8") as f:
            f.write(out)

    # write, removing generated pages that no longer exist
    for d in GENERATED_DIRS:
        shutil.rmtree(os.path.join(ROOT, d), ignore_errors=True)
    new_state = {}
    day = datetime.date.today().isoformat()
    for path, text, indexable, core in pages:
        write(path.lstrip("/") + "index.html", text)
        h = hashlib.sha1(core.encode()).hexdigest()[:12]
        old = state.get(path)
        new_state[path] = {"h": h, "mod": old["mod"] if old and old["h"] == h else day, "index": indexable}
    home_h = hashlib.sha1(open(os.path.join(ROOT, "index.html"), "rb").read()).hexdigest()[:12]
    old = state.get("/")
    new_state["/"] = {"h": home_h, "mod": old["mod"] if old and old["h"] == home_h else day, "index": True}

    def urlset(paths):
        rows = "".join(f"<url><loc>{SITE}{p}</loc><lastmod>{new_state[p]['mod']}</lastmod></url>" for p in sorted(paths))
        return f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{rows}</urlset>\n'
    idx = [p for p, v in new_state.items() if v["index"]]
    live_paths = [p for p in idx if p.startswith("/live/")]
    hub_paths = [p for p in idx if not p.startswith("/live/")]
    write("sitemaps/hubs.xml", urlset(hub_paths))
    write("sitemaps/live.xml", urlset(live_paths))
    mods = {"hubs": max([new_state[p]["mod"] for p in hub_paths] or [day]), "live": max([new_state[p]["mod"] for p in live_paths] or [day])}
    write("sitemap.xml", '<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
          + "".join(f"<sitemap><loc>{SITE}/sitemaps/{n}.xml</loc><lastmod>{m}</lastmod></sitemap>" for n, m in mods.items()) + "</sitemapindex>\n")
    write("robots.txt", f"User-agent: *\nAllow: /\n\nSitemap: {SITE}/sitemap.xml\n")
    jsave("slugs.json", {c["id"]: s for s, c in live.items()}, compact=True)
    jsave("data/cams.json", store)
    jsave("data/pages.json", new_state)

    orphans = [p for p, v in new_state.items() if v["index"] and p.startswith("/live/") and not any(
        p in t for q, t, _, _ in pages if q != p)]
    print(f"{len(pages)} pages, {len(idx)} indexable ({len(live_paths)} cam pages), "
          f"{len(animal_hubs)} animal hubs, {len(country_hubs)} country hubs, {sum(1 for s in ents if s not in live)} offline cams"
          + (f"; ORPHANS: {orphans}" if orphans else ""))
    if orphans:
        sys.exit(1)


if __name__ == "__main__":
    build(fetch_dates="--dates" in sys.argv)
