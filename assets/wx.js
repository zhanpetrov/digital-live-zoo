// Weather at the cams: current conditions and the next hours near each camera, plus sunrise and sunset.
// Data: MET Norway (api.met.no) through the zoo-live Cloudflare Worker (tools/live-worker), which re-fetches
// every place every 15 to 30 minutes. Cam coordinates and the indoor note live in /data/geo.json (by cam slug).
// Used by the home page and the cam pages: window.ZooWx.
(function(){
  var WX_URL = "https://zoo-live.zhanpetrov8.workers.dev/weather", GEO_URL = "/data/geo.json";
  var STALE_MS = 3 * 3600000;   // older readings are not shown
  var US = /-US$/i.test(navigator.language || "");
  var geo = {}, wx = {}, listeners = [];

  var SYM = {
    clearsky: ["☀️", "🌙", "Clear"], fair: ["🌤️", "🌙", "Mostly clear"], partlycloudy: ["⛅", "☁️", "Partly cloudy"],
    cloudy: ["☁️", "☁️", "Cloudy"], fog: ["🌫️", "🌫️", "Fog"]
  };
  // MET symbol codes, e.g. "partlycloudy_day", "lightrainshowersandthunder_night", "heavysnow"
  function describe(code){
    if(!code) return null;
    var night = /_night$/.test(code), base = code.replace(/_(day|night|polartwilight)$/, "");
    if(SYM[base]) return {icon: SYM[base][night ? 1 : 0], text: SYM[base][2]};
    var thunder = /andthunder$/.test(base); base = base.replace(/andthunder$/, "");
    var showers = /showers$/.test(base); base = base.replace(/showers$/, "");
    var m = base.match(/^(lights?|heavy)?(rain|sleet|snow)$/);   // "lights…" is MET's own spelling in two codes
    if(!m) return {icon: "🌡️", text: "Mixed"};
    var t = (m[1] ? (m[1].charAt(0) === "l" ? "light " : "heavy ") : "") + m[2] + (showers ? " showers" : "") + (thunder ? " and thunder" : "");
    return {icon: thunder ? "⛈️" : m[2] !== "rain" ? "🌨️" : showers ? "🌦️" : "🌧️", text: t.charAt(0).toUpperCase() + t.slice(1)};
  }

  var f = function(c){ return Math.round(c * 9 / 5 + 32); };
  function temp(c, both){
    if(typeof c !== "number") return "";
    var C = Math.round(c) + "°C", F = f(c) + "°F";
    return both ? (US ? F + " / " + C : C + " / " + F) : (US ? F : C);
  }
  function wind(ms){ return typeof ms === "number" ? (US ? Math.round(ms * 2.237) + " mph" : Math.round(ms * 3.6) + " km/h") : ""; }
  var DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  function dir(deg){ return typeof deg === "number" ? DIRS[Math.round(deg / 45) % 8] : ""; }
  function ago(ms){
    var m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    return m < 1 ? "just now" : m === 1 ? "1 minute ago" : m < 60 ? m + " minutes ago" : Math.round(m / 60) + " h ago";
  }
  var key = function(p){ return (+p.lat).toFixed(2) + "," + (+p.lon).toFixed(2); };

  // weather for a cam slug: {place, w, d} or null; place alone when there is no fresh reading
  function at(slug){
    var p = slug && geo[slug];
    if(!p || typeof p.lat !== "number") return null;
    var w = wx[key(p)];
    if(w && (Date.now() - w.got) > STALE_MS) w = null;
    return {place: p, w: w || null, d: w ? describe(w.s) : null};
  }
  function note(p){ return p && p.in ? "Outdoor weather near this " + p.in : ""; }

  // sunrise / sunset (the suncalc method, accurate to a minute or two)
  var rad = Math.PI / 180, DAY = 86400000, J1970 = 2440588, J2000 = 2451545, E = rad * 23.4397, J0 = 0.0009;
  function sun(lat, lon, date){
    var lw = rad * -lon, phi = rad * lat, d = date.valueOf() / DAY - 0.5 + J1970 - J2000;
    var n = Math.round(d - J0 - lw / (2 * Math.PI)), ds = J0 + lw / (2 * Math.PI) + n;
    var M = rad * (357.5291 + 0.98560028 * ds);
    var L = M + rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + rad * 102.9372 + Math.PI;
    var dec = Math.asin(Math.sin(E) * Math.sin(L));
    var noon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
    var cosw = (Math.sin(-0.833 * rad) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
    if(cosw > 1) return {polar: "night"};
    if(cosw < -1) return {polar: "day"};
    var set = J2000 + (J0 + (Math.acos(cosw) + lw) / (2 * Math.PI) + n) + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
    var toDate = function(j){ return new Date((j + 0.5 - J1970) * DAY); };
    return {rise: toDate(noon - (set - noon)), set: toDate(set)};
  }

  function changed(){ listeners.forEach(function(fn){ try{ fn(); }catch(e){} }); }
  function loadWx(){
    return fetch(WX_URL, {cache: "no-store"}).then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){ if(d && d.w){ wx = d.w; changed(); } }).catch(function(){});
  }
  var ready = fetch(GEO_URL, {cache: "no-cache"}).then(function(r){ return r.ok ? r.json() : null; })
    .then(function(g){ geo = (g && g.places) || {}; return loadWx(); }).catch(function(){});
  setInterval(function(){ if(document.visibilityState === "visible") loadWx(); }, 10 * 60000);
  setInterval(changed, 60000);   // keeps "updated … ago" honest

  window.ZooWx = {
    ready: ready, at: at, place: function(slug){ var p = slug && geo[slug]; return p && typeof p.lat === "number" ? p : null; }, describe: describe, temp: temp, wind: wind, dir: dir, ago: ago, note: note, sun: sun,
    onChange: function(fn){ listeners.push(fn); },
    credit: '<a href="https://www.met.no/en" target="_blank" rel="noopener">MET Norway</a>'
  };
})();
