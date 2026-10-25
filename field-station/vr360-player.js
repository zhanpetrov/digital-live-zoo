/**
 * DLZ360Player — Universal Embedded WebGL 360° Equirectangular VR Player for Digital Live Zoo
 *
 * Supports two seamless 360° modes on desktop, iPhone/iPad Safari, Android Chrome, and VR browsers:
 * 1. Multi-Audio 360° Video Mode (`masterHlsSrc` / `hlsSrc` / `mp4Src`):
 *    Renders equirectangular 360°×180° video inside a 72×48 WebGL UV sphere with 0ms in-place
 *    ElevenLabs audio track switching (`en_junior`, `en_pro`, `ru_junior`, `ru_pro`) via hls.js MSE
 *    and per-track Apple HLS fallback on iOS.
 * 2. Living 360° Habitat Panorama + Studio ElevenLabs Voice Guide Mode (`panoSrc` + `audioSrc`):
 *    Renders high-resolution 2:1 equirectangular 360° habitat spheres with synchronized Studio
 *    ElevenLabs narration + stereo biome soundscapes, live EN/RU & Kids/Adults voice switching,
 *    compass bearings, gyroscope tilt, pinch/wheel zoom, fullscreen, and 3D raycasted target pins.
 */
(function () {
  "use strict";

  const DEG2RAD = Math.PI / 180;
  const RAD2DEG = 180 / Math.PI;
  const HLS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.17/hls.min.js";

  const I18N = {
    en: {
      ariaApp: "Interactive 360 degree wildlife expedition player. Drag or use arrow keys to look around.",
      vrBadgeVideo: "360° VR CAMP",
      vrBadgePano: "360° HABITAT + VOICE",
      enterTitleVideo: "Enter 360° VR Camp",
      enterTitlePano: "Enter 360° Expedition",
      enterSub: "Studio ElevenLabs Guide (EN / RU) · Drag, pinch or tilt 360° right on this page",
      play: "▶ Play",
      replay: "↻ Replay",
      pause: "❚❚ Pause",
      sound: "🔊 Sound",
      unmute: "🔇 Unmute",
      ccOn: "CC: ON",
      ccOff: "CC: OFF",
      guideOff: "🧭 Guide: OFF",
      guideOn: "🧭 Guide: ON",
      tilt: "📱 Tilt 360°",
      tilting: "📱 Tilting",
      langBtn: "🌐 EN · RU",
      endStamp: "Laguna Chaxa — noticed the hidden meal",
      endHeading: "Where shall we go next?",
      endSub: "Choose your next 360° expedition or replay this 05:00 film.",
      replayFilm: "↻ Replay 05:00 Film",
      dirs: ["N", "NE", "E 🌅", "SE", "S", "SW", "W 🌇", "NW"],
    },
    ru: {
      ariaApp: "Интерактивный 360-градусный плеер экспедиции. Вращайте мышью, пальцем или клавишами со стрелками.",
      vrBadgeVideo: "360° VR-ЛАГЕРЬ",
      vrBadgePano: "360° ПАНОРАМА + ГИД",
      enterTitleVideo: "Войти в 360° VR-лагерь",
      enterTitlePano: "Начать 360° обзор с гидом",
      enterSub: "Студийный гид ElevenLabs (RU / EN) · Вращайте на 360° прямо на сайте",
      play: "▶ Пуск",
      replay: "↻ Повтор",
      pause: "❚❚ Пауза",
      sound: "🔊 Звук",
      unmute: "🔇 Вкл. звук",
      ccOn: "Субтитры: ВКЛ",
      ccOff: "Субтитры: ВЫКЛ",
      guideOff: "🧭 Гид: ВЫКЛ",
      guideOn: "🧭 Гид: ВКЛ",
      tilt: "📱 Наклон 360°",
      tilting: "📱 Гироскоп",
      langBtn: "🌐 RU · EN",
      endStamp: "Лагуна Чакса — замечен скрытый обед",
      endHeading: "Куда отправимся дальше?",
      endSub: "Выберите следующую 360°-экспедицию или посмотрите 5-минутный фильм ещё раз.",
      replayFilm: "↻ Повторить фильм 05:00",
      dirs: ["С", "СВ", "В 🌅", "ЮВ", "Ю", "ЮЗ", "З 🌇", "СЗ"],
    },
  };

  function parseSrt(txt) {
    if (!txt) return [];
    return txt
      .replace(/\r\n/g, "\n")
      .trim()
      .split(/\n\s*\n/)
      .map((block) => {
        const lines = block.trim().split("\n");
        const m = (lines[1] || "").match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
        if (!m) return null;
        const t0 = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
        const t1 = +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000;
        return { t0, t1, text: lines.slice(2).join("<br>") };
      })
      .filter(Boolean);
  }

  let hlsPromise = null;
  function ensureHlsJs() {
    if (window.Hls) return Promise.resolve(window.Hls);
    if (hlsPromise) return hlsPromise;
    hlsPromise = new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = HLS_CDN;
      s.async = true;
      s.onload = () => resolve(window.Hls || null);
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
    return hlsPromise;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function wrapYaw(y) {
    let w = (((y + 180) % 360) + 360) % 360 - 180;
    return w === -180 ? 180 : w;
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const s = Math.floor(sec);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + ":" + (r < 10 ? "0" : "") + r;
  }

  function buildSphereGeometry(lonSegs, latSegs) {
    const positions = [];
    const uvs = [];
    const indices = [];

    for (let lat = 0; lat <= latSegs; lat++) {
      const v = lat / latSegs;
      const phi = (0.5 - v) * Math.PI;
      const cosPhi = Math.cos(phi);
      const sinPhi = Math.sin(phi);

      for (let lon = 0; lon <= lonSegs; lon++) {
        const u = lon / lonSegs;
        const lam = (u - 0.5) * 2 * Math.PI;
        const x = cosPhi * Math.sin(lam);
        const y = sinPhi;
        const z = -cosPhi * Math.cos(lam);
        positions.push(x, y, z);
        uvs.push(u, v);
      }
    }

    const stride = lonSegs + 1;
    for (let lat = 0; lat < latSegs; lat++) {
      for (let lon = 0; lon < lonSegs; lon++) {
        const a = lat * stride + lon;
        const b = a + stride;
        indices.push(a, b, a + 1);
        indices.push(b, b + 1, a + 1);
      }
    }

    return {
      positions: new Float32Array(positions),
      uvs: new Float32Array(uvs),
      indices: new Uint16Array(indices),
    };
  }

  const VS_SRC = `
    attribute vec3 a_pos;
    attribute vec2 a_uv;
    uniform vec3 u_right;
    uniform vec3 u_up;
    uniform vec3 u_fwd;
    uniform float u_tanX;
    uniform float u_tanY;
    varying vec2 v_uv;
    void main() {
      float xc = dot(a_pos, u_right);
      float yc = dot(a_pos, u_up);
      float zf = dot(a_pos, u_fwd);
      float near = 0.05;
      float far = 4.0;
      float zeye = -zf;
      float zclip = -((far + near) / (far - near)) * zeye - (2.0 * far * near) / (far - near);
      gl_Position = vec4(xc / u_tanX, yc / u_tanY, zclip, zf);
      v_uv = a_uv;
    }
  `;

  const FS_SRC = `
    precision mediump float;
    varying vec2 v_uv;
    uniform sampler2D u_tex;
    uniform float u_ready;
    void main() {
      if (u_ready < 0.5) {
        float g = mix(0.05, 0.13, 1.0 - v_uv.y);
        gl_FragColor = vec4(g * 0.72, g, g * 0.80, 1.0);
        return;
      }
      gl_FragColor = texture2D(u_tex, v_uv);
    }
  `;

  function compileShader(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error("DLZ360 shader compile error: " + log);
    }
    return sh;
  }

  class DLZ360Player {
    constructor(container, opts) {
      this.root = typeof container === "string" ? document.getElementById(container) : container;
      this.opts = Object.assign(
        {
          masterHlsSrc: "",
          hlsSrc: "",
          audioTrackName: "",
          mp4Src: "",
          panoSrc: "",
          audioSrc: "",
          audioLoop: false,
          poster: "",
          holdPoster: "",
          srtSrc: "",
          ccDefault: true,
          badgeText: "",
          enterTitleText: "",
          enterSubText: "",
          guideTargets: [],
          timedHotspots: [],
          endRoutes: [],
          onSelectRoute: null,
          lang: "en",
          yaw: 0,
          pitch: 2,
          hfov: 90,
          minHfov: 38,
          maxHfov: 108,
          autoplay: false,
          startTime: 0,
          loop: true,
          muted: false,
          chapters: [],
          telemetryText: "",
          editionLabel: "",
          creditHtml: "",
          showControls: true,
          onFrame: null,
          onTapSphere: null,
          onTimeChapter: null,
          onToggleLang: null,
        },
        opts || {}
      );

      this.lang = this.opts.lang === "ru" ? "ru" : "en";
      this.isPano = !!(this.opts.panoSrc && !this.opts.masterHlsSrc && !this.opts.hlsSrc && !this.opts.mp4Src);
      this.yaw = this.opts.yaw;
      this.pitch = this.opts.pitch;
      this.hfov = this.opts.hfov;
      this.velYaw = 0;
      this.velPitch = 0;

      this.destroyed = false;
      this.hasFrame = false;
      this.userEntered = !!this.opts.autoplay;
      this.isDragging = false;
      this.gyroEnabled = false;
      this.gyroBase = null;
      this.guideEnabled = false;
      this.ccEnabled = !!this.opts.ccDefault;
      this.cues = [];
      this._loadedSrtUrl = "";
      this._holdImg = null;
      this._endModalOpen = false;
      this.hls = null;
      this._loadedMasterUrl = "";
      this._loadedPanoUrl = "";
      this.pins = new Map();
      this.keys = new Set();
      this.idleTimer = 0;

      if (this.opts.holdPoster) {
        this._preloadHoldPoster(this.opts.holdPoster);
      }

      this._buildDOM();
      this._initWebGL();
      this._bindEvents();
      this.setSource({
        masterHlsSrc: this.opts.masterHlsSrc,
        hlsSrc: this.opts.hlsSrc,
        audioTrackName: this.opts.audioTrackName,
        mp4Src: this.opts.mp4Src,
        panoSrc: this.opts.panoSrc,
        audioSrc: this.opts.audioSrc,
        srtSrc: this.opts.srtSrc,
        badgeText: this.opts.badgeText,
        enterTitleText: this.opts.enterTitleText,
        enterSubText: this.opts.enterSubText,
        poster: this.opts.poster,
        startTime: this.opts.startTime,
        editionLabel: this.opts.editionLabel,
        lang: this.lang,
        chapters: this.opts.chapters,
      });
      this._tick = this._tick.bind(this);
      this.raf = requestAnimationFrame(this._tick);
    }

    _preloadHoldPoster(src) {
      if (!src) return;
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = src;
      this._holdImg = img;
    }

    _loadSrt(url) {
      if (!url) {
        this.cues = [];
        this._loadedSrtUrl = "";
        if (this.ccBtn) this.ccBtn.hidden = true;
        if (this.captionEl) this.captionEl.hidden = true;
        return;
      }
      if (this.ccBtn) this.ccBtn.hidden = false;
      if (this._loadedSrtUrl === url && this.cues.length) return;
      this._loadedSrtUrl = url;
      fetch(url)
        .then((r) => (r.ok ? r.text() : ""))
        .then((txt) => {
          if (this.destroyed || this._loadedSrtUrl !== url) return;
          this.cues = parseSrt(txt);
        })
        .catch(() => {
          if (this._loadedSrtUrl === url) this.cues = [];
        });
    }

    _yieldGuide() {
      if (!this.guideEnabled) return;
      this.guideEnabled = false;
      if (this.guideBtn) {
        this.guideBtn.setAttribute("aria-pressed", "false");
        this.guideBtn.textContent = this._L().guideOff;
      }
    }

    _L() {
      return I18N[this.lang] || I18N.en;
    }

    _media() {
      return this.isPano ? this.audio : this.video;
    }

    _buildDOM() {
      const L = this._L();
      this.wrap = document.createElement("div");
      this.wrap.className = "dlz360-wrap";
      this.wrap.tabIndex = 0;
      this.wrap.setAttribute("role", "application");
      this.wrap.setAttribute("aria-label", L.ariaApp);

      this.canvas = document.createElement("canvas");
      this.canvas.className = "dlz360-canvas";
      this.wrap.appendChild(this.canvas);

      this.posterEl = document.createElement("img");
      this.posterEl.className = "dlz360-poster";
      this.posterEl.alt = "";
      if (!this.opts.poster) this.posterEl.hidden = true;
      else this.posterEl.src = this.opts.poster;
      this.wrap.appendChild(this.posterEl);

      this.pinLayer = document.createElement("div");
      this.pinLayer.className = "dlz360-pins";
      this.wrap.appendChild(this.pinLayer);

      this.timedPinEl = document.createElement("button");
      this.timedPinEl.type = "button";
      this.timedPinEl.className = "dlz360-timed-pin";
      this.timedPinEl.hidden = true;
      this.wrap.appendChild(this.timedPinEl);

      this.timedNoteEl = document.createElement("div");
      this.timedNoteEl.className = "dlz360-timed-note";
      this.timedNoteEl.hidden = true;
      this.wrap.appendChild(this.timedNoteEl);

      this.overlayLayer = document.createElement("div");
      this.overlayLayer.className = "dlz360-overlay";
      this.wrap.appendChild(this.overlayLayer);

      this.captionEl = document.createElement("div");
      this.captionEl.className = "dlz360-caption";
      this.captionEl.hidden = true;
      this.wrap.appendChild(this.captionEl);

      this.topHud = document.createElement("div");
      this.topHud.className = "dlz360-top";
      this.topHud.innerHTML = `
        <div class="dlz360-top-main">
          <div class="dlz360-compass" aria-hidden="true">
            <div class="dlz360-compass-track"></div>
            <span class="dlz360-compass-readout">000° N</span>
          </div>
          <div class="dlz360-badges">
            <span class="dlz360-badge dlz360-live-pill">${this.opts.badgeText || (this.isPano ? L.vrBadgePano : L.vrBadgeVideo)}</span>
            <span class="dlz360-badge dlz360-ed-pill" ${this.opts.editionLabel ? "" : "hidden"}>${this.opts.editionLabel || ""}</span>
            <span class="dlz360-badge dlz360-wx-pill" ${this.opts.telemetryText ? "" : "hidden"}>${this.opts.telemetryText || ""}</span>
          </div>
        </div>
        <div class="dlz360-top-sub"></div>
      `;
      this.compassReadout = this.topHud.querySelector(".dlz360-compass-readout");
      this.vrPill = this.topHud.querySelector(".dlz360-live-pill");
      this.edPill = this.topHud.querySelector(".dlz360-ed-pill");
      this.wxPill = this.topHud.querySelector(".dlz360-wx-pill");
      this.topSub = this.topHud.querySelector(".dlz360-top-sub");
      this.wrap.appendChild(this.topHud);

      this.bigPlay = document.createElement("button");
      this.bigPlay.type = "button";
      this.bigPlay.className = "dlz360-bigplay";
      this.bigPlay.innerHTML = `
        <span class="dlz360-bigplay-ic">▶</span>
        <b class="dlz360-bp-t">${this.opts.enterTitleText || (this.isPano ? L.enterTitlePano : L.enterTitleVideo)}</b>
        <small class="dlz360-bp-s">${this.opts.enterSubText || L.enterSub}</small>
      `;
      this.bpTitle = this.bigPlay.querySelector(".dlz360-bp-t");
      this.bpSub = this.bigPlay.querySelector(".dlz360-bp-s");
      if (this.opts.autoplay) this.bigPlay.hidden = true;
      this.wrap.appendChild(this.bigPlay);

      this.endModal = document.createElement("div");
      this.endModal.className = "dlz360-endmodal";
      this.endModal.hidden = true;
      this.wrap.appendChild(this.endModal);
      this._renderEndModal();

      const hasGuide = Array.isArray(this.opts.guideTargets) && this.opts.guideTargets.length > 0;
      this.botHud = document.createElement("div");
      this.botHud.className = "dlz360-bot";
      this.botHud.innerHTML = `
        <div class="dlz360-chapters" hidden></div>
        <div class="dlz360-scrub-row">
          <input type="range" class="dlz360-scrub" min="0" max="1000" value="0" step="1" aria-label="Seek timeline">
        </div>
        <div class="dlz360-ctrl-row">
          <button type="button" class="dlz360-btn dlz360-play">${L.play}</button>
          <button type="button" class="dlz360-btn dlz360-mute">${this.opts.muted ? L.unmute : L.sound}</button>
          <button type="button" class="dlz360-btn dlz360-lang" ${typeof this.opts.onToggleLang === "function" ? "" : "hidden"}>${L.langBtn}</button>
          <button type="button" class="dlz360-btn dlz360-cc" ${this.opts.srtSrc ? "" : "hidden"} aria-pressed="${this.ccEnabled}">${this.ccEnabled ? L.ccOn : L.ccOff}</button>
          <button type="button" class="dlz360-btn dlz360-guide" ${hasGuide ? "" : "hidden"} aria-pressed="false" title="Gently point toward active wildlife; yields immediately when you drag">${L.guideOff}</button>
          <span class="dlz360-time">0:00 / 0:00</span>
          <div class="dlz360-spacer"></div>
          <button type="button" class="dlz360-btn dlz360-gyro" hidden aria-pressed="false">${L.tilt}</button>
          <button type="button" class="dlz360-btn dlz360-zout" title="Zoom out" aria-label="Zoom out">−</button>
          <button type="button" class="dlz360-btn dlz360-zin" title="Zoom in" aria-label="Zoom in">+</button>
          <button type="button" class="dlz360-btn dlz360-recenter" title="Reset view center" aria-label="Center view">⌖</button>
          <button type="button" class="dlz360-btn dlz360-fs" title="Full screen (F)" aria-label="Full screen">⛶</button>
        </div>
      `;
      this.chaptersEl = this.botHud.querySelector(".dlz360-chapters");
      this.scrubEl = this.botHud.querySelector(".dlz360-scrub");
      this.playBtn = this.botHud.querySelector(".dlz360-play");
      this.muteBtn = this.botHud.querySelector(".dlz360-mute");
      this.langBtn = this.botHud.querySelector(".dlz360-lang");
      this.ccBtn = this.botHud.querySelector(".dlz360-cc");
      this.guideBtn = this.botHud.querySelector(".dlz360-guide");
      this.timeEl = this.botHud.querySelector(".dlz360-time");
      this.gyroBtn = this.botHud.querySelector(".dlz360-gyro");
      this.fsBtn = this.botHud.querySelector(".dlz360-fs");
      if ("DeviceOrientationEvent" in window && matchMedia("(pointer: coarse)").matches) {
        this.gyroBtn.hidden = false;
      }
      this._renderChapters();
      this.wrap.appendChild(this.botHud);

      if (this.opts.creditHtml) {
        this.setCredit(this.opts.creditHtml);
      }

      this.video = document.createElement("video");
      this.video.playsInline = true;
      this.video.setAttribute("playsinline", "");
      this.video.setAttribute("webkit-playsinline", "");
      this.video.crossOrigin = "anonymous";
      this.video.preload = "auto";
      this.video.loop = !!this.opts.loop;
      this.video.muted = !!this.opts.muted;

      this.audio = document.createElement("audio");
      this.audio.crossOrigin = "anonymous";
      this.audio.preload = "auto";
      this.audio.loop = !!this.opts.audioLoop;
      this.audio.muted = !!this.opts.muted;

      this.root.appendChild(this.wrap);
      this.root._dlz360 = this;
    }

    _renderEndModal() {
      if (!this.endModal) return;
      const routes = this.opts.endRoutes || [];
      if (!routes.length) {
        this.endModal.innerHTML = "";
        return;
      }
      const L = this._L();
      const cards = routes
        .map((r) => {
          const title = typeof r.label === "object" ? r.label[this.lang] || r.label.en : r.label;
          const sub = typeof r.sub === "object" ? r.sub[this.lang] || r.sub.en : r.sub || "";
          return `<button type="button" class="dlz360-route-btn" data-route-id="${r.id}">
            <b>${title}</b>
            ${sub ? `<span>${sub}</span>` : ""}
          </button>`;
        })
        .join("");
      this.endModal.innerHTML = `
        <div class="dlz360-endcard">
          <span class="dlz360-endstamp">${L.endStamp}</span>
          <h4>${L.endHeading}</h4>
          <p>${L.endSub}</p>
          <div class="dlz360-routes">${cards}</div>
          <button type="button" class="dlz360-btn dlz360-end-replay">${L.replayFilm}</button>
        </div>
      `;
    }

    setCredit(html) {
      if (!this.creditEl) {
        this.creditEl = document.createElement("div");
        this.creditEl.className = "dlz360-credit";
        (this.topSub || this.wrap).appendChild(this.creditEl);
      }
      this.creditEl.innerHTML = html || "";
      this.creditEl.hidden = !html;
    }

    _syncLocaleTexts() {
      const L = this._L();
      const m = this._media();
      this.wrap.setAttribute("aria-label", L.ariaApp);
      this.vrPill.textContent = this.opts.badgeText || (this.isPano ? L.vrBadgePano : L.vrBadgeVideo);
      this.bpTitle.textContent = this.opts.enterTitleText || (this.isPano ? L.enterTitlePano : L.enterTitleVideo);
      this.bpSub.textContent = this.opts.enterSubText || L.enterSub;
      this.playBtn.textContent = m.paused ? (m.ended ? L.replay : L.play) : L.pause;
      this._syncAudioBtn();
      this.langBtn.textContent = L.langBtn;
      if (this.ccBtn) {
        this.ccBtn.textContent = this.ccEnabled ? L.ccOn : L.ccOff;
        this.ccBtn.setAttribute("aria-pressed", String(this.ccEnabled));
      }
      if (this.guideBtn) {
        this.guideBtn.textContent = this.guideEnabled ? L.guideOn : L.guideOff;
        this.guideBtn.setAttribute("aria-pressed", String(this.guideEnabled));
      }
      this.gyroBtn.textContent = this.gyroEnabled ? L.tilting : L.tilt;
      this._renderEndModal();
      this._updateCompass();
    }

    _renderChapters() {
      const ch = this.opts.chapters || [];
      if (!ch.length) {
        this.chaptersEl.hidden = true;
        return;
      }
      this.chaptersEl.hidden = false;
      this.chaptersEl.innerHTML = ch
        .map(
          (c, idx) =>
            `<button type="button" class="dlz360-chap" data-ch="${idx}" data-t="${c.time}">${c.label}</button>`
        )
        .join("");
    }

    _initWebGL() {
      const gl =
        this.canvas.getContext("webgl", {
          antialias: true,
          alpha: false,
          preserveDrawingBuffer: true,
          powerPreference: "high-performance",
        }) || this.canvas.getContext("experimental-webgl", { preserveDrawingBuffer: true });
      if (!gl) throw new Error("WebGL unavailable");
      this.gl = gl;

      const vs = compileShader(gl, gl.VERTEX_SHADER, VS_SRC);
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, FS_SRC);
      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      gl.useProgram(prog);
      this.prog = prog;

      const geom = buildSphereGeometry(72, 48);
      this.indexCount = geom.indices.length;

      this.posBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, geom.positions, gl.STATIC_DRAW);
      const aPos = gl.getAttribLocation(prog, "a_pos");
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);

      this.uvBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
      gl.bufferData(gl.ARRAY_BUFFER, geom.uvs, gl.STATIC_DRAW);
      const aUv = gl.getAttribLocation(prog, "a_uv");
      gl.enableVertexAttribArray(aUv);
      gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);

      this.idxBuf = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geom.indices, gl.STATIC_DRAW);

      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([14, 24, 18, 255]));

      this.uRight = gl.getUniformLocation(prog, "u_right");
      this.uUp = gl.getUniformLocation(prog, "u_up");
      this.uFwd = gl.getUniformLocation(prog, "u_fwd");
      this.uTanX = gl.getUniformLocation(prog, "u_tanX");
      this.uTanY = gl.getUniformLocation(prog, "u_tanY");
      this.uReady = gl.getUniformLocation(prog, "u_ready");
      gl.uniform1f(this.uReady, 0.0);

      if (this.opts.poster) {
        this._loadImageToSphere(this.opts.poster, false);
      }
    }

    _loadImageToSphere(src, markHasFrame) {
      if (!src) return;
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        if (this.destroyed) return;
        if (!markHasFrame && this.hasFrame) return;
        try {
          const gl = this.gl;
          gl.bindTexture(gl.TEXTURE_2D, this.tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
          gl.uniform1f(this.uReady, 1.0);
          this.posterEl.hidden = true;
          if (markHasFrame) {
            this.hasFrame = true;
            this._loadedPanoUrl = src;
          }
        } catch (e) {}
      };
      img.src = src;
    }

    _selectHlsAudioTrack(trackName) {
      if (!this.hls || !trackName) return false;
      const tracks = this.hls.audioTracks || [];
      if (!tracks.length) return false;
      const idx = tracks.findIndex((t) => t.name === trackName);
      if (idx >= 0) {
        if (this.hls.audioTrack !== idx) {
          this.hls.audioTrack = idx;
        }
        return true;
      }
      return false;
    }

    setSource({
      masterHlsSrc,
      hlsSrc,
      audioTrackName,
      mp4Src,
      panoSrc,
      audioSrc,
      srtSrc,
      badgeText,
      enterTitleText,
      enterSubText,
      preserveTime,
      startTime,
      editionLabel,
      creditHtml,
      lang,
      chapters,
    }) {
      if (lang) {
        this.lang = lang === "ru" ? "ru" : "en";
      }
      if (badgeText !== undefined) {
        this.opts.badgeText = badgeText;
      }
      if (enterTitleText !== undefined) {
        this.opts.enterTitleText = enterTitleText;
      }
      if (enterSubText !== undefined) {
        this.opts.enterSubText = enterSubText;
      }
      if (srtSrc !== undefined) {
        this.opts.srtSrc = srtSrc;
        this._loadSrt(srtSrc);
      }
      if (creditHtml !== undefined) {
        this.setCredit(creditHtml);
      }
      if (chapters !== undefined) {
        this.opts.chapters = chapters;
        this._renderChapters();
      }
      if (audioTrackName !== undefined) {
        this.opts.audioTrackName = audioTrackName;
      }
      if (editionLabel !== undefined) {
        this.opts.editionLabel = editionLabel;
        if (editionLabel) {
          this.edPill.textContent = editionLabel;
          this.edPill.hidden = false;
        } else {
          this.edPill.hidden = true;
        }
      }

      // MODE B: 360° Habitat Panorama + Studio ElevenLabs Audio Guide
      if ((panoSrc || this.isPano) && !masterHlsSrc && !hlsSrc && !mp4Src) {
        this.isPano = true;
        this._syncLocaleTexts();
        const targetPano = panoSrc || this.opts.panoSrc;
        if (targetPano && targetPano !== this._loadedPanoUrl) {
          this.opts.panoSrc = targetPano;
          this._loadImageToSphere(targetPano, true);
        }
        if (audioSrc !== undefined) {
          const prevPlaying = !this.audio.paused || this.userEntered;
          if (audioSrc && this.audio.getAttribute("data-src") !== audioSrc) {
            this.opts.audioSrc = audioSrc;
            this.audio.setAttribute("data-src", audioSrc);
            this.audio.src = audioSrc;
            this.audio.load();
            if (prevPlaying && this.bigPlay.hidden) {
              this.play();
            }
          }
          this.botHud.querySelector(".dlz360-scrub-row").hidden = !audioSrc;
          this.playBtn.hidden = !audioSrc;
          this.muteBtn.hidden = !audioSrc;
          this.timeEl.hidden = !audioSrc;
        }
        return;
      }

      // MODE A: 360° Video Camp (HLS / MP4)
      this.isPano = false;
      this._syncLocaleTexts();
      const targetTime = preserveTime ? this.video.currentTime || 0 : typeof startTime === "number" ? startTime : 0;
      const wasPlaying = preserveTime ? !this.video.paused : !!this.opts.autoplay;

      // Fast path on hls.js: switch ElevenLabs audio rendition in-place with 0ms video interruption
      if (
        preserveTime &&
        this.hls &&
        masterHlsSrc &&
        this._loadedMasterUrl === masterHlsSrc &&
        audioTrackName &&
        this._selectHlsAudioTrack(audioTrackName)
      ) {
        return;
      }

      if (this.hls) {
        try {
          this.hls.destroy();
        } catch (e) {}
        this.hls = null;
        this._loadedMasterUrl = "";
      }

      const finishAttach = () => {
        const onLoaded = () => {
          this.video.removeEventListener("loadedmetadata", onLoaded);
          if (targetTime > 0 && isFinite(this.video.duration)) {
            this.video.currentTime = Math.min(targetTime, Math.max(0, this.video.duration - 0.5));
          }
          if (wasPlaying) {
            this.play();
          }
        };
        this.video.addEventListener("loadedmetadata", onLoaded);
      };

      const canNativeHls =
        (hlsSrc || masterHlsSrc) &&
        (this.video.canPlayType("application/vnd.apple.mpegurl") ||
          this.video.canPlayType("application/x-mpegURL"));

      const attachNativeHls = () => {
        this.video.src = hlsSrc || masterHlsSrc;
        finishAttach();
      };

      if (masterHlsSrc || hlsSrc) {
        const srcToLoad = masterHlsSrc || hlsSrc;
        ensureHlsJs().then((Hls) => {
          if (this.destroyed) return;
          if (Hls && Hls.isSupported() && masterHlsSrc) {
            const hls = new Hls({
              maxBufferLength: 30,
              enableWorker: true,
              startPosition: targetTime > 0 ? targetTime : -1,
            });
            this.hls = hls;
            this._loadedMasterUrl = srcToLoad;
            hls.loadSource(srcToLoad);
            hls.attachMedia(this.video);
            hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
              if (this.opts.audioTrackName) {
                this._selectHlsAudioTrack(this.opts.audioTrackName);
              }
            });
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
              if (this.opts.audioTrackName) {
                this._selectHlsAudioTrack(this.opts.audioTrackName);
              }
              if (targetTime > 0) this.video.currentTime = targetTime;
              if (wasPlaying) this.play();
            });
            hls.on(Hls.Events.ERROR, (_ev, data) => {
              if (data && data.fatal) {
                hls.destroy();
                this.hls = null;
                this._loadedMasterUrl = "";
                if (canNativeHls) attachNativeHls();
                else if (mp4Src && this.video.src !== mp4Src) {
                  this.video.src = mp4Src;
                  finishAttach();
                }
              }
            });
          } else if (canNativeHls) {
            attachNativeHls();
          } else if (mp4Src) {
            this.video.src = mp4Src;
            finishAttach();
          }
        });
      } else if (mp4Src) {
        this.video.src = mp4Src;
        finishAttach();
      }
    }

    setTelemetry(text) {
      this.opts.telemetryText = text || "";
      if (text) {
        this.wxPill.textContent = text;
        this.wxPill.hidden = false;
      } else {
        this.wxPill.hidden = true;
      }
    }

    play() {
      this.userEntered = true;
      this.bigPlay.hidden = true;
      this._endModalOpen = false;
      if (this.endModal) this.endModal.hidden = true;
      const m = this._media();
      if (this.isPano && !this.opts.audioSrc) return;
      if (m.ended) m.currentTime = 0;
      const p = m.play();
      if (p && p.catch) {
        p.catch(() => {
          if (this.isPano) {
            this.userEntered = false;
            this.bigPlay.hidden = false;
            this._syncLocaleTexts();
            return;
          }
          m.muted = true;
          this._syncAudioBtn();
          m.play().catch(() => {});
        });
      }
    }

    pause() {
      this._media().pause();
    }

    seekTo(sec) {
      if (isFinite(sec)) {
        this._endModalOpen = false;
        if (this.endModal) this.endModal.hidden = true;
        this._media().currentTime = Math.max(0, sec);
      }
    }

    lookAt(yaw, pitch, hfov) {
      if (typeof yaw === "number") this.yaw = wrapYaw(yaw);
      if (typeof pitch === "number") this.pitch = clamp(pitch, -85, 85);
      if (typeof hfov === "number") this.hfov = clamp(hfov, this.opts.minHfov, this.opts.maxHfov);
      this.velYaw = 0;
      this.velPitch = 0;
    }

    getYaw() {
      return this.yaw;
    }

    getPitch() {
      return this.pitch;
    }

    getHfov() {
      return this.hfov;
    }

    getCurrentTime() {
      return this._media().currentTime || 0;
    }

    getDuration() {
      return this._media().duration || 0;
    }

    _cameraBasis() {
      const lam = this.yaw * DEG2RAD;
      const phi = this.pitch * DEG2RAD;
      const cosPhi = Math.cos(phi);
      const sinPhi = Math.sin(phi);
      const cosLam = Math.cos(lam);
      const sinLam = Math.sin(lam);

      const fwd = [cosPhi * sinLam, sinPhi, -cosPhi * cosLam];
      const right = [cosLam, 0, sinLam];
      const up = [-sinPhi * sinLam, cosPhi, sinPhi * cosLam];
      const w = Math.max(1, this.canvas.clientWidth || 640);
      const h = Math.max(1, this.canvas.clientHeight || 400);
      const tanX = Math.tan((this.hfov * DEG2RAD) / 2);
      const tanY = tanX * (h / w);
      return { fwd, right, up, tanX, tanY, w, h };
    }

    screenToCoords(clientX, clientY) {
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
      const { fwd, right, up, tanX, tanY } = this._cameraBasis();
      let dx = fwd[0] + ndcX * tanX * right[0] + ndcY * tanY * up[0];
      let dy = fwd[1] + ndcX * tanX * right[1] + ndcY * tanY * up[1];
      let dz = fwd[2] + ndcX * tanX * right[2] + ndcY * tanY * up[2];
      const len = Math.hypot(dx, dy, dz) || 1;
      dx /= len;
      dy /= len;
      dz /= len;
      const pitch = Math.asin(clamp(dy, -1, 1)) * RAD2DEG;
      const yaw = Math.atan2(dx, -dz) * RAD2DEG;
      return { yaw: wrapYaw(yaw), pitch };
    }

    coordsToScreen(yaw, pitch) {
      const lam = yaw * DEG2RAD;
      const phi = pitch * DEG2RAD;
      const px = Math.cos(phi) * Math.sin(lam);
      const py = Math.sin(phi);
      const pz = -Math.cos(phi) * Math.cos(lam);
      const { fwd, right, up, tanX, tanY, w, h } = this._cameraBasis();
      const zf = px * fwd[0] + py * fwd[1] + pz * fwd[2];
      if (zf <= 0.08) return { visible: false, x: 0, y: 0 };
      const xc = px * right[0] + py * right[1] + pz * right[2];
      const yc = px * up[0] + py * up[1] + pz * up[2];
      const ndcX = xc / (zf * tanX);
      const ndcY = yc / (zf * tanY);
      if (Math.abs(ndcX) > 1.25 || Math.abs(ndcY) > 1.25) {
        return { visible: false, x: 0, y: 0 };
      }
      return {
        visible: true,
        x: (ndcX * 0.5 + 0.5) * w,
        y: (0.5 - ndcY * 0.5) * h,
      };
    }

    addPin(id, yaw, pitch, label, onClick) {
      if (this.pins.has(id)) {
        const existing = this.pins.get(id);
        existing.el.title = label || id;
        existing.el.setAttribute("aria-label", label || id);
        return;
      }
      const el = document.createElement("button");
      el.type = "button";
      el.className = "found-pin dlz360-pin";
      el.title = label || id;
      el.setAttribute("aria-label", label || id);
      if (onClick) {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          onClick();
        });
      }
      this.pinLayer.appendChild(el);
      this.pins.set(id, { id, yaw, pitch, el });
    }

    clearPins() {
      this.pins.forEach((p) => p.el.remove());
      this.pins.clear();
    }

    _syncAudioBtn() {
      const L = this._L();
      const m = this._media();
      this.muteBtn.textContent = m.muted ? L.unmute : L.sound;
    }

    _wakeHud() {
      this.wrap.classList.remove("dlz360-idle");
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if (!this._media().paused && this.wrap.classList.contains("dlz360-full")) {
          this.wrap.classList.add("dlz360-idle");
        }
      }, 3200);
    }

    _toggleFullscreen() {
      const isCssFull = this.wrap.classList.contains("dlz360-cssfull");
      const isNativeFull = document.fullscreenElement === this.wrap || document.webkitFullscreenElement === this.wrap;
      if (isNativeFull) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        return;
      }
      if (isCssFull) {
        this.wrap.classList.remove("dlz360-cssfull", "dlz360-full");
        document.documentElement.classList.remove("fslock");
        return;
      }
      const req = this.wrap.requestFullscreen || this.wrap.webkitRequestFullscreen;
      if (req) {
        const res = req.call(this.wrap);
        if (res && res.catch) {
          res.catch(() => {
            this.wrap.classList.add("dlz360-cssfull", "dlz360-full");
            document.documentElement.classList.add("fslock");
          });
        }
      } else {
        this.wrap.classList.add("dlz360-cssfull", "dlz360-full");
        document.documentElement.classList.add("fslock");
      }
    }

    _toggleGyro() {
      const L = this._L();
      this._yieldGuide();
      if (this.gyroEnabled) {
        this.gyroEnabled = false;
        this.gyroBase = null;
        this.gyroBtn.setAttribute("aria-pressed", "false");
        this.gyroBtn.textContent = L.tilt;
        window.removeEventListener("deviceorientation", this._onDeviceOrientation);
        return;
      }
      const enable = () => {
        this.gyroEnabled = true;
        this.gyroBase = null;
        this.gyroBtn.setAttribute("aria-pressed", "true");
        this.gyroBtn.textContent = this._L().tilting;
        window.addEventListener("deviceorientation", this._onDeviceOrientation);
      };
      if (
        typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function"
      ) {
        DeviceOrientationEvent.requestPermission()
          .then((state) => {
            if (state === "granted") enable();
          })
          .catch(() => {});
      } else {
        enable();
      }
    }

    _bindEvents() {
      const pointers = new Map();
      let downInfo = null;
      let pinchDist0 = 0;
      let pinchHfov0 = this.hfov;

      this._onDeviceOrientation = (e) => {
        if (!this.gyroEnabled || e.alpha == null || e.beta == null) return;
        this._yieldGuide();
        if (!this.gyroBase) {
          this.gyroBase = { alpha: e.alpha, beta: e.beta, yaw0: this.yaw, pitch0: this.pitch };
          return;
        }
        const dYaw = -(e.alpha - this.gyroBase.alpha);
        const dPitch = clamp(e.beta - this.gyroBase.beta, -75, 75);
        this.yaw = wrapYaw(this.gyroBase.yaw0 + dYaw);
        this.pitch = clamp(this.gyroBase.pitch0 + dPitch * 0.85, -80, 80);
      };

      const onPointerDown = (e) => {
        if (
          e.target.closest(".dlz360-bot") ||
          e.target.closest(".dlz360-bigplay") ||
          e.target.closest(".dlz360-endmodal") ||
          e.target.closest(".dlz360-timed-pin") ||
          e.target.closest(".dlz360-timed-note") ||
          e.target.closest(".dlz360-pin") ||
          e.target.closest(".lens-toggle") ||
          e.target.closest(".dlz360-credit")
        ) {
          return;
        }
        this._yieldGuide();
        if (this.isPano && !this.bigPlay.hidden) {
          this.play();
        }
        this._wakeHud();
        this.wrap.focus({ preventScroll: true });
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        try {
          this.canvas.setPointerCapture(e.pointerId);
        } catch (err) {}

        if (pointers.size === 1) {
          this.isDragging = true;
          this.velYaw = 0;
          this.velPitch = 0;
          const nowT = performance.now();
          downInfo = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, t: nowT, lastMoveT: nowT, moved: 0 };
        } else if (pointers.size === 2) {
          const pts = Array.from(pointers.values());
          pinchDist0 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          pinchHfov0 = this.hfov;
          downInfo = null;
        }
      };

      const onPointerMove = (e) => {
        this._wakeHud();
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (pointers.size === 2 && pinchDist0 > 10) {
          const pts = Array.from(pointers.values());
          const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          if (dist > 10) {
            this.hfov = clamp(pinchHfov0 * (pinchDist0 / dist), this.opts.minHfov, this.opts.maxHfov);
          }
          return;
        }

        if (pointers.size === 1 && downInfo) {
          const dx = e.clientX - downInfo.lastX;
          const dy = e.clientY - downInfo.lastY;
          downInfo.lastX = e.clientX;
          downInfo.lastY = e.clientY;
          downInfo.lastMoveT = performance.now();
          downInfo.moved += Math.hypot(dx, dy);

          const w = Math.max(240, this.canvas.clientWidth || 640);
          const degPerPx = this.hfov / w;
          const dYaw = -dx * degPerPx;
          const dPitch = dy * degPerPx;
          this.yaw = wrapYaw(this.yaw + dYaw);
          this.pitch = clamp(this.pitch + dPitch, -85, 85);
          this.velYaw = clamp(dYaw * 0.25, -2.5, 2.5);
          this.velPitch = clamp(dPitch * 0.25, -1.8, 1.8);
        }
      };

      const onPointerUp = (e) => {
        pointers.delete(e.pointerId);
        if (pointers.size === 0) {
          this.isDragging = false;
          if (downInfo) {
            if (performance.now() - downInfo.lastMoveT > 60) {
              this.velYaw = 0;
              this.velPitch = 0;
            }
            if (downInfo.moved < 9 && performance.now() - downInfo.t < 550) {
              const coords = this.screenToCoords(e.clientX, e.clientY);
              if (coords && typeof this.opts.onTapSphere === "function") {
                this.opts.onTapSphere(coords.yaw, coords.pitch, e);
              }
            }
          }
          downInfo = null;
        }
      };

      this.canvas.addEventListener("pointerdown", onPointerDown);
      this.canvas.addEventListener("pointermove", onPointerMove);
      this.canvas.addEventListener("pointerup", onPointerUp);
      this.canvas.addEventListener("pointercancel", onPointerUp);

      this.canvas.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          this._yieldGuide();
          this.hfov = clamp(this.hfov + (e.deltaY > 0 ? 4.5 : -4.5), this.opts.minHfov, this.opts.maxHfov);
        },
        { passive: false }
      );

      this.bigPlay.addEventListener("click", () => {
        this.bigPlay.hidden = true;
        this.play();
      });

      this.playBtn.addEventListener("click", () => {
        const m = this._media();
        if (m.paused) this.play();
        else this.pause();
      });

      this.muteBtn.addEventListener("click", () => {
        const nextMuted = !this._media().muted;
        this.video.muted = nextMuted;
        this.audio.muted = nextMuted;
        this._syncAudioBtn();
      });

      this.langBtn.addEventListener("click", () => {
        if (typeof this.opts.onToggleLang === "function") {
          this.opts.onToggleLang();
        }
      });

      if (this.ccBtn) {
        this.ccBtn.addEventListener("click", () => {
          this.ccEnabled = !this.ccEnabled;
          const L = this._L();
          this.ccBtn.setAttribute("aria-pressed", String(this.ccEnabled));
          this.ccBtn.textContent = this.ccEnabled ? L.ccOn : L.ccOff;
          if (!this.ccEnabled && this.captionEl) this.captionEl.hidden = true;
        });
      }

      if (this.guideBtn) {
        this.guideBtn.addEventListener("click", () => {
          this.guideEnabled = !this.guideEnabled;
          const L = this._L();
          this.guideBtn.setAttribute("aria-pressed", String(this.guideEnabled));
          this.guideBtn.textContent = this.guideEnabled ? L.guideOn : L.guideOff;
        });
      }

      if (this.timedPinEl) {
        this.timedPinEl.addEventListener("click", (e) => {
          e.stopPropagation();
          const hs = this._activeTimedHotspot;
          if (!hs || !this.timedNoteEl) return;
          const title = typeof hs.label === "object" ? hs.label[this.lang] || hs.label.en : hs.label;
          const note = typeof hs.note === "object" ? hs.note[this.lang] || hs.note.en : hs.note;
          this.timedNoteEl.innerHTML = `<button type="button" class="dlz360-tn-close" aria-label="Close">×</button><b>${title}</b><p>${note}</p>`;
          this.timedNoteEl.hidden = false;
        });
      }

      if (this.timedNoteEl) {
        this.timedNoteEl.addEventListener("click", (e) => {
          if (e.target.closest(".dlz360-tn-close")) {
            this.timedNoteEl.hidden = true;
          }
        });
      }

      if (this.endModal) {
        this.endModal.addEventListener("click", (e) => {
          const rb = e.target.closest("[data-route-id]");
          if (rb) {
            const rid = rb.getAttribute("data-route-id");
            if (rid && typeof this.opts.onSelectRoute === "function") {
              this.opts.onSelectRoute(rid);
            }
            return;
          }
          if (e.target.closest(".dlz360-end-replay")) {
            this._endModalOpen = false;
            this.endModal.hidden = true;
            this.seekTo(0);
            this.play();
          }
        });
      }

      this.botHud.querySelector(".dlz360-zin").addEventListener("click", () => {
        this.hfov = clamp(this.hfov - 10, this.opts.minHfov, this.opts.maxHfov);
      });
      this.botHud.querySelector(".dlz360-zout").addEventListener("click", () => {
        this.hfov = clamp(this.hfov + 10, this.opts.minHfov, this.opts.maxHfov);
      });
      this.botHud.querySelector(".dlz360-recenter").addEventListener("click", () => {
        this._yieldGuide();
        this.lookAt(this.opts.yaw || 0, this.opts.pitch || 2, 90);
      });
      this.fsBtn.addEventListener("click", () => this._toggleFullscreen());
      this.gyroBtn.addEventListener("click", () => this._toggleGyro());

      this.scrubEl.addEventListener("input", () => {
        const m = this._media();
        const dur = m.duration;
        if (isFinite(dur) && dur > 0) {
          this._endModalOpen = false;
          if (this.endModal) this.endModal.hidden = true;
          m.currentTime = (Number(this.scrubEl.value) / 1000) * dur;
        }
      });

      this.chaptersEl.addEventListener("click", (e) => {
        const b = e.target.closest("[data-t]");
        if (!b) return;
        const t = parseFloat(b.dataset.t);
        if (isFinite(t)) {
          this.seekTo(t);
          if (this._media().paused) this.play();
        }
      });

      [this.video, this.audio].forEach((m) => {
        m.addEventListener("play", () => {
          if (m !== this._media()) return;
          this.bigPlay.hidden = true;
          this._endModalOpen = false;
          if (this.endModal) this.endModal.hidden = true;
          this.playBtn.textContent = this._L().pause;
          this._wakeHud();
        });
        m.addEventListener("pause", () => {
          if (m !== this._media()) return;
          this.playBtn.textContent = m.ended ? this._L().replay : this._L().play;
          this.wrap.classList.remove("dlz360-idle");
        });
        m.addEventListener("ended", () => {
          if (m !== this._media()) return;
          this.playBtn.textContent = this._L().replay;
          if (!this.isPano && !this.opts.loop && (this.opts.endRoutes || []).length > 0 && this.endModal) {
            this._endModalOpen = true;
            this.endModal.hidden = false;
            if (this.captionEl) this.captionEl.hidden = true;
            if (this.timedPinEl) this.timedPinEl.hidden = true;
          }
        });
      });

      this._onFsChange = () => {
        const on = document.fullscreenElement === this.wrap || document.webkitFullscreenElement === this.wrap;
        this.wrap.classList.toggle("dlz360-full", on);
      };
      document.addEventListener("fullscreenchange", this._onFsChange);
      document.addEventListener("webkitfullscreenchange", this._onFsChange);

      this.wrap.addEventListener("keydown", (e) => {
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "KeyW", "KeyA", "KeyS", "KeyD"].includes(e.code)) {
          e.preventDefault();
          this._yieldGuide();
          this.keys.add(e.code);
        } else if (e.code === "Space") {
          e.preventDefault();
          if (this._media().paused) this.play();
          else this.pause();
        } else if (e.code === "KeyF") {
          e.preventDefault();
          this._toggleFullscreen();
        } else if (e.code === "KeyM") {
          e.preventDefault();
          const nm = !this._media().muted;
          this.video.muted = nm;
          this.audio.muted = nm;
          this._syncAudioBtn();
        }
      });
      this.wrap.addEventListener("keyup", (e) => this.keys.delete(e.code));
      this.wrap.addEventListener("blur", () => this.keys.clear());
    }

    _updateCompass() {
      const brg = ((Math.round(this.yaw) % 360) + 360) % 360;
      const dirs = this._L().dirs;
      const dir = dirs[Math.round(brg / 45) % 8];
      this.compassReadout.textContent = String(brg).padStart(3, "0") + "° " + dir;
    }

    _updateTimeline() {
      const m = this._media();
      const cur = m.currentTime || 0;
      const dur = m.duration || 0;
      if (isFinite(dur) && dur > 0) {
        if (document.activeElement !== this.scrubEl) {
          this.scrubEl.value = String(Math.round((cur / dur) * 1000));
        }
        this.timeEl.textContent = fmtTime(cur) + " / " + fmtTime(dur);
      }
      const ch = this.opts.chapters || [];
      if (ch.length && !this.isPano) {
        let activeIdx = 0;
        for (let i = 0; i < ch.length; i++) {
          if (cur >= ch[i].time - 0.25) activeIdx = i;
        }
        this.chaptersEl.querySelectorAll(".dlz360-chap").forEach((btn, idx) => {
          btn.classList.toggle("active", idx === activeIdx);
        });
        if (this._lastChap !== activeIdx) {
          this._lastChap = activeIdx;
          if (typeof this.opts.onTimeChapter === "function") {
            this.opts.onTimeChapter(activeIdx, ch[activeIdx]);
          }
        }
      }
    }

    _tick() {
      if (this.destroyed) return;
      this.raf = requestAnimationFrame(this._tick);

      const curT = !this.isPano ? this.video.currentTime || 0 : 0;

      if (this.keys.size) {
        const spd = 1.6;
        if (this.keys.has("ArrowLeft") || this.keys.has("KeyA")) this.yaw = wrapYaw(this.yaw - spd);
        if (this.keys.has("ArrowRight") || this.keys.has("KeyD")) this.yaw = wrapYaw(this.yaw + spd);
        if (this.keys.has("ArrowUp") || this.keys.has("KeyW")) this.pitch = clamp(this.pitch + spd * 0.8, -85, 85);
        if (this.keys.has("ArrowDown") || this.keys.has("KeyS")) this.pitch = clamp(this.pitch - spd * 0.8, -85, 85);
      } else if (!this.isDragging && (Math.abs(this.velYaw) > 0.01 || Math.abs(this.velPitch) > 0.01)) {
        this.yaw = wrapYaw(this.yaw + this.velYaw);
        this.pitch = clamp(this.pitch + this.velPitch, -85, 85);
        this.velYaw *= 0.90;
        this.velPitch *= 0.90;
      } else if (this.guideEnabled && !this.isPano && !this._endModalOpen && (this.opts.guideTargets || []).length) {
        const gt = this.opts.guideTargets.find((g) => curT >= g.t0 && curT < g.t1);
        if (gt) {
          const dY = (((gt.yaw - this.yaw + 540) % 360) - 180);
          this.yaw = wrapYaw(this.yaw + dY * 0.025);
          this.pitch = clamp(this.pitch + (gt.pitch - this.pitch) * 0.025, -85, 85);
        }
      }

      const gl = this.gl;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cw = Math.max(1, Math.floor((this.wrap.clientWidth || 640) * dpr));
      const ch = Math.max(1, Math.floor((this.wrap.clientHeight || 400) * dpr));
      if (this.canvas.width !== cw || this.canvas.height !== ch) {
        this.canvas.width = cw;
        this.canvas.height = ch;
        gl.viewport(0, 0, cw, ch);
      }

      if (
        !this.isPano &&
        (this.video.ended || this._endModalOpen) &&
        this._holdImg &&
        this._holdImg.complete &&
        this._holdImg.naturalWidth > 0
      ) {
        try {
          gl.bindTexture(gl.TEXTURE_2D, this.tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this._holdImg);
          gl.uniform1f(this.uReady, 1.0);
          this.posterEl.hidden = true;
          this.hasFrame = true;
        } catch (e) {}
      } else if (!this.isPano && this.video.readyState >= 2 && this.video.videoWidth > 0) {
        try {
          gl.bindTexture(gl.TEXTURE_2D, this.tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
          if (!this.hasFrame) {
            this.hasFrame = true;
            gl.uniform1f(this.uReady, 1.0);
            this.posterEl.hidden = true;
          }
        } catch (e) {}
      }

      const { fwd, right, up, tanX, tanY } = this._cameraBasis();
      gl.clearColor(0.04, 0.07, 0.05, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.prog);
      gl.uniform3fv(this.uRight, right);
      gl.uniform3fv(this.uUp, up);
      gl.uniform3fv(this.uFwd, fwd);
      gl.uniform1f(this.uTanX, tanX);
      gl.uniform1f(this.uTanY, tanY);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);

      if (this.pins.size) {
        this.pins.forEach((p) => {
          const s = this.coordsToScreen(p.yaw, p.pitch);
          if (!s.visible) {
            p.el.style.display = "none";
          } else {
            p.el.style.display = "block";
            p.el.style.transform = `translate(${s.x - 11}px, ${s.y - 11}px)`;
          }
        });
      }

      // Synchronized .srt subtitles (strictly blank during silent intervals!)
      if (this.captionEl) {
        if (!this.isPano && this.ccEnabled && !this._endModalOpen && this.cues.length) {
          const cue = this.cues.find((c) => curT >= c.t0 && curT <= c.t1);
          if (cue) {
            if (this._lastCueText !== cue.text) {
              this._lastCueText = cue.text;
              this.captionEl.innerHTML = cue.text;
            }
            this.captionEl.hidden = false;
          } else {
            this.captionEl.hidden = true;
          }
        } else {
          this.captionEl.hidden = true;
        }
      }

      // Time-windowed non-pausing 3D hotspot pin
      if (this.timedPinEl && (this.opts.timedHotspots || []).length && !this.isPano && !this._endModalOpen) {
        const hs = this.opts.timedHotspots.find((h) => curT >= h.t0 && curT <= h.t1) || null;
        this._activeTimedHotspot = hs;
        if (hs) {
          const pt = this.coordsToScreen(hs.yaw, hs.pitch);
          const w = this.canvas.clientWidth || 640;
          const h = this.canvas.clientHeight || 400;
          if (pt.visible && pt.x > 36 && pt.x < w - 36 && pt.y > 48 && pt.y < h - 84) {
            const lbl = typeof hs.label === "object" ? hs.label[this.lang] || hs.label.en : hs.label;
            this.timedPinEl.textContent = "✦ " + lbl;
            this.timedPinEl.style.left = pt.x + "px";
            this.timedPinEl.style.top = pt.y + "px";
            this.timedPinEl.hidden = false;
          } else {
            this.timedPinEl.hidden = true;
          }
        } else {
          this.timedPinEl.hidden = true;
        }
      } else if (this.timedPinEl) {
        this.timedPinEl.hidden = true;
      }

      this._updateCompass();
      this._updateTimeline();

      if (typeof this.opts.onFrame === "function") {
        this.opts.onFrame(this);
      }
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      cancelAnimationFrame(this.raf);
      clearTimeout(this.idleTimer);
      window.removeEventListener("deviceorientation", this._onDeviceOrientation);
      document.removeEventListener("fullscreenchange", this._onFsChange);
      document.removeEventListener("webkitfullscreenchange", this._onFsChange);
      document.documentElement.classList.remove("fslock");
      if (this.hls) {
        try {
          this.hls.destroy();
        } catch (e) {}
        this.hls = null;
      }
      [this.video, this.audio].forEach((m) => {
        try {
          m.pause();
          m.removeAttribute("src");
          m.load();
        } catch (e) {}
      });
      if (this.gl) {
        try {
          this.gl.deleteTexture(this.tex);
          this.gl.deleteBuffer(this.posBuf);
          this.gl.deleteBuffer(this.uvBuf);
          this.gl.deleteBuffer(this.idxBuf);
          this.gl.deleteProgram(this.prog);
        } catch (e) {}
      }
      if (this.root && this.root._dlz360 === this) {
        delete this.root._dlz360;
      }
      this.wrap.remove();
    }
  }

  window.DLZ360Player = DLZ360Player;
})();
