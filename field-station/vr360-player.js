/**
 * DLZ360Player — Embedded On-Site WebGL 360° Equirectangular VR Video Player for Digital Live Zoo
 *
 * Solves the YouTube 360° off-site redirect problem:
 * - Renders equirectangular 360°×180° video (HLS .m3u8 or progressive .mp4) directly inside a WebGL UV sphere
 *   on digitallivezoo.com — works natively on iPhone Safari, iPad Safari, Android Chrome, macOS/Windows desktop,
 *   and VR headsets without ever leaving the website.
 * - Exposes exact spherical coordinates (yaw ∈ [-180, 180], pitch ∈ [-85, 85], hfov ∈ [38, 110]),
 *   screenToCoords(clientX, clientY) raycasting, and coordsToScreen(yaw, pitch) 3D pin projection
 *   so Field Station quests can run live interactive animal/clue spotting directly inside moving 360° video.
 */
(function () {
  "use strict";

  const DEG2RAD = Math.PI / 180;
  const RAD2DEG = 180 / Math.PI;
  const HLS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.17/hls.min.js";

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
    let w = ((y + 180) % 360 + 360) % 360 - 180;
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
      const v = lat / latSegs; // 0 = top (+90° zenith), 1 = bottom (-90° nadir)
      const phi = (0.5 - v) * Math.PI;
      const cosPhi = Math.cos(phi);
      const sinPhi = Math.sin(phi);

      for (let lon = 0; lon <= lonSegs; lon++) {
        const u = lon / lonSegs; // 0 = -180°, 0.5 = 0° center, 1 = +180°
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
          hlsSrc: "",
          mp4Src: "",
          poster: "",
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
          showControls: true,
          onFrame: null,
          onTapSphere: null,
          onTimeChapter: null,
        },
        opts || {}
      );

      this.yaw = this.opts.yaw;
      this.pitch = this.opts.pitch;
      this.hfov = this.opts.hfov;
      this.velYaw = 0;
      this.velPitch = 0;

      this.destroyed = false;
      this.hasFrame = false;
      this.isDragging = false;
      this.gyroEnabled = false;
      this.gyroBase = null;
      this.hls = null;
      this.pins = new Map();
      this.keys = new Set();
      this.idleTimer = 0;

      this._buildDOM();
      this._initWebGL();
      this._bindEvents();
      this.setSource({
        hlsSrc: this.opts.hlsSrc,
        mp4Src: this.opts.mp4Src,
        poster: this.opts.poster,
        startTime: this.opts.startTime,
        editionLabel: this.opts.editionLabel,
      });
      this._tick = this._tick.bind(this);
      this.raf = requestAnimationFrame(this._tick);
    }

    _buildDOM() {
      this.wrap = document.createElement("div");
      this.wrap.className = "dlz360-wrap";
      this.wrap.tabIndex = 0;
      this.wrap.setAttribute("role", "application");
      this.wrap.setAttribute("aria-label", "Interactive 360 degree wildlife camp player. Drag or use arrow keys to look around.");

      this.canvas = document.createElement("canvas");
      this.canvas.className = "dlz360-canvas";
      this.wrap.appendChild(this.canvas);

      // Poster layer before first video frame decodes
      this.posterEl = document.createElement("img");
      this.posterEl.className = "dlz360-poster";
      this.posterEl.alt = "";
      if (!this.opts.poster) this.posterEl.hidden = true;
      else this.posterEl.src = this.opts.poster;
      this.wrap.appendChild(this.posterEl);

      // 3D Pins container (above canvas, below HUD controls)
      this.pinLayer = document.createElement("div");
      this.pinLayer.className = "dlz360-pins";
      this.wrap.appendChild(this.pinLayer);

      // Overlay slot for Field Station binocular lens / focus ring / hint arrow
      this.overlayLayer = document.createElement("div");
      this.overlayLayer.className = "dlz360-overlay";
      this.wrap.appendChild(this.overlayLayer);

      // Top HUD: 360° Compass + Live Solar/Weather Badge
      this.topHud = document.createElement("div");
      this.topHud.className = "dlz360-top";
      this.topHud.innerHTML = `
        <div class="dlz360-compass" aria-hidden="true">
          <div class="dlz360-compass-track"></div>
          <span class="dlz360-compass-readout">000° N</span>
        </div>
        <div class="dlz360-badges">
          <span class="dlz360-badge dlz360-live-pill">360° VR CAMP</span>
          <span class="dlz360-badge dlz360-ed-pill" ${this.opts.editionLabel ? "" : "hidden"}>${this.opts.editionLabel || ""}</span>
          <span class="dlz360-badge dlz360-wx-pill" ${this.opts.telemetryText ? "" : "hidden"}>${this.opts.telemetryText || ""}</span>
        </div>
      `;
      this.compassTrack = this.topHud.querySelector(".dlz360-compass-track");
      this.compassReadout = this.topHud.querySelector(".dlz360-compass-readout");
      this.edPill = this.topHud.querySelector(".dlz360-ed-pill");
      this.wxPill = this.topHud.querySelector(".dlz360-wx-pill");
      this.wrap.appendChild(this.topHud);

      // Big Center Play Prompt (when paused at start)
      this.bigPlay = document.createElement("button");
      this.bigPlay.type = "button";
      this.bigPlay.className = "dlz360-bigplay";
      this.bigPlay.innerHTML = `
        <span class="dlz360-bigplay-ic">▶</span>
        <b>Enter 360° Safari Camp</b>
        <small>Stays right here on Digital Live Zoo · Drag, pinch or tilt to look all 360° around</small>
      `;
      this.wrap.appendChild(this.bigPlay);

      // Bottom Transport + Chapters + VR Look Controls
      this.botHud = document.createElement("div");
      this.botHud.className = "dlz360-bot";
      this.botHud.innerHTML = `
        <div class="dlz360-chapters" hidden></div>
        <div class="dlz360-scrub-row">
          <input type="range" class="dlz360-scrub" min="0" max="1000" value="0" step="1" aria-label="Seek timeline">
        </div>
        <div class="dlz360-ctrl-row">
          <button type="button" class="dlz360-btn dlz360-play" aria-label="Play or pause">▶ Play</button>
          <button type="button" class="dlz360-btn dlz360-mute" aria-label="Mute or unmute">${this.opts.muted ? "🔇 Muted" : "🔊 Sound"}</button>
          <span class="dlz360-time">0:00 / 0:00</span>
          <div class="dlz360-spacer"></div>
          <button type="button" class="dlz360-btn dlz360-gyro" hidden aria-pressed="false">📱 Tilt 360°</button>
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
      this.timeEl = this.botHud.querySelector(".dlz360-time");
      this.gyroBtn = this.botHud.querySelector(".dlz360-gyro");
      this.fsBtn = this.botHud.querySelector(".dlz360-fs");
      if ("DeviceOrientationEvent" in window && matchMedia("(pointer: coarse)").matches) {
        this.gyroBtn.hidden = false;
      }
      this._renderChapters();
      this.wrap.appendChild(this.botHud);

      // Hidden HTML5 video source
      this.video = document.createElement("video");
      this.video.playsInline = true;
      this.video.setAttribute("playsinline", "");
      this.video.setAttribute("webkit-playsinline", "");
      this.video.crossOrigin = "anonymous";
      this.video.preload = "auto";
      this.video.loop = !!this.opts.loop;
      this.video.muted = !!this.opts.muted;

      this.root.appendChild(this.wrap);
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
        this.canvas.getContext("webgl", { antialias: true, alpha: false, powerPreference: "high-performance" }) ||
        this.canvas.getContext("experimental-webgl");
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
      // 1x1 dark placeholder pixel
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([14, 24, 18, 255]));

      this.uRight = gl.getUniformLocation(prog, "u_right");
      this.uUp = gl.getUniformLocation(prog, "u_up");
      this.uFwd = gl.getUniformLocation(prog, "u_fwd");
      this.uTanX = gl.getUniformLocation(prog, "u_tanX");
      this.uTanY = gl.getUniformLocation(prog, "u_tanY");
      this.uReady = gl.getUniformLocation(prog, "u_ready");
      gl.uniform1f(this.uReady, 0.0);

      // Load poster into WebGL sphere immediately so user can look around in 360° even BEFORE pressing play!
      if (this.opts.poster) {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          if (this.destroyed || this.hasFrame) return;
          try {
            gl.bindTexture(gl.TEXTURE_2D, this.tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
            gl.uniform1f(this.uReady, 1.0);
            this.posterEl.hidden = true;
          } catch (e) {}
        };
        img.src = this.opts.poster;
      }
    }

    setSource({ hlsSrc, mp4Src, poster, preserveTime, startTime, editionLabel }) {
      const targetTime = preserveTime ? (this.video.currentTime || 0) : (typeof startTime === "number" ? startTime : 0);
      const wasPlaying = preserveTime ? !this.video.paused : !!this.opts.autoplay;

      if (editionLabel !== undefined) {
        this.opts.editionLabel = editionLabel;
        if (editionLabel) {
          this.edPill.textContent = editionLabel;
          this.edPill.hidden = false;
        } else {
          this.edPill.hidden = true;
        }
      }

      if (this.hls) {
        try {
          this.hls.destroy();
        } catch (e) {}
        this.hls = null;
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
        hlsSrc &&
        (this.video.canPlayType("application/vnd.apple.mpegurl") ||
          this.video.canPlayType("application/x-mpegURL"));

      if (hlsSrc && canNativeHls) {
        this.video.src = hlsSrc;
        finishAttach();
      } else if (hlsSrc) {
        ensureHlsJs().then((Hls) => {
          if (this.destroyed) return;
          if (Hls && Hls.isSupported()) {
            const hls = new Hls({
              maxBufferLength: 30,
              enableWorker: true,
              startPosition: targetTime > 0 ? targetTime : -1,
            });
            this.hls = hls;
            hls.loadSource(hlsSrc);
            hls.attachMedia(this.video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
              if (targetTime > 0) this.video.currentTime = targetTime;
              if (wasPlaying) this.play();
            });
            hls.on(Hls.Events.ERROR, (_ev, data) => {
              if (data && data.fatal && mp4Src && this.video.src !== mp4Src) {
                hls.destroy();
                this.hls = null;
                this.video.src = mp4Src;
                finishAttach();
              }
            });
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
      const p = this.video.play();
      if (p && p.catch) {
        p.catch(() => {
          // If unmuted autoplay blocked, retry muted
          this.video.muted = true;
          this._syncAudioBtn();
          this.video.play().catch(() => {});
        });
      }
    }

    pause() {
      this.video.pause();
    }

    seekTo(sec) {
      if (isFinite(sec)) {
        this.video.currentTime = Math.max(0, sec);
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
      return this.video.currentTime || 0;
    }

    getDuration() {
      return this.video.duration || 0;
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
      if (this.pins.has(id)) return;
      const el = document.createElement("button");
      el.type = "button";
      el.className = "found-pin dlz360-pin";
      el.title = label || id;
      el.setAttribute("aria-label", "Found: " + (label || id));
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
      this.muteBtn.textContent = this.video.muted ? "🔇 Unmute" : "🔊 Sound";
    }

    _wakeHud() {
      this.wrap.classList.remove("dlz360-idle");
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if (!this.video.paused && this.wrap.classList.contains("dlz360-full")) {
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
      if (this.gyroEnabled) {
        this.gyroEnabled = false;
        this.gyroBase = null;
        this.gyroBtn.setAttribute("aria-pressed", "false");
        this.gyroBtn.textContent = "📱 Tilt 360°";
        window.removeEventListener("deviceorientation", this._onDeviceOrientation);
        return;
      }
      const enable = () => {
        this.gyroEnabled = true;
        this.gyroBase = null;
        this.gyroBtn.setAttribute("aria-pressed", "true");
        this.gyroBtn.textContent = "📱 Tilting";
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
        if (e.target.closest(".dlz360-bot") || e.target.closest(".dlz360-bigplay") || e.target.closest(".dlz360-pin")) {
          return;
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
          this.hfov = clamp(this.hfov + (e.deltaY > 0 ? 4.5 : -4.5), this.opts.minHfov, this.opts.maxHfov);
        },
        { passive: false }
      );

      this.bigPlay.addEventListener("click", () => {
        this.bigPlay.hidden = true;
        this.play();
      });

      this.playBtn.addEventListener("click", () => {
        if (this.video.paused) this.play();
        else this.pause();
      });

      this.muteBtn.addEventListener("click", () => {
        this.video.muted = !this.video.muted;
        this._syncAudioBtn();
      });

      this.botHud.querySelector(".dlz360-zin").addEventListener("click", () => {
        this.hfov = clamp(this.hfov - 10, this.opts.minHfov, this.opts.maxHfov);
      });
      this.botHud.querySelector(".dlz360-zout").addEventListener("click", () => {
        this.hfov = clamp(this.hfov + 10, this.opts.minHfov, this.opts.maxHfov);
      });
      this.botHud.querySelector(".dlz360-recenter").addEventListener("click", () => {
        this.lookAt(this.opts.yaw || 0, this.opts.pitch || 2, 90);
      });
      this.fsBtn.addEventListener("click", () => this._toggleFullscreen());
      this.gyroBtn.addEventListener("click", () => this._toggleGyro());

      this.scrubEl.addEventListener("input", () => {
        const dur = this.video.duration;
        if (isFinite(dur) && dur > 0) {
          this.video.currentTime = (Number(this.scrubEl.value) / 1000) * dur;
        }
      });

      this.chaptersEl.addEventListener("click", (e) => {
        const b = e.target.closest("[data-t]");
        if (!b) return;
        const t = parseFloat(b.dataset.t);
        if (isFinite(t)) {
          this.seekTo(t);
          if (this.video.paused) this.play();
        }
      });

      this.video.addEventListener("play", () => {
        this.bigPlay.hidden = true;
        this.playBtn.textContent = "❚❚ Pause";
        this._wakeHud();
      });
      this.video.addEventListener("pause", () => {
        this.playBtn.textContent = "▶ Play";
        this.wrap.classList.remove("dlz360-idle");
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
          this.keys.add(e.code);
        } else if (e.code === "Space") {
          e.preventDefault();
          if (this.video.paused) this.play();
          else this.pause();
        } else if (e.code === "KeyF") {
          e.preventDefault();
          this._toggleFullscreen();
        } else if (e.code === "KeyM") {
          e.preventDefault();
          this.video.muted = !this.video.muted;
          this._syncAudioBtn();
        }
      });
      this.wrap.addEventListener("keyup", (e) => this.keys.delete(e.code));
      this.wrap.addEventListener("blur", () => this.keys.clear());
    }

    _updateCompass() {
      const brg = ((Math.round(this.yaw) % 360) + 360) % 360;
      const dirs = ["N", "NE", "E 🌅", "SE", "S", "SW", "W 🌇", "NW"];
      const dir = dirs[Math.round(brg / 45) % 8];
      this.compassReadout.textContent = String(brg).padStart(3, "0") + "° " + dir;
    }

    _updateTimeline() {
      const cur = this.video.currentTime || 0;
      const dur = this.video.duration || 0;
      if (isFinite(dur) && dur > 0) {
        if (document.activeElement !== this.scrubEl) {
          this.scrubEl.value = String(Math.round((cur / dur) * 1000));
        }
        this.timeEl.textContent = fmtTime(cur) + " / " + fmtTime(dur);
      }
      const ch = this.opts.chapters || [];
      if (ch.length) {
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

      // Keyboard smooth pan
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

      if (this.video.readyState >= 2 && this.video.videoWidth > 0) {
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

      // Project 3D spherical pins onto DOM overlay
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
      try {
        this.video.pause();
        this.video.removeAttribute("src");
        this.video.load();
      } catch (e) {}
      if (this.gl) {
        try {
          this.gl.deleteTexture(this.tex);
          this.gl.deleteBuffer(this.posBuf);
          this.gl.deleteBuffer(this.uvBuf);
          this.gl.deleteBuffer(this.idxBuf);
          this.gl.deleteProgram(this.prog);
        } catch (e) {}
      }
      this.wrap.remove();
    }
  }

  window.DLZ360Player = DLZ360Player;
})();
