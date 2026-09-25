// The upstream chat statistics line is rendered inside this named composer dock.
// Its own component returns null when it has no statistics to show.
window.__ModuleLoader__.load({
  id: "dsh-stats-surface",
  factory: () => {
    const styles = `
[data-composer-seat] [data-slot="conversation.composer.dock"] > div:not(:empty) {
  box-sizing: border-box;
  width: 100%;
  max-width: var(--dsh-composer-card-max-width);
  margin-inline: auto;
  margin-block-start: 4px;
  padding: 5px 14px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, .22));
  border-radius: 10px;
  background: var(--dsw-specific-input-major, var(--dsw-alias-bg-base, #fff));
  color: var(--dsw-alias-label-secondary, #666);
  box-shadow: 0 3px 12px rgba(0, 0, 0, .07);
}
@supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  @media (prefers-reduced-transparency: no-preference) {
    [data-composer-seat] [data-slot="conversation.composer.dock"] > div:not(:empty) {
      background: color-mix(in srgb, var(--dsw-specific-input-major, var(--dsw-alias-bg-base, #fff)) 78%, transparent);
      -webkit-backdrop-filter: blur(14px) saturate(1.2);
      backdrop-filter: blur(14px) saturate(1.2);
    }
  }
}
`;
    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement("style");
        style.dataset.dshStatsSurface = "";
        style.textContent = styles;
        document.head.append(style);
        return () => style.remove();
      }, "dsh-stats-surface: styles");
    }
    return { apply };
  },
});
