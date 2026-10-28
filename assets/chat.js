/* Zoo Chat: one public room for everyone on the site.
   Talks to the zoo-live Worker (tools/live-worker, class ChatRoom) over a WebSocket, after a Cloudflare Turnstile check.
   No accounts: everyone gets a random animal name, remembered in this browser only. Messages are plain text,
   shown with textContent (never as HTML), and vanish after 24 hours on the server. The page tells it which cam is
   on the stage (ZooChat.watch); each message carries that cam, and clicking it puts the cam on your stage too.
   Config: window.ZOO_CHAT = {url: "wss://…/chat", sitekey: "<Turnstile site key>"}; empty url = no chat. */
(function(){
  "use strict";
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const CFG = local ? {url: "ws://127.0.0.1:8787/chat", sitekey: "1x00000000000000000000AA"} : (window.ZOO_CHAT || {});
  if(!CFG.url || !CFG.sitekey) return;
  const S = window.ZOO_STAGE || {name: () => "", put: () => {}, current: () => ""};
  const track = (ev, p) => { try{ window.posthog && posthog.capture(ev, p || {}); }catch(e){} };
  const store = {
    get(k, d){ try{ const v = localStorage.getItem("zoo-chat-" + k); return v === null ? d : JSON.parse(v); }catch(e){ return d; } },
    set(k, v){ try{ localStorage.setItem("zoo-chat-" + k, JSON.stringify(v)); }catch(e){} },
  };

  const NOPE = {
    link: "Links aren't allowed here. Tell people the cam name instead 🐾",
    contact: "No contact details, please. Keep it about the animals 🦉",
    words: "Let's keep it friendly. Kids hang out here too 🙂",
    caps: "No need to shout 🦁",
    slow: "Slow down a little 🐢 (one message every few seconds)",
    repeat: "You just said that 🦜",
    empty: "",
    muted: "You're muted for a while after reports from others.",
  };
  const REACTIONS = ["🐾", "😍", "🔥", "😂", "👀", "🐻", "🦦", "🐧"];

  let seed = store.get("seed", null);
  if(seed === null){ seed = Math.floor(Math.random() * 400); store.set("seed", seed); }
  let ws = null, widget = null, me = null, open = false, unread = 0, here = {online: 0, cams: {}}, tries = 0, closedByUs = false;
  const hiddenIds = new Set(store.get("hidden", []));

  // ---------- markup ----------
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "zc-btn"; btn.setAttribute("aria-expanded", "false");
  btn.innerHTML = '<span aria-hidden="true">🐾</span> Zoo Chat <b class="zc-n" hidden></b><i class="zc-dot" hidden></i>';
  const panel = document.createElement("section");
  panel.className = "zc"; panel.hidden = true; panel.setAttribute("aria-label", "Zoo Chat");
  panel.innerHTML = `
    <header class="zc-h">
      <div><b>🐾 Zoo Chat</b> <span class="zc-here">connecting…</span></div>
      <button type="button" class="zc-x" aria-label="Close chat">×</button>
    </header>
    <div class="zc-me" hidden><span class="zc-you"></span><button type="button" class="zc-roll" title="Get a new animal name">🎲 new name</button></div>
    <div class="zc-watch" hidden></div>
    <ol class="zc-list" aria-live="polite"></ol>
    <div class="zc-ts"></div>
    <p class="zc-note" hidden></p>
    <div class="zc-react">${REACTIONS.map(r => `<button type="button" data-r="${r}" aria-label="Send ${r}">${r}</button>`).join("")}</div>
    <form class="zc-form">
      <input class="zc-in" maxlength="200" autocomplete="off" placeholder="Say something about the animals…" aria-label="Message" disabled>
      <button type="submit" class="zc-send" disabled>Send</button>
    </form>
    <p class="zc-rules">Be kind. No links or contact details. Messages vanish after 24 h. ⚑ reports hide bad messages.</p>`;
  document.body.append(btn, panel);
  const q = s => panel.querySelector(s);
  const list = q(".zc-list"), input = q(".zc-in"), note = q(".zc-note");

  // ---------- connection ----------
  function loadTurnstile(){
    if(window.turnstile) return Promise.resolve();
    return new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true; s.onload = ok; s.onerror = fail;
      document.head.append(s);
    });
  }
  async function connect(){
    status("connecting…");
    try{ await loadTurnstile(); }catch(e){ return status("couldn't load the bot check", true); }
    if(widget === null){
      widget = turnstile.render(q(".zc-ts"), {sitekey: CFG.sitekey, appearance: "interaction-only", theme: "dark",
        callback: token => openSocket(token), "error-callback": () => status("bot check failed, try again", true)});
    } else turnstile.reset(widget);
  }
  function openSocket(token){
    if(ws){ closedByUs = true; try{ ws.close(); }catch(e){} }
    closedByUs = false;
    let greeted = false;
    ws = new WebSocket(`${CFG.url}?ts=${encodeURIComponent(token)}&seed=${seed}`);
    ws.onmessage = e => {
      let m; try{ m = JSON.parse(e.data); }catch(x){ return; }
      if(m.type === "hello"){ greeted = true; tries = 0; hello(m); }
      else if(m.type === "msg") add(m.m, true);
      else if(m.type === "hide") m.ids.forEach(id => { const el = list.querySelector(`[data-id="${CSS.escape(id)}"]`); if(el) el.remove(); });
      else if(m.type === "here"){ here = m; renderHere(); }
      else if(m.type === "nope") say(NOPE[m.why] || "", m.why === "muted" ? m.left : 0);
    };
    ws.onclose = () => {
      input.disabled = q(".zc-send").disabled = true;
      if(closedByUs) return;
      if(!greeted) return status("the chat is closed right now", true);
      if(open && tries++ < 5) setTimeout(connect, 2000 * tries);      // dropped: get a fresh check and come back
      else status("disconnected", true);
    };
  }
  function status(t, retry){
    q(".zc-here").textContent = t;
    if(retry){ note.hidden = false; note.innerHTML = ""; const b = document.createElement("button"); b.type = "button"; b.className = "zc-retry"; b.textContent = "Try again"; b.onclick = connect; note.append(b); }
  }

  function hello(m){
    me = m.you;
    q(".zc-me").hidden = false;
    q(".zc-you").textContent = `You are ${me.e} ${me.n}`;
    list.textContent = "";
    m.msgs.forEach(x => add(x, false));
    if(!m.msgs.length) sys("It's quiet in here. Say hi and tell everyone what you're watching! 🐾");
    input.disabled = q(".zc-send").disabled = false;
    note.hidden = true;
    if(m.muted) say(NOPE.muted, m.muted);
    watch(S.current());
  }

  // ---------- rendering ----------
  const hue = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const time = ts => new Date(ts).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
  function add(m, live){
    if(hiddenIds.has(m.id)) return;
    const li = document.createElement("li");
    li.className = "zc-m" + (me && m.n === me.n ? " mine" : "");
    li.dataset.id = m.id;
    const av = document.createElement("span"); av.className = "zc-av"; av.textContent = m.e; av.style.setProperty("--h", hue(m.n));
    const body = document.createElement("div"); body.className = "zc-b";
    const top = document.createElement("div"); top.className = "zc-top";
    const nm = document.createElement("b"); nm.textContent = m.n; nm.style.setProperty("--h", hue(m.n));
    const tm = document.createElement("time"); tm.textContent = time(m.ts);
    top.append(nm, tm);
    const camName = m.c && S.name(m.c);
    if(camName){
      const c = document.createElement("button"); c.type = "button"; c.className = "zc-cam"; c.textContent = "📺 " + camName;
      c.title = "Put this cam on your stage"; c.onclick = () => { S.put(m.c); track("chat_cam_click", {cam_id: m.c}); };
      top.append(c);
    }
    const tx = document.createElement("p"); tx.textContent = m.t;
    if(/^\p{Extended_Pictographic}{1,3}$/u.test(m.t)) tx.className = "big";
    body.append(top, tx);
    const rep = document.createElement("button"); rep.type = "button"; rep.className = "zc-rep"; rep.textContent = "⚑"; rep.title = "Report this message";
    rep.onclick = () => {
      if(!confirm("Report this message? It disappears for you now, and for everyone if others report it too.")) return;
      if(ws && ws.readyState === 1) ws.send(JSON.stringify({type: "report", id: m.id}));
      hiddenIds.add(m.id); store.set("hidden", [...hiddenIds].slice(-100)); li.remove(); track("chat_reported");
    };
    if(!li.classList.contains("mine")) li.append(av, body, rep); else li.append(av, body);
    const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    list.append(li);
    while(list.children.length > 80) list.firstChild.remove();
    if(atEnd || !live) list.scrollTop = list.scrollHeight;
    if(live && !open){ unread++; btn.querySelector(".zc-dot").hidden = false; }
  }
  function sys(t){ const li = document.createElement("li"); li.className = "zc-sys"; li.textContent = t; list.append(li); }
  let noteT;
  function say(t, ms){
    if(!t) return;
    note.hidden = false;
    note.textContent = ms ? `${t} (${Math.ceil(ms / 3600000)} h left)` : t;
    clearTimeout(noteT); noteT = setTimeout(() => { note.hidden = true; }, 5000);
  }
  function renderHere(){
    const n = here.online || 0;
    q(".zc-here").textContent = `${n} here`;
    const b = btn.querySelector(".zc-n"); b.hidden = !n; b.textContent = n;
    const top = Object.entries(here.cams || {}).filter(([id]) => S.name(id)).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const w = q(".zc-watch"); w.hidden = !top.length; w.textContent = "";
    if(top.length){
      const l = document.createElement("span"); l.textContent = "Watching:"; w.append(l);
      top.forEach(([id, k]) => { const c = document.createElement("button"); c.type = "button"; c.className = "zc-cam"; c.textContent = `📺 ${S.name(id)} · ${k}`; c.onclick = () => S.put(id); w.append(c); });
    }
  }

  // ---------- actions ----------
  function send(text){
    text = String(text || "").trim();
    if(!text || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({type: "say", text}));
    track("chat_sent", {reaction: REACTIONS.includes(text)});    // never the text itself
  }
  function watch(id){ if(ws && ws.readyState === 1) ws.send(JSON.stringify({type: "watch", cam: id || ""})); }
  q(".zc-form").addEventListener("submit", e => { e.preventDefault(); send(input.value); input.value = ""; });
  q(".zc-react").addEventListener("click", e => { const b = e.target.closest("[data-r]"); if(b) send(b.dataset.r); });
  q(".zc-roll").addEventListener("click", () => { seed = Math.floor(Math.random() * 400); store.set("seed", seed); connect(); });
  function toggle(on){
    open = on; panel.hidden = !on; btn.setAttribute("aria-expanded", String(on));
    if(on){
      unread = 0; btn.querySelector(".zc-dot").hidden = true;
      if(!ws || ws.readyState > 1) connect();
      track("chat_opened");
      setTimeout(() => input.focus(), 50);
    }
  }
  btn.addEventListener("click", () => toggle(!open));
  q(".zc-x").addEventListener("click", () => toggle(false));
  document.addEventListener("keydown", e => { if(e.key === "Escape" && open) toggle(false); });

  window.ZooChat = {watch};
})();
