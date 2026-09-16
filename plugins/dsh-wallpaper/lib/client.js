/**
 * dsh-wallpaper — browser half (client plugin bundle, hand-built to the DSH
 * loader format; wallpaper engine modeled on the community dsh-background
 * plugin / dsh-skin architecture).
 *
 * Adds an icon to DSH's own sidebar: left of the search control while the
 * sidebar is open, below it once the sidebar has folded to its rail. Clicking
 * it slides out a VSCode-style panel where you can:
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

    const React = require("react");
    let btn, host, panel, previewEl, controlsWrap, fileInput, styleEl;
    let sideObserver, sideSlot = null; // sidebar mount bookkeeping
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
      pathPlaceholder: "或粘贴图片绝对路径",
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
      hint: "调整会实时预览并自动保存。按 Esc 收起面板。",
    };

    function el(tag, cls, text) {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    const styleText = `
.dsh-plugin-rail{position:fixed;top:64px;right:14px;z-index:101;display:flex;flex-direction:column;align-items:center;gap:6px;width:36px}
.dswp-side{display:flex;align-items:center;flex:none;margin-left:auto}
.dswp-side-rail{width:36px;justify-content:center;margin-left:0;margin-bottom:12px}
.dswp-btn{position:relative;display:flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;cursor:pointer;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary,#757575);transition:background .15s,color .15s}
.dswp-side-rail .dswp-btn{width:36px;height:36px;color:var(--dsw-alias-label-primary,#222)}
.dswp-btn:hover,.dswp-btn[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,#222)}
.dswp-btn svg{display:block;flex:none}.dswp-btn:focus-visible,.dswp-panel button:focus-visible,.dswp-filebtn:focus-within{outline:2px solid #5686fe;outline-offset:2px}
.dswp-panel{position:fixed;top:64px;left:16px;bottom:16px;width:312px;max-width:calc(100vw - 32px);z-index:100;display:flex;flex-direction:column;overflow:hidden;border-radius:6px;background:var(--dsw-specific-input-major,var(--dsw-alias-bg-base,#f8f8fa));color:var(--dsw-alias-label-primary,#222);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));box-shadow:0 8px 28px rgba(0,0,0,.14);visibility:hidden;opacity:0;transform:translateX(-8px);transition:opacity .15s,transform .15s,visibility .15s}
.dswp-panel.open{visibility:visible;opacity:1;transform:translateX(0)}
.dswp-head{display:flex;align-items:center;justify-content:space-between;min-height:48px;padding:0 14px 0 18px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16))}
.dswp-title{font-size:12px;font-weight:600;letter-spacing:.4px}.dswp-close{width:26px;height:26px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary,#777);font-size:16px;cursor:pointer;padding:0}.dswp-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.dswp-body{flex:1;overflow-y:auto;padding:20px 18px;display:flex;flex-direction:column;gap:24px;scrollbar-width:thin}
.dswp-sec-title{font-size:11px;font-weight:600;letter-spacing:.3px;color:var(--dsw-alias-label-secondary,#777);margin-bottom:12px}
.dswp-preview{height:120px;border-radius:6px;margin-bottom:12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));background-color:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.06));background-size:cover;background-position:center;background-repeat:no-repeat;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#888);font-size:12px}
.dswp-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}.dswp-row:last-child{margin-bottom:0}
.dswp-filebtn{flex:1;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;height:32px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:500;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));color:var(--dsw-alias-label-primary,#222);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}.dswp-filebtn:hover{border-color:#5686fe}
.dswp-filehit{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;border:0;padding:0;margin:0}
.dswp-minibtn{height:30px;padding:0 10px;border-radius:4px;cursor:pointer;font-size:12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));background:transparent;color:var(--dsw-alias-label-secondary,#777)}.dswp-minibtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1))}.dswp-minibtn.dswp-danger{color:#d85b60}
.dswp-urlinput,.dswp-cnum,.dswp-select{box-sizing:border-box;height:30px;padding:0 8px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));background:var(--dsw-specific-input-major,transparent);color:var(--dsw-alias-label-primary,#222);font-size:12px}.dswp-urlinput{flex:1;min-width:0}.dswp-urlinput::placeholder{color:var(--dsw-alias-label-tertiary,#888)}.dswp-urlinput:focus,.dswp-cnum:focus,.dswp-select:focus{outline:1px solid #5686fe;border-color:#5686fe}
.dswp-crow{display:flex;align-items:center;gap:8px;margin-bottom:14px}.dswp-crow:last-child{margin-bottom:0}.dswp-clabel{width:48px;flex:none;font-size:12px;color:var(--dsw-alias-label-secondary,#777)}
.dswp-crow input[type=range]{flex:1;min-width:0;appearance:none;height:3px;border-radius:2px;cursor:pointer}.dswp-crow input[type=range]::-webkit-slider-thumb{appearance:none;width:11px;height:11px;border-radius:50%;background:#5686fe;border:0;cursor:pointer}.dswp-crow input[type=range]:focus-visible{outline:2px solid #5686fe;outline-offset:4px}
.dswp-cnum{width:52px;flex:none;text-align:right}.dswp-cunit{width:16px;flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#888)}
.dswp-foot{padding:12px 18px;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16));font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#888)}.dswp-pathstatus{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#888)}.dswp-pathstatus:empty{display:none}.dswp-disabled{opacity:.4;pointer-events:none}
@media(prefers-reduced-motion:reduce){.dswp-btn,.dswp-panel{transition:none}}
`;

    /* ══════════════════ sidebar mount ══════════════════ */

    /**
     * DSH renders the sidebar through CSS modules, so its class names carry a
     * per-build hash prefix (`bhn1Oq_searchSlot`). Matching on the trailing,
     * stable half survives a DSH rebuild without hard-coding the hash.
     *
     * Geometry copied from the sidebar's own controls so the entry reads as one
     * of them: a 28px round icon button in the wide header, 36px in the 56px
     * rail, with the icon sized 16/18 like `iconButton` does.
     */
    const SIDE_WIDE_ICON = 16;
    const SIDE_RAIL_ICON = 18;
    const SEARCH_SLOT = '[class*="_searchSlot"]';

    function tokenEndsWith(node, suffix) {
      for (const name of node.classList) if (name.endsWith(suffix)) return true;
      return false;
    }

    /**
     * The sidebar browsing region's section header — the row holding the
     * 工作区 label, the search control and the view/add actions. Identified by
     * the `_sectionHeader` token *and* by actually owning a search control, so
     * an unrelated same-named row elsewhere cannot win.
     */
    function findSectionHeader() {
      for (const header of document.querySelectorAll('[class*="_sectionHeader"]')) {
        const parent = header.parentElement;
        if (parent === null) continue;
        if (header.querySelector(SEARCH_SLOT) !== null) return header;
        for (const child of parent.children) if (tokenEndsWith(child, "_search")) return header;
      }
      return null;
    }

    /**
     * Take over the free-space distribution of the header row. `searchSlot`
     * normally claims it with `margin-left:auto`, which is what parks the search
     * control at the far right; dropping that margin and giving it to our own
     * host instead keeps the button glued to the search control's left edge
     * (4px, the row's own gap) no matter how wide the sidebar is.
     */
    function applySideMode(mode, slot) {
      if (sideSlot !== null && sideSlot !== slot) sideSlot.style.marginLeft = "";
      sideSlot = slot;
      if (slot !== null) slot.style.marginLeft = "0px";
      const rail = mode === "rail";
      if (host.classList.contains("dswp-side-rail") !== rail) host.classList.toggle("dswp-side-rail", rail);
      const svg = btn.querySelector("svg");
      if (svg !== null) {
        const size = String(rail ? SIDE_RAIL_ICON : SIDE_WIDE_ICON);
        if (svg.getAttribute("width") !== size) {
          svg.setAttribute("width", size);
          svg.setAttribute("height", size);
        }
      }
    }

    function unmountSidebar() {
      if (sideSlot !== null) {
        sideSlot.style.marginLeft = "";
        sideSlot = null;
      }
      host?.remove();
    }

    /**
     * Pin the button inside the sidebar: left of the search control while the
     * sidebar is open (the search slot exists), below it once the sidebar has
     * folded to its rail (the slot is unmounted and a bare search control takes
     * its place as a direct child of the browsing region).
     */
    function syncSidebar() {
      if (!host) return;
      const header = findSectionHeader();
      const root = header === null ? null : header.parentElement;
      if (root === null) { unmountSidebar(); return; }
      const slot = header.querySelector(SEARCH_SLOT);
      if (slot !== null) {
        // Ignore a requestAnimationFrame that already ran: re-inserting an
        // already-placed node would feed the observer that called us.
        if (host.parentElement !== header || host.nextElementSibling !== slot) header.insertBefore(host, slot);
        applySideMode("wide", slot);
        return;
      }
      for (const child of root.children) {
        if (!tokenEndsWith(child, "_search")) continue;
        if (host.parentElement !== root || host.previousElementSibling !== child) child.after(host);
        applySideMode("rail", null);
        return;
      }
      unmountSidebar();
    }

    /**
     * React rebuilds these subtrees at its own discretion (the rail search only
     * mounts once the collapse animation settles, the slot only exists while
     * wide), and it never learns about our node. Re-pinning on DOM changes and
     * coalescing to one pass per frame is what keeps the button in place.
     */
    function startSideObserver() {
      sideObserver?.disconnect();
      let queued = false;
      sideObserver = new MutationObserver(() => {
        if (queued) return;
        queued = true;
        window.requestAnimationFrame(() => {
          queued = false;
          syncSidebar();
          if (S.open) positionPanel();
        });
      });
      sideObserver.observe(document.body, { childList: true, subtree: true });
    }

    /** Dock the settings panel just right of the sidebar column, where the button now lives. */
    function positionPanel() {
      if (!panel) return;
      const logoRow = document.querySelector('[class*="_logoRow"]');
      const rect = logoRow === null ? undefined : logoRow.parentElement?.getBoundingClientRect();
      panel.style.left = rect === undefined || rect.width === 0 ? "16px" : `${Math.round(rect.right + 8)}px`;
    }

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
      range.setAttribute("aria-label", T[key]);
      range.min = String(L.min); range.max = String(L.max); range.step = String(L.step);
      range.value = String(S[key]);
      paintSlider(range, L.min, L.max, S[key]);
      const numInput = document.createElement("input");
      numInput.type = "number";
      numInput.setAttribute("aria-label", T[key] + "数值");
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
      if (panel) { panel.inert = !open; panel.setAttribute("aria-hidden", String(!open)); }
      btn?.setAttribute("aria-expanded", String(open));
      if (open) {
        positionPanel();
        panel?.querySelector(".dswp-close")?.focus();
      }
    }
    function onEscape(event) {
      if (event.key === "Escape" && S.open) {
        event.preventDefault();
        setOpen(false);
        btn?.focus();
      }
    }
    /** A viewport change resizes the sidebar, which moves the panel's dock. */
    function onResize() {
      if (S.open) positionPanel();
    }

    function buildUI(ctx) {
      styleEl = document.createElement("style");
      styleEl.textContent = styleText;
      document.head.appendChild(styleEl);

      btn = el("button", "dswp-btn");
      btn.type = "button";
      btn.title = "背景个性化";
      btn.setAttribute("aria-label", "背景个性化");
      btn.setAttribute("aria-controls", "dswp-panel");
      btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/></svg>';
      btn.addEventListener("click", () => setOpen(!S.open));
      function PluginRail({ renderSlot }) {
        return React.createElement("nav", { className: "dsh-plugin-rail", "aria-label": "桌面插件" }, renderSlot("desktop.plugin.action", {}));
      }
      // The right-hand rail stays declared (other desktop plugins register their
      // own icons here by id/order) but this plugin no longer occupies it: its
      // entry lives in the sidebar, so it belongs with the sidebar's controls.
      ctx.slots.inject("shell.overlay", () => ctx.slots.register({
        name: "shell.overlay", id: "desktop-plugin-rail", order: 90,
        children: { "desktop.plugin.action": { kind: "list", scope: "root" } },
      }, PluginRail));
      host = el("div", "dswp-side");
      host.append(btn);

      // ── sidebar panel ──
      panel = el("aside", "dswp-panel");
      panel.id = "dswp-panel";
      panel.setAttribute("role", "complementary");
      panel.setAttribute("aria-label", "背景个性化");

      const head = el("div", "dswp-head");
      head.append(el("span", "dswp-title", T.title));
      const closeBtn = el("button", "dswp-close", "✕");
      closeBtn.type = "button";
      closeBtn.title = T.close;
      closeBtn.setAttribute("aria-label", "关闭背景设置");
      closeBtn.addEventListener("click", () => { setOpen(false); btn?.focus(); });
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
      fileInput.setAttribute("aria-label", T.choose);
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
      fitSel.setAttribute("aria-label", T.fit);
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
      document.body.append(panel);

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

      syncSidebar();
      startSideObserver();
      window.addEventListener("resize", onResize);

      document.addEventListener("keydown", onEscape);

      // keep the shading in sync after a scheme/skin switch
      ctx.on("theme/change", () => {
        if (!S.img) return;
        applyLayer();
        shadeTokens(ctx);
      });

      ctx.effect(
        () => () => {
          teardownWallpaper();
          sideObserver?.disconnect();
          window.removeEventListener("resize", onResize);
          document.removeEventListener("keydown", onEscape);
          styleEl?.remove();
          host?.remove();
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
