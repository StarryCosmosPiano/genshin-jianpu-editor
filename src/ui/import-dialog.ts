/** Keep import drafts open while the rest of the workspace is inactive. */
export function blockImportBackground(layer: HTMLElement): () => void {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const backgrounds = [...document.body.children]
    .filter((node): node is HTMLElement => node instanceof HTMLElement && node !== layer)
    .map(node => ({ node, inert: node.inert }));
  for (const { node } of backgrounds) node.inert = true;
  layer.style.zIndex = "12000";

  const ignoreBackdrop = (event: Event): void => {
    if (event.target !== layer) return;
    event.preventDefault();
    event.stopPropagation();
  };
  layer.addEventListener("pointerdown", ignoreBackdrop);
  layer.addEventListener("click", ignoreBackdrop);
  layer.addEventListener("contextmenu", ignoreBackdrop);

  return () => {
    layer.removeEventListener("pointerdown", ignoreBackdrop);
    layer.removeEventListener("click", ignoreBackdrop);
    layer.removeEventListener("contextmenu", ignoreBackdrop);
    for (const { node, inert } of backgrounds) node.inert = inert;
    if (opener?.isConnected && !opener.closest("[inert]")) opener.focus({ preventScroll: true });
  };
}
