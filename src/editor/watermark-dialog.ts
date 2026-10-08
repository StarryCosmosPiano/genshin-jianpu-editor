import { loadWatermarkOptions, pageViewBox, saveWatermarkOptions, withWatermark, type WatermarkOptions } from "./watermark";
import "./watermark-dialog.css";

export interface PageExportOptions {
  watermark: WatermarkOptions;
  zip: boolean;
  transparent: boolean;
}

/** Real page preview; each input refreshes the same composed SVG used by export. */
export function choosePageExportOptions(
  pages: ReadonlyArray<{ page: number; svg: SVGSVGElement }>,
  currentPage: number,
  title: string,
  pngOptions = false,
): Promise<PageExportOptions | null> {
  const first = pages.findIndex((page) => page.page === currentPage);
  let previewIndex = Math.max(0, first);
  const watermark = loadWatermarkOptions();
  return new Promise((resolve) => {
    const layer = document.createElement("div");
    layer.className = "watermark-dialog-layer";
    const dialog = document.createElement("div");
    dialog.className = "watermark-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "watermark-export-title");
    const header = document.createElement("header");
    const heading = document.createElement("h2");
    heading.id = "watermark-export-title";
    heading.textContent = title;
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "关闭";
    header.append(heading, closeButton);
    const body = document.createElement("div");
    body.className = "watermark-dialog-body";
    const controls = document.createElement("div");
    controls.className = "watermark-controls";
    const preview = document.createElement("div");
    preview.className = "watermark-preview";
    preview.setAttribute("aria-label", "当前乐谱页水印预览");
    const labeled = (caption: string, input: HTMLElement, inline = false): HTMLLabelElement => {
      const label = document.createElement("label");
      if (inline) label.className = "inline";
      const span = document.createElement("span");
      span.textContent = caption;
      label.append(span, input);
      return label;
    };
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = watermark.enabled;
    controls.append(labeled("添加水印", enabled, true));
    const text = document.createElement("input");
    text.type = "text";
    text.maxLength = 100;
    text.value = watermark.text;
    controls.append(labeled("水印文字", text));
    const opacity = document.createElement("input");
    opacity.type = "range";
    opacity.min = "0";
    opacity.max = "100";
    opacity.step = "1";
    opacity.value = String(Math.round(watermark.opacity * 100));
    const opacityLabel = document.createElement("span");
    const opacityField = labeled("透明度", opacity);
    opacityField.append(opacityLabel);
    controls.append(opacityField);
    const density = document.createElement("input");
    density.type = "range";
    density.min = "1";
    density.max = "15";
    density.step = "1";
    density.value = String(watermark.density);
    const densityLabel = document.createElement("span");
    const densityField = labeled("每页数量", density);
    densityField.append(densityLabel);
    controls.append(densityField);
    const zip = document.createElement("input");
    zip.type = "checkbox";
    zip.checked = pages.length > 1;
    const transparent = document.createElement("input");
    transparent.type = "checkbox";
    transparent.checked = true;
    if (pngOptions) {
      controls.append(labeled("透明背景", transparent, true));
      if (pages.length > 1) controls.append(labeled("压缩为 ZIP 文件", zip, true));
    }
    const pageNav = document.createElement("div");
    pageNav.className = "inline";
    if (pages.length > 1) {
      const previous = document.createElement("button");
      previous.type = "button";
      previous.textContent = "上一页";
      const pageLabel = document.createElement("span");
      const next = document.createElement("button");
      next.type = "button";
      next.textContent = "下一页";
      const changePage = (direction: number) => {
        previewIndex = (previewIndex + direction + pages.length) % pages.length;
        renderPreview();
      };
      previous.onclick = () => changePage(-1);
      next.onclick = () => changePage(1);
      pageNav.append(previous, pageLabel, next);
      controls.append(pageNav);
      pageNav.dataset.pageLabel = "";
      const updateLabel = () => { pageLabel.textContent = `第 ${previewIndex + 1} / ${pages.length} 页`; };
      pageNav.addEventListener("preview-page-changed", updateLabel);
    }
    const hint = document.createElement("small");
    hint.textContent = "预览显示实际谱页；中央始终有一枚完整水印，边缘水印可被页面裁切。";
    controls.append(hint);
    body.append(controls, preview);
    const footer = document.createElement("footer");
    const cancel = document.createElement("button");
    cancel.textContent = "取消";
    const confirm = document.createElement("button");
    confirm.textContent = "导出";
    confirm.className = "primary";
    footer.append(cancel, confirm);
    dialog.append(header, body, footer);
    layer.append(dialog);
    const current = (): WatermarkOptions => ({
      enabled: enabled.checked,
      text: text.value,
      opacity: Number(opacity.value) / 100,
      density: Number(density.value),
    });
    const renderPreview = () => {
      opacityLabel.textContent = `${opacity.value}%`;
      densityLabel.textContent = `${density.value} 枚`;
      const svg = withWatermark(pages[previewIndex].svg, current(), pngOptions && transparent.checked);
      const box = pageViewBox(svg);
      svg.setAttribute("width", String(box.width));
      svg.setAttribute("height", String(box.height));
      preview.replaceChildren(svg);
      preview.classList.toggle("transparent", pngOptions && transparent.checked);
      pageNav.dispatchEvent(new Event("preview-page-changed"));
    };
    for (const input of [enabled, text, opacity, density, transparent]) input.addEventListener("input", renderPreview);
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const backgrounds = [...document.body.children].filter((node): node is HTMLElement => node instanceof HTMLElement)
      .map((node) => ({ node, inert: node.inert }));
    for (const entry of backgrounds) entry.node.inert = true;
    document.body.append(layer);
    let settled = false;
    const finish = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      layer.remove();
      document.removeEventListener("editor:document-replaced", cancelExport);
      for (const entry of backgrounds) entry.node.inert = entry.inert;
      opener?.focus({ preventScroll: true });
      const value = current();
      if (accepted) saveWatermarkOptions(value);
      resolve(accepted ? { watermark: value, zip: zip.checked, transparent: transparent.checked } : null);
    };
    const cancelExport = () => finish(false);
    cancel.onclick = cancelExport;
    closeButton.onclick = cancelExport;
    confirm.onclick = () => finish(true);
    layer.addEventListener("pointerdown", (event) => { if (event.target === layer) cancelExport(); });
    layer.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); cancelExport(); }
      else if (event.key === "Tab") {
        const focusable = [...dialog.querySelectorAll<HTMLElement>("button,input")]
          .filter((element) => !element.hasAttribute("disabled") && element.getClientRects().length > 0);
        const index = focusable.indexOf(document.activeElement as HTMLElement);
        if (event.shiftKey && index <= 0 || !event.shiftKey && index === focusable.length - 1) {
          event.preventDefault();
          (event.shiftKey ? focusable[focusable.length - 1] : focusable[0])?.focus();
        }
      }
      event.stopPropagation();
    });
    document.addEventListener("editor:document-replaced", cancelExport);
    renderPreview();
    enabled.focus();
  });
}
