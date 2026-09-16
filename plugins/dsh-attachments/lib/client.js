window.__ModuleLoader__.load({
  id: "dsh-attachments",
  factory: require => {
    const React = require("react");
    const h = React.createElement;
    const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
    const SOURCE = "dsh-attachments";
    const styles = `
.dsa-add{width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;flex:none;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary,#777);cursor:pointer;transition:background .15s,color .15s}
.dsa-add:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,#222)}
.dsa-add:disabled{opacity:.4;cursor:default}.dsa-add:focus-visible,.dsa-remove:focus-visible{outline:2px solid #5686fe;outline-offset:2px}
.dsa-add{order:-2}
.dsa-rail{box-sizing:border-box;flex:none;align-self:center;width:calc(100% - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-side-clearance,16px));max-width:var(--dsh-composer-card-max-width,100%);margin:0 auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(160px,100%),1fr));gap:6px;max-height:min(210px,32vh);overflow-x:hidden;overflow-y:auto;scrollbar-width:thin}
.dsa-card{display:flex;align-items:center;gap:8px;min-width:0;max-width:100%;height:46px;padding:6px 7px 6px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:9px;background:var(--dsw-specific-input-major,var(--dsw-alias-bg-base,#fff));color:var(--dsw-alias-label-primary,#222);box-sizing:border-box}
.dsa-file-icon{display:grid;place-items:center;width:26px;height:30px;flex:none;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.09));color:var(--dsw-alias-label-secondary,#777);font-size:8px;font-weight:600;letter-spacing:.2px}
.dsa-info{min-width:0;flex:1}.dsa-name{font-size:11px;line-height:16px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dsa-meta{font-size:10px;line-height:15px;color:var(--dsw-alias-label-tertiary,#888)}
[data-composer-chip="dsh-attachments"]{display:none}
.dsa-remove{display:grid;place-items:center;flex:none;width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#888);cursor:pointer}.dsa-remove:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,#222)}
@media(prefers-reduced-motion:reduce){.dsa-add{transition:none}}
`;

    function mention(path) {
      if (typeof path !== "string" || !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path) || /[\u0000-\u001f\u007f-\u009f"]/u.test(path))
        throw new Error("文件路径无法转换为 DSH 引用");
      return /\s/u.test(path) ? `@"${path}"` : `@${path}`;
    }
    const pathKey = path => /^[A-Za-z]:[\\/]|^\\\\/.test(path) ? path.replace(/\\/g, "/").toLowerCase() : path;
    const mentionKey = ref => pathKey(ref.replace(/^@"?|"$/g, ""));
    const sizeText = n => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
    // Lexical's detect projection represents each reference chip as one character.
    const detectOffset = (state, offset) => offset - state.occurrences.filter(o => o.offset < offset).reduce((sum, o) => sum + o.length - 1, 0);
    const editable = state => state.phase === "plain";
    const glyph = (path, size = 18) => h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", "aria-hidden": true }, h("path", { d: path }));
    function readDraftFiles(key) {
      try {
        const files = JSON.parse(window.localStorage.getItem(key) || "[]");
        return Array.isArray(files) ? files.filter(f => {
          if (!f || typeof f.name !== "string" || !Number.isFinite(f.size) || f.size < 0) return false;
          try { mention(f.path); return true; } catch { return false; }
        }).slice(0, 32) : [];
      } catch { return []; }
    }
    function plainMentionOffset(state, ref) {
      let at = state.draft.indexOf(ref);
      while (at >= 0) {
        const end = at + ref.length;
        if ((at === 0 || /\s/.test(state.draft[at - 1])) && (end === state.draft.length || /\s/.test(state.draft[end])) &&
            !state.occurrences.some(o => at < o.offset + o.length && end > o.offset)) return at;
        at = state.draft.indexOf(ref, at + 1);
      }
      return -1;
    }

    function createSessionApi(ctx, sessionId) {
      const actx = ctx.sessions.scope(sessionId);
      const binding = ctx.sessions.binding(sessionId);
      const conversation = actx.get("conversation");
      const input = conversation.input.for(actx);
      const imagePaths = new Map();
      const storageKey = `dsa:draft:${sessionId}`;
      let savedFiles = readDraftFiles(storageKey);
      let observedDraft = false;
      const current = () => ctx.sessions.binding(sessionId) === binding;
      const isEditable = () => current() && editable(input.state.getSnapshot()) && !binding.session.getSnapshot().removed && !ctx.conversation.blocks.storeFor(sessionId).getSnapshot();
      function addFiles(files) {
        if (!isEditable()) throw new Error("当前输入框暂不可添加附件，请稍后重试。");
        const errors = [];
        for (const file of files) {
          try {
            const state = input.state.getSnapshot();
            const key = pathKey(file.path);
            if (file.data && IMAGE_TYPES.has(file.mediaType)) {
              if (state.imageIds.some(id => imagePaths.get(id) === key)) continue;
              const bytes = Uint8Array.from(atob(file.data), c => c.charCodeAt(0));
              const limits = binding.session.projections.faceOf("imageLimits")?.getSnapshot();
              const previous = conversation.draftImages(state.imageIds);
              if (limits && (!limits.mediaTypes.includes(file.mediaType) || bytes.length > limits.maxImageBytes ||
                  previous.length + 1 > limits.maxImagesPerMessage || previous.reduce((n, i) => n + i.file.size, bytes.length) > limits.maxMessageImageBytes))
                throw new Error("超出当前模型的图片格式、数量或大小限制");
              const images = conversation.createDraftImages([new File([bytes], file.name, { type: file.mediaType })]);
              if (!input.addImages(images.map(i => i.id))) {
                conversation.releaseDraftImages(images);
                throw new Error("输入框正在发送，请稍后重试");
              }
              for (const image of images) imagePaths.set(image.id, key);
            } else {
              const ref = mention(file.path);
              if (state.occurrences.some(o => (o.source === SOURCE || o.source === "reference") && mentionKey(o.clipboardText) === mentionKey(ref))) continue;
              if (state.draft && !/\s$/.test(state.draft)) {
                const end = detectOffset(state, state.draft.length);
                if (!actx.bail("slash/input-insert-text", { text: " ", span: { start: end, end, draftRev: state.draftRev } }))
                  throw new Error("草稿已更新，请重试");
              }
              const fresh = input.state.getSnapshot();
              const at = detectOffset(fresh, fresh.draft.length);
              // A dedicated source keeps its model reference in DSH's normal
              // submit/undo/failure-restore lifecycle; its visual lives in the rail.
              const attachment = JSON.stringify({ path: file.path, name: file.name, size: file.size });
              if (!input.insertReference({ source: SOURCE, ref: attachment, label: file.name, appearance: "file", clipboardText: ref }, { start: at, end: at, draftRev: fresh.draftRev }))
                throw new Error("文件引用未能加入草稿，请重试");
            }
          } catch (error) { errors.push(`${file.name}：${error.message}`); }
        }
        if (errors.length) input.notify("error", errors.join("\n"));
      }
      return {
        addFiles,
        isEditable,
        syncDraft() {
          if (!current()) return;
          let state = input.state.getSnapshot();
          if (!editable(state)) return;
          // DSH restores drafts as plain mention text. Rebuild only this plugin's
          // previously selected files; manual @ references keep their usual UI.
          for (const file of savedFiles) {
            const ref = mention(file.path);
            if (state.occurrences.some(o => o.source === SOURCE && o.clipboardText === ref)) continue;
            const offset = plainMentionOffset(state, ref);
            if (offset < 0) continue;
            input.insertReference({ source: SOURCE, ref: JSON.stringify(file), label: file.name, appearance: "file", clipboardText: ref },
              { start: detectOffset(state, offset), end: detectOffset(state, offset + ref.length), draftRev: state.draftRev });
            state = input.state.getSnapshot();
          }
          if (!observedDraft && !state.draft) return;
          observedDraft = true;
          savedFiles = state.occurrences.filter(o => o.source === SOURCE).map(o => JSON.parse(o.ref));
          try {
            if (savedFiles.length) window.localStorage.setItem(storageKey, JSON.stringify(savedFiles));
            else window.localStorage.removeItem(storageKey);
          } catch { /* Storage unavailable: keep the live draft working. */ }
        },
        notify: text => { if (current()) input.notify("error", text); },
        remove(occurrenceId) {
          if (!isEditable()) return;
          const state = input.state.getSnapshot();
          const item = state.occurrences.find(o => o.occurrenceId === occurrenceId);
          if (!item) return;
          const at = detectOffset(state, item.offset);
          actx.bail("slash/input-insert-text", { text: "", span: { start: at, end: at + 1, draftRev: state.draftRev } });
        },
      };
    }

    function AddButton({ api, useInput, useSession }) {
      const state = useInput(s => s);
      const removed = useSession(s => s.removed);
      const [busy, setBusy] = React.useState(false);
      const lifetime = React.useRef(null);
      React.useEffect(() => { api.syncDraft(); }, [api, state.draftRev]);
      React.useEffect(() => {
        const token = {};
        lifetime.current = token;
        setBusy(false);
        return () => { if (lifetime.current === token) lifetime.current = null; };
      }, [api]);
      async function pick() {
        if (busy || !api.isEditable()) return;
        const token = lifetime.current;
        setBusy(true);
        try {
          const result = await window.dshDesktop.pickFiles();
          if (lifetime.current !== token) return;
          if (!result.cancelled) {
            api.addFiles(result.files || []);
            if (result.errors?.length) api.notify(result.errors.join("\n"));
          }
        } catch (error) { if (lifetime.current === token) api.notify(error.message); }
        finally { if (lifetime.current === token) setBusy(false); }
      }
      if (!window.dshDesktop) return null;
      return h("button", { type: "button", className: "dsa-add", title: "添加附件", "aria-label": busy ? "正在选择附件" : "添加附件", "aria-busy": busy,
        disabled: busy || removed || !editable(state), onClick: pick }, glyph("m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48", 19));
    }

    function FileRail({ api, useInput }) {
      const state = useInput(s => s);
      const files = state.occurrences.filter(o => o.source === SOURCE);
      if (!files.length) return null;
      return h("div", { className: "dsa-rail", role: "group", "aria-label": "文件附件" }, files.map(item => {
        const file = JSON.parse(item.ref);
        const ext = file.name.includes(".") ? file.name.split(".").pop().slice(0, 5).toUpperCase() : "FILE";
        return h("div", { className: "dsa-card", key: item.occurrenceId, title: file.path },
          h("span", { className: "dsa-file-icon", "aria-hidden": true }, ext),
          h("div", { className: "dsa-info" }, h("div", { className: "dsa-name" }, file.name), h("div", { className: "dsa-meta" }, `${ext} · ${sizeText(file.size)}`)),
          h("button", { type: "button", className: "dsa-remove", "aria-label": `移除 ${file.name}`, disabled: !editable(state), onClick: () => api.remove(item.occurrenceId) }, glyph("M7 7l10 10M17 7L7 17", 14)));
      }));
    }

    function apply(ctx) {
      const apis = new Map();
      ctx.effect(() => ctx.inputTriggers.registerSource({
        trigger: "@", name: SOURCE, showGroupTitle: false,
        candidates: async () => [], onPick: () => undefined,
        codec: attachmentCodec,
      }), "dsh-attachments: file reference serializer");
      const inject = sessionId => {
        const binding = ctx.sessions.binding(sessionId);
        let entry = apis.get(sessionId);
        if (!entry || entry.binding !== binding) {
          entry = { binding, api: createSessionApi(ctx, sessionId) };
          apis.set(sessionId, entry);
        }
        return { api: entry.api };
      };
      ctx.effect(() => {
        const style = document.createElement("style");
        style.textContent = styles;
        document.head.append(style);
        return () => { style.remove(); apis.clear(); };
      }, "dsh-attachments: styles");
      ctx.slots.inject("conversation.input.left", () => ctx.slots.register({ name: "conversation.input.left", id: "dsh-attachments", order: -100, inject }, AddButton));
      ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({ name: "conversation.input.dock", id: "dsh-attachments", order: 100, inject }, FileRail));
    }
    const attachmentCodec = {
      clipboardText: ref => mention(JSON.parse(ref).path),
      serialize: async ref => mention(JSON.parse(ref).path),
    };
    return { inject: ["slots", "sessions", "conversation", "inputTriggers"], apply, mention, detectOffset, createSessionApi, attachmentCodec };
  },
});
