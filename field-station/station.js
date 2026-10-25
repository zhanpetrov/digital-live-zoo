/* Field Station home: "Start here" pick, "For you" rail and the 360° films rail, plus a shorter library.
   The page script exposes window.DLZ_FS; this file only reads it and re-renders when the home view does.

   How "For you" ranks the open expeditions (all in this browser, nothing is sent except click events):
     +3   a region the visitor has no stamp from yet (the passport keeps growing)
     +2   it is daytime there now (the live cam at the end of the expedition shows animals awake)
     +2.5 a 360° film, for a visitor with no stamps yet (the strongest first impression)
     +1   edition fit: Kids get the shorter expeditions, Adults the longer ones
     +0-1 a shuffle that stays the same all day, so the rail changes daily but not on every visit
   Finished expeditions drop out. PostHog gets fs_rec_shown / fs_rec_click with the slot and the reason,
   so the click-through per slot and per reason shows whether the ranking works. */
(function(){
  "use strict";
  const F = window.DLZ_FS;
  if(!F || !document.getElementById("homeV")) return;
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

  const T = {
    en: {
      tag: "Step inside 100 wild places in 360°. Every expedition ends at a live cam, so you can see the same place as it is right now.",
      startHere: "Start here", forYou: "Picked for you", films: "360° films", go: "Start →", filmGo: "Watch in 360° →",
      showAll: n => `Show all ${n} expeditions`, showLess: "Show fewer",
      why: { region: r => `New region for your passport: ${r}`, day: hm => `${hm} there now · animals are up`, film: "A 360° film to begin with",
             kids: "A short one, good for kids", pro: "A longer, deeper one", fresh: "Something new" },
      firstTime: "New here? Start with a 360° film.", filmBadge: "360° film",
    },
    ru: {
      tag: "Окажитесь внутри 100 диких мест в 360°. Каждая экспедиция заканчивается живой камерой: то же место, прямо сейчас.",
      startHere: "Начните здесь", forYou: "Подобрано для вас", films: "Фильмы 360°", go: "Начать →", filmGo: "Смотреть в 360° →",
      showAll: n => `Показать все ${n} экспедиций`, showLess: "Свернуть",
      why: { region: r => `Новый регион для паспорта: ${r}`, day: hm => `Там сейчас ${hm} · звери не спят`, film: "Фильм 360° для начала",
             kids: "Короткая, хорошо для детей", pro: "Длинная и подробная", fresh: "Что-то новое" },
      firstTime: "Впервые здесь? Начните с фильма 360°.", filmBadge: "Фильм 360°",
    },
  };
  const t = () => T[F.lang()] || T.en;
  const LIB_CAP = 12;
  let libOpen = false, shownKey = "";

  // the same pseudo-random number for an id all day
  function daily(id){
    let h = 2166136261 ^ Math.floor(Date.now() / 86400000);
    for(const ch of id){ h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 1000) / 1000;
  }

  function ranked(){
    const got = F.stamps(), mode = F.mode();
    const stampedRegions = new Set(F.exps.filter(x => got[x.id]).map(x => x.region));
    const newbie = !Object.keys(got).length;
    return F.exps.filter(x => x.open && !got[x.id]).map(x => {
      const parts = [];
      if(!stampedRegions.has(x.region)) parts.push(["region", 3]);
      if(F.daytime(x)) parts.push(["day", 2]);
      if(newbie && x.hasVideo360) parts.push(["film", 2.5]);
      const len = (x.stops || []).length;
      if(mode === "junior" ? len <= 2 : len >= 4) parts.push([mode === "junior" ? "kids" : "pro", 1]);
      const score = parts.reduce((s, p) => s + p[1], 0) + daily(x.id);
      // the reason shown: with no stamps yet every region is new, so say something more useful first
      const shown = parts.filter(p => !(newbie && p[0] === "region")).sort((a, b) => b[1] - a[1]);
      return {x, score, why: shown.length ? shown[0][0] : "fresh"};
    }).sort((a, b) => b.score - a.score);
  }

  // take n, but each repeat of a region already taken costs 1.5, so the rail travels
  function diverse(list, n){
    const out = [], seen = {}, pool = list.slice();
    while(out.length < n && pool.length){
      let bi = 0, bs = -1e9;
      pool.forEach((r, i) => { const s = r.score - 1.5 * (seen[r.x.region] || 0); if(s > bs){ bs = s; bi = i; } });
      const r = pool.splice(bi, 1)[0];
      seen[r.x.region] = (seen[r.x.region] || 0) + 1;
      out.push(r);
    }
    return out;
  }

  const regionName = id => { const reg = F.regions[id]; return reg ? (reg[F.lang()] || reg.en) : id; };
  function localTime(tz){
    try{ return new Intl.DateTimeFormat(F.lang() === "ru" ? "ru-RU" : "en-GB", {hour: "2-digit", minute: "2-digit", timeZone: tz}).format(new Date()); }
    catch(e){ return ""; }
  }
  function reasonText(r, rail){
    const w = t().why;
    if(rail === "films") return regionName(r.x.region);
    if(r.why === "region") return w.region(regionName(r.x.region));
    if(r.why === "day"){ const hm = localTime(r.x.tz); return hm ? w.day(hm) : w.fresh; }
    return w[r.why] || w.fresh;
  }

  function card(r, rail, slot, big){
    const x = r.x, s = t();
    const img = x.img ? `<img src="${esc(x.img)}" alt="" loading="lazy" decoding="async">` : "";
    return `<button type="button" class="st-card${big ? " big" : ""}" data-st="${esc(x.id)}" data-rail="${rail}" data-slot="${slot}" data-why="${esc(r.why)}">
      <span class="st-img">${img}${x.hasVideo360 ? `<span class="st-film">${esc(s.filmBadge)}</span>` : ""}</span>
      <span class="st-bd">
        <span class="st-why">${esc(reasonText(r, rail))}</span>
        <b>${esc(F.R(x.name))}</b>
        <span class="st-place">${esc(F.R(x.place))}</span>
        ${big ? `<span class="st-blurb">${esc(F.R(x.blurb))}</span>` : ""}
        <span class="st-go">${esc(x.hasVideo360 ? s.filmGo : s.go)}</span>
      </span>
    </button>`;
  }

  function render(){
    const s = t(), list = ranked();
    let box = $("stFor");
    if(!box){
      box = document.createElement("section");
      box.id = "stFor"; box.className = "st-for";
      $("expSection").before(box);
      box.addEventListener("click", onPick);
    }
    $("stTag") || $("heroDesc").insertAdjacentHTML("afterend", '<p class="st-tag" id="stTag"></p>');
    $("stTag").textContent = s.tag;

    const filmsLeft = list.filter(r => r.x.hasVideo360);
    const filmsAll = F.exps.filter(x => x.open && x.hasVideo360).map(x => filmsLeft.find(r => r.x === x) || {x, why: "film"});
    const top = list[0], rest = diverse(list.filter(r => r !== top && !r.x.hasVideo360), 8);   // films have their own rail
    box.innerHTML = (top ? `<div class="st-h"><h2>${esc(s.startHere)}</h2>${Object.keys(F.stamps()).length ? "" : `<span>${esc(s.firstTime)}</span>`}</div>
      ${card(top, "start", 0, true)}` : "")
      + (rest.length ? `<div class="st-h"><h2>${esc(s.forYou)}</h2></div><div class="st-rail">${rest.map((r, i) => card(r, "for_you", i + 1)).join("")}</div>` : "")
      + (filmsAll.length ? `<div class="st-h"><h2>${esc(s.films)}</h2></div><div class="st-rail">${filmsAll.map((r, i) => card(r, "films", i)).join("")}</div>` : "");

    // report what was shown once per distinct set, so click-through can be computed per slot and reason
    const key = F.lang() + F.mode() + [top, ...rest].filter(Boolean).map(r => r.x.id).join(",");
    if(key !== shownKey){
      shownKey = key;
      F.track("fs_rec_shown", {ids: [top, ...rest].filter(Boolean).map(r => r.x.id), whys: [top, ...rest].filter(Boolean).map(r => r.why), mode: F.mode(), lang: F.lang(), stamps: Object.keys(F.stamps()).length});
    }
    trimLibrary();
  }

  function onPick(e){
    const b = e.target.closest("[data-st]");
    if(!b) return;
    F.track("fs_rec_click", {exp: b.dataset.st, rail: b.dataset.rail, slot: +b.dataset.slot, why: b.dataset.why, mode: F.mode(), lang: F.lang()});
    F.start(b.dataset.st);
  }

  // the full library: first LIB_CAP cards until asked, unless a filter or search is narrowing it already
  function trimLibrary(){
    const grid = $("exps"), cards = grid.querySelectorAll(".ex");
    let more = $("stMore");
    const cap = !libOpen && !F.filtered() && cards.length > LIB_CAP;
    grid.classList.toggle("st-capped", cap);
    if(cards.length <= LIB_CAP || F.filtered()){ if(more) more.hidden = true; return; }
    if(!more){
      more = document.createElement("button");
      more.type = "button"; more.id = "stMore"; more.className = "act-btn st-more";
      grid.after(more);
      more.addEventListener("click", () => { libOpen = !libOpen; trimLibrary(); if(!libOpen) $("expSection").scrollIntoView({block: "start"}); });
    }
    more.hidden = false;
    more.textContent = libOpen ? t().showLess : t().showAll(cards.length);
  }

  // the page re-renders the grid on every language, edition, filter and stamp change: follow it
  let queued = false;
  new MutationObserver(() => {
    if(queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; render(); });
  }).observe($("exps"), {childList: true});
  render();
})();
