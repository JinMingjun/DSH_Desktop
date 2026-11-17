window.__ModuleLoader__.load({
  id: "dsh-tray",
  factory: () => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const inject = ["sessions", "workspaces", "uiWorkspace"];
    const MAX_RECENT = 5;

    function workspaceLabel(path) {
      if (typeof path !== "string" || path.length === 0) return "";
      const normalized = path.replace(/[\\/]+$/, "");
      const parts = normalized.split(/[\\/]/);
      return parts.at(-1) || normalized;
    }

    function apply(ctx) {
      const webview = globalThis.chrome?.webview;
      if (webview === undefined) return;

      const sessions = ctx.get("sessions");
      const workspaces = ctx.get("workspaces");
      const navigation = ctx.get("uiWorkspace");
      if (sessions === undefined || workspaces === undefined || navigation === undefined) return;

      ctx.effect(() => {
        let active = true;
        const post = (message) => {
          if (!active) return;
          try { webview.postMessage(message); } catch { /* desktop bridge is gone */ }
        };

        const publishRecent = () => {
          const catalog = sessions.list.getSnapshot();
          const workspaceState = workspaces.list.getSnapshot();
          const archived = new Set(workspaceState.archivedSessionIds ?? []);
          const recent = catalog.ids
            .map((id) => catalog.byId[id])
            .filter((session) => session !== undefined
              && !session.blank
              && session.origin !== "subagent"
              && !archived.has(session.id))
            .sort((left, right) => right.updatedAt - left.updatedAt)
            .slice(0, MAX_RECENT)
            .map((session) => ({
              id: session.id,
              title: session.displayTitle || session.title || session.id,
              workspace: workspaceLabel(session.cwd),
            }));
          post({ type: "dsh:tray-recent", sessions: recent });
        };

        const onMessage = (event) => {
          const message = event.data;
          if (message?.type !== "dsh:tray-command") return;
          if (message.command === "new-chat") {
            navigation.startSession();
            return;
          }
          if (message.command === "open-session" && typeof message.sessionId === "string") {
            const session = sessions.list.getSnapshot().byId[message.sessionId];
            if (session !== undefined && !session.blank) navigation.openSession(message.sessionId);
          }
        };

        webview.addEventListener("message", onMessage);
        const stopSessions = sessions.list.subscribe(publishRecent);
        const stopWorkspaces = workspaces.list.subscribe(publishRecent);
        post({ type: "dsh:tray-state", enabled: true });
        publishRecent();

        return () => {
          post({ type: "dsh:tray-state", enabled: false });
          active = false;
          stopSessions();
          stopWorkspaces();
          webview.removeEventListener("message", onMessage);
        };
      }, "dsh-tray: desktop bridge");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
