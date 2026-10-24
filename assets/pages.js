// Live bits of the generated pages: local clocks, and "right now" from activity.json (rewritten every 30 minutes).
(function(){
  var fmts = {};
  function local(tz){
    try{
      var f = fmts[tz] || (fmts[tz] = new Intl.DateTimeFormat("en-GB", {timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false}));
      var s = f.format(new Date()), h = parseInt(s.slice(0, 2), 10);
      var dp = (h >= 7 && h < 18) ? "day" : ((h >= 5 && h < 7) || (h >= 18 && h < 20)) ? "golden hour" : "night";
      return [s, dp];
    }catch(e){ return null; }
  }
  function clocks(){
    var els = document.querySelectorAll("[data-tz]");
    for(var i = 0; i < els.length; i++){
      var t = local(els[i].getAttribute("data-tz"));
      if(t) els[i].textContent = t[0] + (els[i].hasAttribute("data-long") ? " (" + t[1] + ")" : " local · " + t[1]);
    }
  }
  clocks(); setInterval(clocks, 30000);

  function each(sel, fn){ var els = document.querySelectorAll(sel); for(var i = 0; i < els.length; i++) fn(els[i]); }
  fetch("/activity.json", {cache: "no-cache"}).then(function(r){ return r.ok ? r.json() : null; }).then(function(a){
    var fresh = a && a.v === 2 && (Date.now() - Date.parse(a.updated)) < 3 * 3600000;
    var cams = fresh ? (a.cams || {}) : {};
    each("[data-act]", function(el){
      var v = cams[el.getAttribute("data-act")]; if(!v) return;
      var f = v[1] || "", t = null, cls = "badge";
      if(f.indexOf("x") >= 0){ t = "OFF AIR"; cls += " off"; }
      else if(f.indexOf("t") >= 0){ t = "TRENDING"; cls += " trend"; }
      else if(f.indexOf("a") >= 0){ t = "ACTION NOW"; }
      if(t){ el.textContent = t; el.className = cls; el.hidden = false; }
    });
    each("[data-now]", function(el){
      var v = cams[el.getAttribute("data-now")];
      if(!v){ el.textContent = fresh ? "Not checked yet" : "No recent check"; return; }
      var f = v[1] || "";
      el.textContent = f.indexOf("x") >= 0 ? "Off air at the last check" :
        f.indexOf("t") >= 0 ? "Trending: viewers are piling in" :
        f.indexOf("a") >= 0 ? "Action: animals moving on camera" :
        f.indexOf("e") >= 0 ? "Quiet: not much in view" : "Live";
    });
    each("[data-watch]", function(el){
      var v = cams[el.getAttribute("data-watch")];
      if(v && v[2] && (v[1] || "").indexOf("x") < 0) el.textContent = v[2].toLocaleString("en-US") + " watching now";
    });
  }).catch(function(){});
})();

// Weather near the cam and sunrise / sunset (assets/wx.js: MET Norway via the zoo-live Worker, coordinates in /data/geo.json).
(function(){
  var W = window.ZooWx; if(!W) return;
  function each(sel, fn){ var els = document.querySelectorAll(sel); for(var i = 0; i < els.length; i++) fn(els[i]); }
  function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]; }); }
  function row(el, show){ var dd = el.parentNode, dt = dd && dd.previousElementSibling; if(dd) dd.hidden = !show; if(dt) dt.hidden = !show; }
  function clock(d, tz, hourOnly){ try{ return d.toLocaleTimeString([], hourOnly ? {timeZone: tz, hour: "numeric"} : {timeZone: tz, hour: "numeric", minute: "2-digit"}); }catch(e){ return ""; } }
  function render(){
    each("[data-wx]", function(el){
      var r = W.at(el.getAttribute("data-wx")), tz = el.getAttribute("data-wx-tz");
      if(!r){ row(el, false); return; }
      row(el, true);
      if(!r.w || !r.d){ el.textContent = "No recent reading for this spot"; return; }
      var w = r.w, extra = [];
      if(W.wind(w.ws)) extra.push("Wind " + W.wind(w.ws) + (W.dir(w.wd) ? " from the " + W.dir(w.wd) : ""));
      if(typeof w.h === "number") extra.push("Humidity " + Math.round(w.h) + "%");
      if(typeof w.p === "number" && w.p > 0) extra.push(w.p + " mm in the next hour");
      var next = (w.n || []).map(function(h){
        var d = W.describe(h[2]);
        return '<span class="wx-h"><small>' + esc(clock(new Date(h[0]), tz, true)) + '</small><span aria-hidden="true">' + (d ? d.icon : "") + '</span>' + esc(W.temp(h[1])) + '</span>';
      }).join("");
      el.innerHTML = '<span class="wx-main"><span aria-hidden="true">' + r.d.icon + '</span> ' + esc(r.d.text) + " · " + esc(W.temp(w.t, true)) + '</span>'
        + '<span class="wx-sub">' + esc(extra.join(" · ")) + '</span>'
        + (next ? '<span class="wx-next" aria-label="Next hours">' + next + '</span>' : "")
        + '<span class="wx-sub">Updated ' + esc(W.ago(w.got)) + ' · data ' + W.credit + '</span>'
        + (r.place.in ? '<span class="wx-note">' + esc(W.note(r.place)) + '</span>' : "");
    });
    each("[data-sun]", function(el){
      var r = W.at(el.getAttribute("data-sun")), tz = el.getAttribute("data-wx-tz");
      if(!r){ row(el, false); return; }
      row(el, true);
      var s = W.sun(r.place.lat, r.place.lon, new Date());
      el.textContent = s.polar === "day" ? "The sun does not set today" : s.polar === "night" ? "The sun does not rise today" :
        "☀ " + clock(s.rise, tz) + " · ☾ " + clock(s.set, tz) + " (local time)";
    });
  }
  W.onChange(render);
  W.ready.then(render);
})();
