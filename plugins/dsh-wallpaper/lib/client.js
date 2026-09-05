/**
 * dsh-wallpaper — browser half (client plugin bundle, hand-built to the DSH
 * loader format; wallpaper engine modeled on the community dsh-background
 * plugin / dsh-skin architecture).
 *
 * Adds a floating button to the top-right of the DeepSeek Harness web UI.
 * Clicking it slides out a VSCode-style sidebar panel where you can:
 *   - choose an image (native file picker, or paste a URL / data URL) as the
 *     background of the whole UI,
 *   - tune it live with sliders that also accept typed numeric input:
 *       模糊 blur      0–60 px
 *       亮度 brightness 50–150 %
 *       饱和度 saturation 0–200 %
 *       对比度 contrast 50–150 %
 *       透明度 opacity   10–100 %
 *     plus a fit mode (cover / contain), a reset button and a remove button.
 *
 * Persistence: localStorage under the `dswp:` prefix (third-party settings
 * namespaces are not exposed over the Host settings wire).
 *
 * The wallpaper is a fixed backdrop layer behind the app plus token overrides
 * that make the main canvas and sidebar translucent, so the image shows
 * through while inner surfaces (cards, bubbles, inputs) stay opaque.
 */
window.__ModuleLoader__.load({
  id: "dsh-wallpaper",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /* ══════════════════════ config & state ══════════════════════ */

    const NS = "dswp"; // localStorage prefix: dswp:*
    const LIMITS = {
      blur:       { min: 0,   max: 60,  step: 1, unit: "px", def: 0 },
      brightness: { min: 50,  max: 150, step: 1, unit: "%",  def: 100 },
      saturation: { min: 0,   max: 200, step: 1, unit: "%",  def: 100 },
      contrast:   { min: 50,  max: 150, step: 1, unit: "%",  def: 100 },
      opacity:    { min: 10,  max: 100, step: 1, unit: "%",  def: 85 },
    };
    const ORDER = ["blur", "brightness", "saturation", "contrast", "opacity"];

    const S = {
      img: lsGet("img", null),
      blur: num("blur", LIMITS.blur.def),
      brightness: num("brightness", LIMITS.brightness.def),
      saturation: num("saturation", LIMITS.saturation.def),
      contrast: num("contrast", LIMITS.contrast.def),
      opacity: num("opacity", LIMITS.opacity.def),
      fit: lsGet("fit", "cover") === "contain" ? "contain" : "cover",
      open: lsGet("open", "0") === "1",
    };

    function lsGet(key, fallback) {
      try { const v = window.localStorage.getItem(NS + ":" + key); return v === null ? fallback : v; }
      catch { return fallback; }
    }
    function lsSet(key, value) {
      try { window.localStorage.setItem(NS + ":" + key, value); } catch {}
    }
    function lsDel(key) {
      try { window.localStorage.removeItem(NS + ":" + key); } catch {}
    }
    function num(key, fallback) {
      const v = Number(lsGet(key, fallback));
      return Number.isFinite(v) ? v : fallback;
    }
    function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
    function setParam(key, value) {
      const L = LIMITS[key];
      S[key] = clamp(Math.round(Number(value) || 0), L.min, L.max);
      lsSet(key, String(S[key]));
    }

    /* ══════════════════════ wallpaper engine ══════════════════════ */

    let layer = null;         // fixed backdrop div
    let disposeTokens = null; // theme override dispose fn
    let inShade = false;      // re-entrancy guard for theme/change
    let currentCtx = null;

    /** Convert a hex/rgb color to rgba with the given alpha. */
    function toRgba(color, alpha) {
      const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color).trim());
      if (hex !== null) {
        let digits = hex[1];
        if (digits.length === 3) digits = digits.split("").map((c) => c + c).join("");
        const n = parseInt(digits, 16);
        return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
      }
      const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(String(color).trim());
      if (rgb !== null) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
      return String(color).trim();
    }

    /** Resolve one theme token for a scheme (or fall back to a built-in). */
    function resolveToken(scheme, active, token, fallback) {
      if (active && active.colorScheme === scheme && typeof active.tokens?.[token] === "string") {
        return active.tokens[token];
      }
      return fallback;
    }

    const BG_BASE_FALLBACK = (scheme) => (scheme === "light" ? "rgb(255, 255, 255)" : "rgb(21, 21, 23)");
    const BG_LAYER_FALLBACK = (scheme) => (scheme === "light" ? "rgb(248, 248, 250)" : "rgb(28, 28, 31)");

    /** Make the main canvas + trajectory canvas + sidebar translucent so the
     *  backdrop shows through in BOTH the 对话 view (bg-base) and the 轨迹
     *  view (bg-layer-1). Inner surfaces stay opaque for readability. */
    function shadeTokens(ctx) {
      if (inShade || !ctx.theme) return;
      inShade = true;
      try {
        const snapshot = ctx.theme.getTheme();
        const active = snapshot.active;
        const a = S.opacity / 100;
        const sidebarA = Math.min(1, a + 0.12);
        disposeTokens?.();
        disposeTokens = ctx.theme.overrideTokens(NS + ":wallpaper", {
          "--dsw-alias-bg-base": {
            light: toRgba(resolveToken("light", active, "--dsw-alias-bg-base", BG_BASE_FALLBACK("light")), a),
            dark: toRgba(resolveToken("dark", active, "--dsw-alias-bg-base", BG_BASE_FALLBACK("dark")), a),
          },
          "--dsw-alias-bg-layer-1": {
            light: toRgba(resolveToken("light", active, "--dsw-alias-bg-layer-1", BG_LAYER_FALLBACK("light")), a),
            dark: toRgba(resolveToken("dark", active, "--dsw-alias-bg-layer-1", BG_LAYER_FALLBACK("dark")), a),
          },
          "--dsw-specific-sidebar-fill": {
            light: toRgba(resolveToken("light", active, "--dsw-specific-sidebar-fill", BG_BASE_FALLBACK("light")), sidebarA),
            dark: toRgba(resolveToken("dark", active, "--dsw-specific-sidebar-fill", BG_BASE_FALLBACK("dark")), sidebarA),
          },
        });
      } finally {
        inShade = false;
      }
    }

    /** Refresh the backdrop layer's styles from current state. */
    function applyLayer() {
      if (!layer || !S.img) return;
      const filter = [
        S.blur > 0 ? `blur(${S.blur}px)` : "",
        `brightness(${S.brightness}%)`,
        `saturate(${S.saturation}%)`,
        `contrast(${S.contrast}%)`,
      ].filter(Boolean).join(" ");
      // give the blur some bleed room so edges don't go transparent
      const bleed = S.blur > 0 ? Math.min(60, S.blur) : 0;
      layer.style.cssText =
        `position:fixed;pointer-events:none;background-image:url("${S.img}");` +
        `background-size:${S.fit};background-position:center;background-repeat:no-repeat;` +
        `opacity:${S.opacity / 100};filter:${filter || "none"};z-index:-1;` +
        `top:${-bleed}px;right:${-bleed}px;bottom:${-bleed}px;left:${-bleed}px;`;
    }

    /** Apply (or clear) the wallpaper layer and its token shading. */
    function applyWallpaper(ctx) {
      if (!S.img) {
        layer?.remove();
        layer = null;
        disposeTokens?.();
        disposeTokens = null;
        return;
      }
      if (layer === null || !document.body.contains(layer)) {
        layer = document.createElement("div");
        document.body.prepend(layer);
      }
      applyLayer();
      shadeTokens(ctx);
    }

    function teardownWallpaper() {
      layer?.remove();
      layer = null;
      disposeTokens?.();
      disposeTokens = null;
    }

    /* ══════════════════════ image loading ══════════════════════ */

    function compressImage(image, maxSide, quality) {
      const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", quality);
    }
    function readImageAsDataUrl(file, onDone) {
      const reader = new FileReader();
      reader.onerror = () => onDone(null);
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => onDone(null);
        image.onload = () => {
          try {
            let dataUrl = compressImage(image, 1600, 0.72);
            if (dataUrl.length > 900000) dataUrl = compressImage(image, 1200, 0.62);
            if (dataUrl.length > 900000) dataUrl = compressImage(image, 900, 0.52);
            onDone(dataUrl);
          } catch {
            onDone(null);
          }
        };
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    }

    /* ══════════════════════ UI helpers ══════════════════════ */

    const T = {
      title: "背景壁纸",
      close: "关闭",
      image: "图片",
      choose: "选择图片…",
      remove: "移除",
      urlPlaceholder: "或粘贴图片 URL / Data URL",
      applyUrl: "应用",
      pathPlaceholder: "或粘贴图片绝对路径（如 /Users/你/Pictures/a.jpg）",
      loadPath: "加载",
      pathHint: "粘贴完整绝对路径后点「加载」，由本机服务读取图片。",
      pathError: "读取失败",
      pathRestartHint: "此功能需要重启 dsh 服务后生效",
      previewNone: "未设置背景",
      adjust: "调节",
      blur: "模糊",
      brightness: "亮度",
      saturation: "饱和度",
      contrast: "对比度",
      opacity: "透明度",
      fit: "适配",
      fitCover: "铺满",
      fitContain: "适应",
      actions: "操作",
      reset: "重置调节",
      clearBg: "移除背景",
      needImg: "请先选择一张图片",
      hint: "背景固定在整个 UI 底层。选择图片后，可拖动滑杆或直接输入数值调节效果；主内容区与侧边栏会半透明露出图片，消息、输入框等内层表面保持不透明以保证可读性。",
    };

    function el(tag, cls, text) {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    const styleText = `
.dswp-btn{position:fixed;top:64px;right:14px;z-index:9000;width:38px;height:38px;border-radius:12px;padding:0;cursor:pointer;
  border:1px solid rgba(255,255,255,.25);
  background:linear-gradient(135deg,#5686FE 0%,#4176E6 100%);
  display:flex;align-items:center;justify-content:center;
  box-shadow:0 3px 14px rgba(86,134,254,.45);
  transition:filter .15s,transform .15s;}
.dswp-btn:hover{filter:brightness(1.12);transform:scale(1.07);}
.dswp-btn svg{display:block;}
.dswp-panel{position:fixed;top:64px;right:14px;bottom:16px;width:312px;z-index:9001;
  display:flex;flex-direction:column;border-radius:18px;overflow:hidden;
  background:
    linear-gradient(180deg, rgba(86,134,254,.12) 0%, rgba(65,118,230,.05) 34%, rgba(0,0,0,0) 62%),
    var(--dsw-alias-bg-overlay,#f8f8fa);
  border:1px solid rgba(86,134,254,.18);
  box-shadow:0 12px 40px rgba(0,0,0,.28);
  transform:translateX(120%);transition:transform .24s cubic-bezier(.2,.8,.25,1);
  backdrop-filter:blur(18px) saturate(1.5);-webkit-backdrop-filter:blur(18px) saturate(1.5);}
.dswp-panel.open{transform:translateX(0);}
.dswp-head{display:flex;align-items:center;justify-content:space-between;padding:14px 12px 12px 16px;
  background:linear-gradient(135deg,#5686FE 0%,#4176E6 100%);}
.dswp-title{font-size:14px;font-weight:600;color:#fff;letter-spacing:.2px;}
.dswp-close{width:26px;height:26px;border:none;border-radius:8px;background:transparent;
  color:rgba(255,255,255,.92);font-size:15px;line-height:26px;cursor:pointer;padding:0;transition:background .15s;}
.dswp-close:hover{background:rgba(255,255,255,.22);}
.dswp-body{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:18px;}
.dswp-body::-webkit-scrollbar{width:8px;}
.dswp-body::-webkit-scrollbar-thumb{background:rgba(86,134,254,.28);border-radius:4px;}
.dswp-sec-title{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;
  color:var(--dsw-alias-label-secondary,#5a5f6a);margin-bottom:9px;}
.dswp-sec-title::before{content:"";width:9px;height:9px;border-radius:3px;flex:none;
  background:linear-gradient(135deg,#5686FE,#7aa0ff);box-shadow:0 0 6px rgba(86,134,254,.5);}
.dswp-preview{height:86px;border-radius:12px;margin-bottom:10px;
  border:1px solid rgba(86,134,254,.22);
  background-color:rgba(86,134,254,.05);
  background-size:cover;background-position:center;background-repeat:no-repeat;
  box-shadow:inset 0 1px 6px rgba(0,0,0,.12);
  display:flex;align-items:center;justify-content:center;
  color:var(--dsw-alias-label-tertiary,#9aa0aa);font-size:12px;}
.dswp-row{display:flex;align-items:center;gap:8px;margin-bottom:8px;}
.dswp-row:last-child{margin-bottom:0;}
.dswp-filebtn{flex:1;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;
  height:34px;border-radius:10px;cursor:pointer;font-size:13px;font-weight:500;
  border:none;color:#fff;
  background:linear-gradient(135deg,#5686FE 0%,#4176E6 100%);
  box-shadow:0 2px 10px rgba(86,134,254,.4);transition:filter .15s;}
.dswp-filebtn:hover{filter:brightness(1.1);}
.dswp-filehit{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;border:0;padding:0;margin:0;}
.dswp-minibtn{height:30px;padding:0 12px;border-radius:9px;cursor:pointer;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));
  background:transparent;color:var(--dsw-alias-label-secondary,#5a5f6a);transition:all .15s;}
.dswp-minibtn:hover{background:rgba(86,134,254,.1);border-color:rgba(86,134,254,.4);color:#5686FE;}
.dswp-minibtn.dswp-danger{color:#e5484d;border-color:rgba(229,72,77,.3);}
.dswp-minibtn.dswp-danger:hover{background:rgba(229,72,77,.1);border-color:rgba(229,72,77,.5);color:#e5484d;}
.dswp-urlinput,.dswp-cnum{height:30px;padding:0 10px;border-radius:9px;
  border:1px solid rgba(86,134,254,.3);background:rgba(86,134,254,.06);
  color:var(--dsw-alias-label-primary,#1f2430);font-size:12px;transition:all .15s;}
.dswp-urlinput{flex:1;min-width:0;}
.dswp-urlinput::placeholder{color:var(--dsw-alias-label-tertiary,#9aa0aa);}
.dswp-urlinput:focus,.dswp-cnum:focus{outline:none;border-color:#5686FE;box-shadow:0 0 0 3px rgba(86,134,254,.22);}
.dswp-crow{display:flex;align-items:center;gap:8px;margin-bottom:11px;}
.dswp-crow:last-child{margin-bottom:0;}
.dswp-clabel{width:58px;flex:none;font-size:12px;color:var(--dsw-alias-label-secondary,#5a5f6a);}
.dswp-crow input[type=range]{flex:1;min-width:0;-webkit-appearance:none;appearance:none;height:5px;border-radius:3px;outline:none;cursor:pointer;}
.dswp-crow input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:15px;height:15px;border-radius:50%;
  background:#fff;border:2px solid #5686FE;box-shadow:0 1px 5px rgba(0,0,0,.3);cursor:pointer;transition:transform .12s;}
.dswp-crow input[type=range]::-webkit-slider-thumb:hover{transform:scale(1.15);}
.dswp-cnum{width:56px;flex:none;text-align:right;}
.dswp-cunit{width:18px;flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0aa);}
.dswp-select{height:30px;border-radius:9px;padding:0 8px;
  border:1px solid rgba(86,134,254,.3);background:rgba(86,134,254,.06);
  color:var(--dsw-alias-label-primary,#1f2430);font-size:12px;}
.dswp-foot{padding:10px 16px 14px;border-top:1px solid rgba(86,134,254,.14);
  font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0aa);
  background:rgba(86,134,254,.04);}
.dswp-pathstatus{font-size:11px;line-height:15px;min-height:15px;color:var(--dsw-alias-label-tertiary,#9aa0aa);margin-top:-2px;}
.dswp-disabled{opacity:.45;pointer-events:none;filter:grayscale(.3);}
`;

    /* ══════════════════════ controls ══════════════════════ */

    const ctrlRefs = {}; // key -> { range, num }

    /** Paint a range input's track as a filled accent gradient (WebKit). */
    function paintSlider(range, min, max, value) {
      const pct = ((clamp(value, min, max) - min) / (max - min)) * 100;
      range.style.background = `linear-gradient(90deg,#5686FE 0%,#7aa0ff ${pct}%,rgba(128,128,140,.22) ${pct}%)`;
    }

    function sliderRow(key, ctx) {
      const L = LIMITS[key];
      const row = el("div", "dswp-crow");
      const label = el("span", "dswp-clabel", T[key]);
      const range = document.createElement("input");
      range.type = "range";
      range.min = String(L.min); range.max = String(L.max); range.step = String(L.step);
      range.value = String(S[key]);
      paintSlider(range, L.min, L.max, S[key]);
      const numInput = document.createElement("input");
      numInput.type = "number";
      numInput.min = String(L.min); numInput.max = String(L.max); numInput.step = String(L.step);
      numInput.value = String(S[key]);
      numInput.className = "dswp-cnum";
      const unit = el("span", "dswp-cunit", L.unit);

      const syncUI = () => {
        range.value = String(S[key]);
        numInput.value = String(S[key]);
        paintSlider(range, L.min, L.max, S[key]);
      };
      const commit = (value) => {
        setParam(key, value);
        syncUI();
        applyWallpaper(ctx);
      };

      // slider: live apply
      range.addEventListener("input", () => {
        S[key] = clamp(Number(range.value), L.min, L.max);
        numInput.value = String(S[key]);
        lsSet(key, String(S[key]));
        paintSlider(range, L.min, L.max, S[key]);
        applyWallpaper(ctx);
      });
      // number input: live preview of the raw text, clamped & applied on blur/Enter
      numInput.addEventListener("change", () => commit(numInput.value));
      numInput.addEventListener("blur", () => commit(numInput.value));
      numInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); numInput.blur(); }
      });

      ctrlRefs[key] = { range, num: numInput, syncUI };
      row.append(label, range, numInput, unit);
      return row;
    }

    function syncAllControls() {
      ORDER.forEach((key) => ctrlRefs[key]?.syncUI());
    }

    /* ══════════════════════ panel assembly ══════════════════════ */

    function refreshPreview() {
      if (!previewEl) return;
      if (S.img) {
        previewEl.style.backgroundImage = `url("${S.img}")`;
        previewEl.textContent = "";
      } else {
        previewEl.style.backgroundImage = "none";
        previewEl.textContent = T.previewNone;
      }
      controlsWrap?.classList.toggle("dswp-disabled", !S.img);
    }

    function setOpen(open) {
      S.open = open;
      lsSet("open", open ? "1" : "0");
      panel?.classList.toggle("open", open);
      if (btn) btn.style.display = open ? "none" : "flex";
    }

    /**
     * Align the button's TOP with the divider line below the 对话/轨迹 tab
     * row (the line above the chat box). Finds the tab container in the DOM
     * at runtime, so it tracks any window size / layout. Falls back to the
     * static CSS `top` when the tabs are not on screen (e.g. session list).
     */
    function alignButton() {
      if (!btn) return;
      let top = null;
      const labels = ["对话", "轨迹", "Conversation", "Trajectory"];
      const hasPair = (t) => labels.filter((l) => t.includes(l)).length >= 2;
      // 1) a compact container that holds both tab labels
      const containers = Array.from(document.querySelectorAll("div,section,aside,nav,header,button,span,ul,ol")).filter((e) => {
        const t = (e.textContent || "").trim();
        if (!hasPair(t) || t.length > 24) return false;
        const r = e.getBoundingClientRect();
        return r.top >= 0 && r.top < 240 && r.height > 0 && r.height < 90 && r.width > 0;
      });
      if (containers.length > 0) {
        containers.sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height);
        top = containers[0].getBoundingClientRect().bottom;
      } else {
        // 2) fall back to individual tab-label elements
        const ys = [];
        for (const e of document.querySelectorAll("button,span,div,a")) {
          if (e.childNodes.length === 1 && e.childNodes[0].nodeType === 3 && labels.includes((e.textContent || "").trim())) {
            const r = e.getBoundingClientRect();
            if (r.top >= 0 && r.top < 240 && r.width > 0) ys.push(r.bottom);
          }
        }
        if (ys.length > 0) top = Math.max(...ys) + 8;
      }
      if (top !== null && top > 0 && Math.abs(top - btn.offsetTop) > 2) {
        btn.style.top = Math.round(top) + "px";
      }
    }

    function buildUI(ctx) {
      const styleEl = document.createElement("style");
      styleEl.textContent = styleText;
      document.head.appendChild(styleEl);

      // ── floating button (right edge, vertically centered) ──
      btn = el("button", "dswp-btn");
      btn.type = "button";
      btn.title = T.title;
      btn.setAttribute("aria-label", T.title);
      btn.innerHTML =
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none">' +
        '<defs><linearGradient id="dswpGrad" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="#5686FE"/><stop offset="1" stop-color="#4176E6"/>' +
        '</linearGradient></defs>' +
        '<rect x="3" y="3" width="18" height="18" rx="4" fill="url(#dswpGrad)"/>' +
        '<circle cx="9" cy="9.5" r="2.3" fill="#fff"/>' +
        '<path d="M5.5 16.5l4-4 2.6 2.6 3.4-3.4 3 3v.8a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2z" fill="#fff"/>' +
        "</svg>";
      btn.addEventListener("click", () => setOpen(true));

      // ── sidebar panel ──
      panel = el("aside", "dswp-panel");
      panel.setAttribute("role", "complementary");

      const head = el("div", "dswp-head");
      head.append(el("span", "dswp-title", T.title));
      const closeBtn = el("button", "dswp-close", "✕");
      closeBtn.type = "button";
      closeBtn.title = T.close;
      closeBtn.addEventListener("click", () => setOpen(false));
      head.append(closeBtn);

      const body = el("div", "dswp-body");

      // image section
      const imgSec = el("div");
      imgSec.append(el("div", "dswp-sec-title", T.image));
      previewEl = el("div", "dswp-preview", T.previewNone);

      const row1 = el("div", "dswp-row");
      // Label-wrapped file input: the input covers the whole button (opacity 0),
      // so the user's real click lands directly ON the file input — the most
      // reliable way to open the native picker in WebKit/WKWebView too.
      const fileLabel = el("label", "dswp-filebtn", T.choose);
      fileLabel.title = T.choose;
      fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = "image/*";
      fileInput.className = "dswp-filehit";
      fileLabel.append(fileInput);
      fileInput.addEventListener("change", (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        readImageAsDataUrl(file, (dataUrl) => {
          if (dataUrl !== null) {
            S.img = dataUrl;
            lsSet("img", dataUrl);
            applyWallpaper(ctx);
            refreshPreview();
          }
          fileInput.value = "";
        });
      });
      const rmBtn = el("button", "dswp-minibtn dswp-danger", T.remove);
      rmBtn.type = "button";
      rmBtn.addEventListener("click", () => {
        S.img = null;
        lsDel("img");
        applyWallpaper(ctx);
        refreshPreview();
      });
      row1.append(fileLabel, rmBtn);

      const row2 = el("div", "dswp-row");
      const urlInput = document.createElement("input");
      urlInput.className = "dswp-urlinput";
      urlInput.placeholder = T.urlPlaceholder;
      const applyUrlBtn = el("button", "dswp-minibtn", T.applyUrl);
      applyUrlBtn.type = "button";
      applyUrlBtn.addEventListener("click", () => {
        const value = urlInput.value.trim();
        if (!value) return;
        const probe = new Image();
        probe.onload = () => {
          S.img = value;
          lsSet("img", value);
          applyWallpaper(ctx);
          refreshPreview();
        };
        probe.onerror = () => {
          urlInput.style.borderColor = "#e5484d";
          window.setTimeout(() => { urlInput.style.borderColor = ""; }, 900);
        };
        probe.src = value;
      });
      row2.append(urlInput, applyUrlBtn);

      // absolute-path loader (host route /dsh-wallpaper/read)
      const row3 = el("div", "dswp-row");
      const pathInput = document.createElement("input");
      pathInput.className = "dswp-urlinput";
      pathInput.placeholder = T.pathPlaceholder;
      const pathStatus = el("div", "dswp-pathstatus", "");
      const loadPathBtn = el("button", "dswp-minibtn", T.loadPath);
      loadPathBtn.type = "button";
      const flashError = (message) => {
        pathInput.style.borderColor = "#e5484d";
        pathStatus.textContent = message;
        pathStatus.style.color = "#e5484d";
        window.setTimeout(() => {
          pathInput.style.borderColor = "";
          if (pathStatus.textContent === message) pathStatus.textContent = "";
        }, 2600);
      };
      loadPathBtn.addEventListener("click", () => {
        const value = pathInput.value.trim();
        if (!value) return;
        pathInput.disabled = true;
        loadPathBtn.disabled = true;
        loadPathBtn.textContent = "…";
        pathStatus.textContent = "";
        fetch("/dsh-wallpaper/read?path=" + encodeURIComponent(value), { cache: "no-store" })
          .then((res) =>
            res.json().catch(() => ({ error: "bad-response", status: res.status })).then((json) => ({ json, status: res.status })),
          )
          .then(({ json, status }) => {
            if (json && typeof json.dataUrl === "string" && json.dataUrl.length > 0) {
              S.img = json.dataUrl;
              lsSet("img", json.dataUrl);
              applyWallpaper(ctx);
              refreshPreview();
              pathInput.style.borderColor = "";
              pathStatus.textContent = "";
            } else if (status === 404 || (json && json.error === "read-failed")) {
              flashError(T.pathError + "：" + (json.message || T.pathRestartHint));
            } else if (status === 400) {
              flashError(T.pathError + "：不支持的路径/格式");
            } else {
              flashError(T.pathError + "（" + (json && json.error || status) + "）");
            }
          })
          .catch(() => flashError(T.pathError + "：网络错误"))
          .finally(() => {
            pathInput.disabled = false;
            loadPathBtn.disabled = false;
            loadPathBtn.textContent = T.loadPath;
          });
      });
      row3.append(pathInput, loadPathBtn);
      imgSec.append(previewEl, row1, row2, row3, pathStatus);
      body.append(imgSec);

      // adjustments section
      controlsWrap = el("div");
      const adjSec = el("div");
      adjSec.append(el("div", "dswp-sec-title", T.adjust));
      ORDER.forEach((key) => adjSec.append(sliderRow(key, ctx)));
      const fitRow = el("div", "dswp-crow");
      fitRow.append(el("span", "dswp-clabel", T.fit));
      const fitSel = document.createElement("select");
      fitSel.className = "dswp-select";
      fitSel.append(new Option(T.fitCover, "cover"), new Option(T.fitContain, "contain"));
      fitSel.value = S.fit;
      fitSel.addEventListener("change", () => {
        S.fit = fitSel.value;
        lsSet("fit", S.fit);
        applyLayer();
      });
      fitRow.append(fitSel);
      adjSec.append(fitRow);
      controlsWrap.append(adjSec);

      // actions section
      const actSec = el("div");
      actSec.append(el("div", "dswp-sec-title", T.actions));
      const actRow = el("div", "dswp-row");
      const resetBtn = el("button", "dswp-minibtn", T.reset);
      resetBtn.type = "button";
      resetBtn.addEventListener("click", () => {
        ORDER.forEach((key) => setParam(key, LIMITS[key].def));
        syncAllControls();
        applyWallpaper(ctx);
        refreshPreview();
      });
      const clearBtn = el("button", "dswp-minibtn dswp-danger", T.clearBg);
      clearBtn.type = "button";
      clearBtn.addEventListener("click", () => {
        S.img = null;
        lsDel("img");
        applyWallpaper(ctx);
        refreshPreview();
      });
      actRow.append(resetBtn, clearBtn);
      actSec.append(actRow);
      controlsWrap.append(actSec);

      body.append(controlsWrap);
      const foot = el("div", "dswp-foot", T.hint);

      panel.append(head, body, foot);
      document.body.append(btn, panel);

      setOpen(S.open);
      refreshPreview();
    }

    /* ══════════════════════ plugin body ══════════════════════ */

    const inject = ["slots", "locale", "theme"];

    function apply(ctx) {
      currentCtx = ctx;

      buildUI(ctx);
      applyWallpaper(ctx);
      refreshPreview();

      // align the button with the 对话/轨迹 divider; re-run as the app
      // finishes rendering and on window resize.
      const alignTimer = () => {
        alignButton();
        window.setTimeout(alignButton, 400);
        window.setTimeout(alignButton, 1200);
        window.setTimeout(alignButton, 3000);
      };
      alignTimer();
      window.addEventListener("resize", alignButton);

      // keep the shading in sync after a scheme/skin switch
      ctx.on("theme/change", () => {
        if (!S.img) return;
        applyLayer();
        shadeTokens(ctx);
      });

      ctx.effect(
        () => () => {
          teardownWallpaper();
          window.removeEventListener("resize", alignButton);
          btn?.remove();
          panel?.remove();
        },
        "dsh-wallpaper: cleanup",
      );
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
