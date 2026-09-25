// Runs before DSH's boot manifest is assigned. Desktop additions live beside
// the executable; the server's profile and conversation files are untouched.
(() => {
  if (window.top !== window || location.origin !== "__DSH_ORIGIN__") return;
  const revision = "desktop-v4";
  const plugins = [
    { id: "dsh-desktop-wallpaper", file: "wallpaper", inject: ["@deepseek-ai/dsh-client-ui-sidebar", "@deepseek-ai/dsh-client-ui-theme"] },
    { id: "dsh-desktop-attachments", file: "attachments", inject: ["@deepseek-ai/dsh-client-ui-conversation", "@deepseek-ai/dsh-client-ui-reference"] },
    { id: "dsh-desktop-balance", file: "balance", inject: ["@deepseek-ai/dsh-client-ui-conversation"] },
    { id: "dsh-desktop-stats-surface", file: "stats-surface", inject: ["@deepseek-ai/dsh-client-ui-chat"] },
  ];
  let manifest;
  Object.defineProperty(window, "__DSH_BOOT__", {
    configurable: true,
    get: () => manifest,
    set(value) {
      if (!value || !Array.isArray(value.entries) || !Array.isArray(value.batches)) {
        manifest = value;
        return;
      }
      const replaced = new Set(["dsh-wallpaper", "dsh-attachments", "dsh-balance", "dsh-stats-surface", ...plugins.map(p => p.id)]);
      const entries = value.entries.filter(p => !replaced.has(p.id));
      const batches = value.batches.map(b => ({ ...b, entries: b.entries.filter(id => !replaced.has(id)) }))
        .filter(b => b.entries.length);
      for (const plugin of plugins) {
        const url = `/__desktop/plugins/${plugin.file}.js?rev=${revision}`;
        entries.push({ id: plugin.id, url, rev: revision, inject: plugin.inject, external: ["react"] });
        batches.push({ phase: "application", url, rev: revision, entries: [plugin.id] });
      }
      manifest = { ...value, entries, batches };
    },
  });

  const webview = window.chrome?.webview;
  if (!webview) return;
  let pending;
  let balancePending;
  webview.addEventListener("message", event => {
    const result = event.data;
    if (result?.type === "dsh:balance-result" && result.requestId === balancePending?.id) {
      const request = balancePending;
      balancePending = undefined;
      clearTimeout(request.timeout);
      request.resolve(result);
      return;
    }
    if (result?.type !== "dsh:files-picked" || result.requestId !== pending?.id) return;
    const request = pending;
    pending = undefined;
    result.error ? request.reject(new Error(result.error)) : request.resolve(result);
  });
  window.dshDesktop = Object.freeze({
    getBalance() {
      if (balancePending) return balancePending.promise;
      const id = crypto.randomUUID();
      const promise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (balancePending?.id !== id) return;
          balancePending = undefined;
          reject(new Error("余额查询超时"));
        }, 15000);
        balancePending = { id, resolve, reject, timeout };
        try { webview.postMessage({ type: "dsh:balance-get", requestId: id }); }
        catch (error) { clearTimeout(timeout); balancePending = undefined; reject(error); }
      });
      if (balancePending?.id === id) balancePending.promise = promise;
      return promise;
    },
    pickFiles() {
      if (pending) return Promise.reject(new Error("文件选择窗口已打开"));
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        pending = { id, resolve, reject };
        try { webview.postMessage({ type: "dsh:pick-files", requestId: id }); }
        catch (error) { pending = undefined; reject(error); }
      });
    },
  });
})();
