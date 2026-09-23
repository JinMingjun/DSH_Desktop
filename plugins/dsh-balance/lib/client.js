window.__ModuleLoader__.load({
  id: "dsh-balance",
  factory: require => {
    const React = require("react");
    const h = React.createElement;
    const styles = `
.dsh-balance{position:absolute;right:28px;bottom:11px;z-index:1;max-width:calc(100% - 150px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:13px;font-weight:500;line-height:16px;font-family:inherit;font-variant-numeric:tabular-nums}
.dsh-balance-utilities{position:relative}
.dsh-balance-utilities .dsh-balance{top:calc(100% + 4px);bottom:auto;left:50%;right:auto;max-width:none;transform:translateX(-50%)}
`;

    function BalanceLabel() {
      const labelRef = React.useRef(null);
      const [state, setState] = React.useState({ balance: null, error: null });
      React.useLayoutEffect(() => {
        const utilities = labelRef.current?.closest('[class*="_headerUtilities"]');
        utilities?.classList.add("dsh-balance-utilities");
        return () => utilities?.classList.remove("dsh-balance-utilities");
      }, []);
      React.useEffect(() => {
        let active = true;
        let lastRequest = 0;
        const refresh = async () => {
          if (!window.dshDesktop?.getBalance || document.visibilityState === "hidden" || Date.now() - lastRequest < 5000) return;
          lastRequest = Date.now();
          try {
            const result = await window.dshDesktop.getBalance();
            if (active) setState({ balance: result.balance || null, error: result.error || null });
          } catch (error) {
            if (active) setState({ balance: null, error: error instanceof Error ? error.message : "余额查询失败" });
          }
        };
        refresh();
        const timer = window.setInterval(refresh, 15000);
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
        title: state.error || "DeepSeek API 当前账户可用余额；每 15 秒更新",
        "aria-label": state.error ? `余额查询失败：${state.error}` : undefined,
      }, `余额：${state.balance ?? "--"} CNY`);
    }

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement("style");
        style.textContent = styles;
        document.head.append(style);
        return () => style.remove();
      }, "dsh-balance: styles");
      ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
        name: "conversation.session.header.utilities", id: "dsh-balance", order: 100,
      }, BalanceLabel));
    }
    return { inject: ["slots"], apply };
  },
});
