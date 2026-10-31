"""Readable pages for the 100 Field Station expeditions, so search engines (and people without JavaScript) see them.

The Field Station itself is one JavaScript app; its text lives in field-station/expeditions-data.js and has no URLs
of its own. This writes, from that same data (no new text):
  /field-station/e/                 all expeditions by region
  /field-station/e/<id>/            English: the place, what to look for and why, the science note and its source,
                                    a question to talk about, the field quiz with answers, and the matching live cam
  /field-station/e/<id>/ru/         the same in Russian
Each page links to the 360° expedition itself (/field-station/?exp=<id>). Called from tools/build_pages.py, which puts
the pages in the sitemap.
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "field-station", "expeditions-data.js")

T = {
    "en": {
        "all": "All Field Station expeditions", "station": "Field Station", "start": "Start the 360° expedition",
        "film": "Watch the 360° film", "about": "About this place", "kids": "For kids", "look": "What to look for",
        "sci": "The science", "source": "Source", "ask": "Ask together", "quiz": "Field quiz", "answer": "Answer",
        "kids_q": "Kids' question", "pro_q": "Adults' question", "live": "See it live", "day": "By day", "night": "By night",
        "watch_live": "Watch the live cam", "region": "Region", "habitat": "Habitat", "other": "Other language",
        "index_h1": "Field Station: 100 expeditions", "stops": "stops",
        "index_intro": ("Every expedition is a 360° visit to a real wild place, with things to find, the science behind them, "
                        "a question to talk about together and a live cam of the same place. Each one has a version for kids "
                        "and one for adults, in English and Russian."),
        "lang_name": "English", "credit": "360° photo",
    },
    "ru": {
        "all": "Все экспедиции Полевой станции", "station": "Полевая станция", "start": "Начать экспедицию 360°",
        "film": "Смотреть фильм 360°", "about": "Об этом месте", "kids": "Для детей", "look": "Что искать",
        "sci": "Наука", "source": "Источник", "ask": "Спросите вместе", "quiz": "Полевая викторина", "answer": "Ответ",
        "kids_q": "Вопрос для детей", "pro_q": "Вопрос для взрослых", "live": "Смотреть вживую", "day": "Днём", "night": "Ночью",
        "watch_live": "Открыть живую камеру", "region": "Регион", "habitat": "Среда", "other": "Другой язык",
        "index_h1": "Полевая станция: 100 экспедиций", "stops": "остановки",
        "index_intro": ("Каждая экспедиция — это визит в 360° в настоящее дикое место: что найти, наука за этим, вопрос, "
                        "который стоит обсудить вместе, и живая камера того же места. У каждой есть версия для детей и для "
                        "взрослых, на русском и английском."),
        "lang_name": "Русский", "credit": "Фото 360°",
    },
}
# sentences about the app itself ("Tap Play to hear Anna's voice guide…") are not part of the article
APP_TALK = re.compile(r"ElevenLabs|\bTap\b|\bPlay\b|\bpan\b|\bpanning\b|Нажми|Нажмите|голосов|озвучк|сфер[уеы]", re.I)


def load():
    src = open(DATA, encoding="utf-8").read()
    start = src.index("{", src.index("DLZ_EXPEDITIONS_DATA"))
    return json.loads(src[start:src.rstrip().rstrip(";").rindex("}") + 1])


def pick(v, lang, mode="pro"):
    """Resolve {en, ru} and {junior, pro} objects the way the app does."""
    while isinstance(v, dict):
        if "en" in v or "ru" in v:
            v = v.get(lang, v.get("en"))
        elif "junior" in v or "pro" in v:
            v = v.get(mode, v.get("junior"))
        else:
            break
    return v


def prose(text):
    if not isinstance(text, str):
        return ""
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return " ".join(p for p in parts if p and not APP_TALK.search(p))


def build(head, foot, esc, cam_slugs):
    """head/foot/esc from build_pages. Returns [(path, html, indexable, core)] like build_pages' own page list."""
    data = load()
    regions = {r["id"]: r for r in data.get("regions", [])}
    exps = [x for x in data.get("expeditions", []) if x.get("open", True)]
    out = []

    def alt_links(en_path, ru_path):
        return (f'<link rel="alternate" hreflang="en" href="https://digitallivezoo.com{en_path}">'
                f'<link rel="alternate" hreflang="ru" href="https://digitallivezoo.com{ru_path}">'
                f'<link rel="alternate" hreflang="x-default" href="https://digitallivezoo.com{en_path}">')

    def page_head(lang, title, desc, path, en_path, ru_path, image=None):
        h = head(title, desc, path, "index, follow", og_image=image)
        h = h.replace('<html lang="en">', f'<html lang="{lang}">', 1)
        return h.replace("</head>", alt_links(en_path, ru_path) + "</head>", 1)

    top = ('<header class="top"><a class="logo" href="/">Digital Live Zoo</a><nav aria-label="Sections">'
           '<a href="/field-station/">Field Station</a><a href="/field-station/e/">Expeditions</a><a href="/animals/">Animals</a></nav></header>')

    for lang in ("en", "ru"):
        t = T[lang]
        suffix = "" if lang == "en" else "ru/"
        # ---- one page per expedition
        for x in exps:
            xid = x["id"]
            path = f"/field-station/e/{xid}/{suffix}"
            en_path, ru_path = f"/field-station/e/{xid}/", f"/field-station/e/{xid}/ru/"
            name, place = pick(x["name"], lang), pick(x["place"], lang)
            reg = regions.get(x.get("region"), {})
            blurb_pro, blurb_kid = prose(pick(x.get("blurb"), lang, "pro")), prose(pick(x.get("blurb"), lang, "junior"))
            image = "https://digitallivezoo.com/field-station/" + x["img"] if x.get("img") else None
            start = f"/field-station/?exp={xid}" + ("&lang=ru" if lang == "ru" else "")
            b = [f'<nav class="crumbs" aria-label="Breadcrumb"><a href="/field-station/">{t["station"]}</a> <i>›</i> '
                 f'<a href="/field-station/e/{suffix}">{t["all"]}</a> <i>›</i> <span aria-current="page">{esc(name)}</span></nav>',
                 f"<h1>{esc(name)}</h1>",
                 f'<p class="kicker">{esc(place)} · {esc(reg.get(lang, reg.get("en", "")))} · {esc(x.get("biome", ""))}</p>']
            if image:
                b.append(f'<p><a href="{start}"><img src="{esc(image)}" alt="{esc(name)}" width="960" height="480" '
                         f'style="width:100%;height:auto;border-radius:14px" loading="eager"></a></p>')
            b.append(f'<p class="more"><a href="{start}"><b>{t["film"] if x.get("hasVideo360") else t["start"]} →</b></a></p>')
            if blurb_pro:
                b.append(f'<section class="about"><h2>{t["about"]}</h2><p>{esc(blurb_pro)}</p>'
                         + (f'<p><b>{t["kids"]}:</b> {esc(blurb_kid)}</p>' if blurb_kid and blurb_kid != blurb_pro else "") + "</section>")
            words = len(blurb_pro.split()) + len(blurb_kid.split())
            for s in x.get("stops", []):
                st = esc(pick(s.get("title"), lang) or "")
                if s.get("type") == "live":
                    slug = s.get("slug")
                    link = f"/live/{slug}/" if slug in cam_slugs else (f'https://www.youtube.com/watch?v={s["fallbackId"]}' if s.get("fallbackId") else "")
                    day, night = pick(s.get("speciesDay"), lang), pick(s.get("speciesNight"), lang)
                    fd, fn = prose(pick(s.get("factDay"), lang)), prose(pick(s.get("factNight"), lang))
                    b.append(f'<section><h2>{t["live"]}: {st}</h2><dl class="facts">'
                             + (f"<dt>{t['day']}</dt><dd>{esc(day)}{(' ' + esc(fd)) if fd else ''}</dd>" if day else "")
                             + (f"<dt>{t['night']}</dt><dd>{esc(night)}{(' ' + esc(fn)) if fn else ''}</dd>" if night else "")
                             + "</dl>" + (f'<p class="more"><a href="{esc(link)}">{t["watch_live"]} →</a></p>' if link else "") + "</section>")
                    words += len(str(day).split()) + len(str(night).split())
                    continue
                sec = [f"<section><h2>{st}</h2>"]
                intro = prose(pick(s.get("intro"), lang, "pro"))
                if intro and intro not in (blurb_pro, blurb_kid):
                    sec.append(f"<p>{esc(intro)}</p>")
                    words += len(intro.split())
                tg = s.get("targets") or []
                if tg:
                    items = []
                    for g in tg:
                        nm, sci, task = pick(g.get("name"), lang), pick(g.get("sci"), lang), pick(g.get("task"), lang, "pro")
                        items.append(f"<li><b>{esc(nm)}</b>" + (f" — <i>{esc(sci)}</i>" if sci else "") + (f". {esc(task)}" if task else "") + "</li>")
                        words += len(f"{nm} {sci} {task}".split())
                    sec.append(f'<h3>{t["look"]}</h3><ul>' + "".join(items) + "</ul>")
                ref = pick(s.get("sciRef"), lang)
                if ref:
                    sec.append(f'<p><b>{t["source"]}:</b> {esc(ref)}</p>')
                ask = pick(s.get("askTogether"), lang)
                if ask:
                    sec.append(f'<p><b>{t["ask"]}:</b> {esc(ask)}</p>')
                    words += len(ask.split())
                qs = s.get("questions") or []
                if qs:
                    sec.append(f'<h3>{t["quiz"]}</h3>')
                    for q in qs:
                        for mode, label in (("junior", t["kids_q"]), ("pro", t["pro_q"])):
                            qq, opts = pick(q.get("q"), lang, mode), pick(q.get("opts"), lang, mode)
                            a = q.get("a")
                            ai = a if isinstance(a, int) else (a or {}).get(mode, (a or {}).get("junior", 0))
                            if not qq or not isinstance(opts, list) or not (0 <= ai < len(opts)):
                                continue
                            sec.append(f"<p><b>{label}:</b> {esc(qq)}</p><ul>" + "".join(f"<li>{esc(o)}</li>" for o in opts)
                                       + f"</ul><details><summary>{t['answer']}</summary><p>{esc(opts[ai])}</p></details>")
                            words += len(qq.split()) + sum(len(o.split()) for o in opts)
                credit = s.get("credit")
                if credit:   # the photo credit is stored as a link; keep only its text
                    sec.append(f'<p class="record">{t["credit"]}: {esc(re.sub(r"<[^>]+>", "", credit))}</p>')
                sec.append("</section>")
                b.extend(sec)
            other = ru_path if lang == "en" else en_path
            b.append(f'<p class="more">{t["other"]}: <a href="{other}" hreflang="{"ru" if lang == "en" else "en"}">'
                     f'{T["ru" if lang == "en" else "en"]["lang_name"]}</a></p>')
            title = f"{name} · {t['station']} · Digital Live Zoo"
            desc = (blurb_pro or f"{name}, {place}")[:155]
            core = "\n".join(b)
            html = page_head(lang, title, desc, path, en_path, ru_path, image) + top + '<main class="wrap">' + core + "</main>" + foot()
            out.append((path, html, words >= 150, core))     # thin pages stay out of the sitemap
        # ---- the index of all expeditions, by region
        path = f"/field-station/e/{suffix}"
        groups = []
        for rid, reg in regions.items():
            mine = [x for x in exps if x.get("region") == rid]
            if not mine:
                continue
            links = "".join(f'<li><a href="/field-station/e/{x["id"]}/{suffix}">{esc(pick(x["name"], lang))}</a> — {esc(pick(x["place"], lang))}</li>'
                            for x in mine)
            groups.append(f'<section><h2>{esc(reg.get(lang, reg.get("en", rid)))} ({len(mine)})</h2><ul>{links}</ul></section>')
        core = (f'<h1>{t["index_h1"]}</h1><p class="intro">{t["index_intro"]}</p>'
                f'<p class="more"><a href="/field-station/{"?lang=ru" if lang == "ru" else ""}"><b>{t["station"]} →</b></a></p>' + "".join(groups))
        html = (page_head(lang, f"{t['index_h1']} · Digital Live Zoo", t["index_intro"][:155], path, "/field-station/e/", "/field-station/e/ru/")
                + top + '<main class="wrap">' + core + "</main>" + foot())
        out.append((path, html, True, core))
    return out
