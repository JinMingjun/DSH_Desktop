/**
 * dsh-balance — browser half (DSH client plugin bundle, hand-written to the
 * loader format used by dsh-wallpaper).
 *
 * Shows the DeepSeek API wallet balance in the Session header utilities row
 * (the same row as the "Session 日志" button). The host half owns the API key
 * and the `GET https://api.deepseek.com/user/balance` call; this file only
 * asks `/api/dsh-balance.balance` every 15 seconds.
 *
 * Loader contract: this file only registers a factory; it returns
 * `{ inject, apply }` when the module system materializes it.
 */
window.__ModuleLoader__.load({
  id: "dsh-balance",
  factory: require => {
    const React = require("react");
    const h = React.createElement;

    /** Host route (document-relative, like every DSH app route). */
    const ROUTE = "api/dsh-balance.balance";
    /** Refresh cadence while the page is visible. */
    const REFRESH_MS = 15000;
    /** Ignore bursts (focus + visibilitychange) closer than this. */
    const MIN_GAP_MS = 3000;
    const ENTRY = "dsh-balance";

    const styles = `
.dsh-balance{position:absolute;right:28px;bottom:11px;z-index:1;max-width:calc(100% - 150px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:13px;font-weight:500;line-height:16px;font-family:inherit;font-variant-numeric:tabular-nums}
.dsh-balance-utilities{position:relative}
.dsh-balance-utilities .dsh-balance{top:calc(100% + 4px);bottom:auto;left:50%;right:auto;max-width:none;transform:translateX(-50%)}
`;

    /** Two-decimal money text with grouped digits; sub-cent amounts stay readable. */
    function formatAmount(amount) {
      const value = typeof amount === "string" ? Number(amount) : amount;
      if (!Number.isFinite(value)) return null;
      if (value === 0) return "0.00";
      if (Math.abs(value) < 0.01) return "<0.01";
      return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    /** One wallet list → readable text parts. */
    function walletParts(wallets, pick) {
      if (!Array.isArray(wallets)) return [];
      const parts = [];
      for (const wallet of wallets) {
        if (!wallet || typeof wallet.currency !== "string") continue;
        const amount = formatAmount(wallet[pick]);
        if (amount !== null) parts.push(`${amount} ${wallet.currency}`);
      }
      return parts;
    }

    /**
     * Ask the host route; fall back to the desktop bridge when the host half is
     * not loaded (for example on a page served before the last dsh web restart).
     * @returns `{ ok: true, wallets, available }` or `{ ok: false, error }`.
     */
    async function queryBalance() {
      try {
        const response = await fetch(ROUTE, { headers: { accept: "application/json" }, cache: "no-store" });
        if (response.ok) {
          const body = await response.json();
          if (body !== null && typeof body === "object" && typeof body.ok === "boolean") return body;
        }
      } catch {
        // Route unavailable: try the desktop host bridge below.
      }
      const bridge = globalThis.dshDesktop;
      if (bridge !== undefined && typeof bridge.getBalance === "function") {
        try {
          const legacy = await bridge.getBalance();
          if (legacy !== null && typeof legacy === "object") {
            if (typeof legacy.balance === "string") {
              return { ok: true, available: true, wallets: [{ currency: "CNY", total: legacy.balance }] };
            }
            if (typeof legacy.error === "string") return { ok: false, error: legacy.error };
          }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : "余额查询失败" };
        }
      }
      return { ok: false, error: "余额查询接口不可用，请重启一次 dsh web" };
    }

    /**
     * Build the header label component.
     * @returns the slot component reading the host balance route.
     */
    function createBalanceLabel() {
      return function BalanceLabel() {
        const labelRef = React.useRef(null);
        const [state, setState] = React.useState({ text: null, note: null, failed: false });

        // The label hangs under the utilities row, centered on the "Session 日志" button.
        React.useLayoutEffect(() => {
          const utilities = labelRef.current?.closest('[class*="_headerUtilities"]');
          utilities?.classList.add("dsh-balance-utilities");
          return () => utilities?.classList.remove("dsh-balance-utilities");
        }, []);

        React.useEffect(() => {
          let active = true;
          let inFlight = false;
          let lastRequest = 0;

          const refresh = async () => {
            if (inFlight || Date.now() - lastRequest < MIN_GAP_MS) return;
            if (document.visibilityState === "hidden") return;
            inFlight = true;
            lastRequest = Date.now();
            try {
              const body = await queryBalance();
              if (!active) return;
              if (!body.ok) {
                // Keep the last good number on a transient failure.
                setState(prev => ({ ...prev, note: typeof body.error === "string" ? body.error : "余额查询失败", failed: true }));
                return;
              }
              const wallets = Array.isArray(body.wallets) ? body.wallets : [];
              const totals = walletParts(wallets, "total");
              if (totals.length === 0) {
                setState(prev => ({ ...prev, note: "余额接口未返回可用钱包", failed: true }));
                return;
              }
              const granted = walletParts(wallets, "granted");
              const toppedUp = walletParts(wallets, "toppedUp");
              const notes = [`DeepSeek API 余额；每 ${REFRESH_MS / 1000} 秒更新`];
              if (toppedUp.length > 0) notes.push(`充值 ${toppedUp.join(" / ")}`);
              if (granted.length > 0) notes.push(`赠送 ${granted.join(" / ")}`);
              if (body.available === false) notes.push("账户当前不可用");
              setState({ text: totals.join(" / "), note: notes.join("；"), failed: body.available === false });
            } catch (error) {
              if (active) setState(prev => ({
                ...prev,
                note: error instanceof Error ? error.message : "余额查询失败",
                failed: true,
              }));
            } finally {
              inFlight = false;
            }
          };

          refresh();
          const timer = window.setInterval(refresh, REFRESH_MS);
          const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
          window.addEventListener("focus", refresh);
          document.addEventListener("visibilitychange", onVisible);
          return () => {
            active = false;
            window.clearInterval(timer);
            window.removeEventListener("focus", refresh);
            document.removeEventListener("visibilitychange", onVisible);
          };
        }, []);

        return h("span", {
          ref: labelRef,
          className: "dsh-balance",
          title: state.note || "DeepSeek API 余额",
          "aria-live": "off",
          "aria-label": state.failed ? `余额不可用：${state.note}` : undefined,
        }, `余额：${state.text ?? "--"}`);
      };
    }

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement("style");
        style.dataset.plugin = ENTRY;
        style.textContent = styles;
        document.head.append(style);
        return () => style.remove();
      }, "dsh-balance: styles");
      const BalanceLabel = createBalanceLabel();
      ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
        name: "conversation.session.header.utilities",
        id: ENTRY,
        order: 100,
      }, BalanceLabel));
    }

    return { inject: ["slots"], apply };
  },
});
