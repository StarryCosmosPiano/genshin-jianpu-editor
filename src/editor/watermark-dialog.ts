import { loadWatermarkOptions, pageViewBox, saveWatermarkOptions, type WatermarkOptions } from "./watermark";
import { composeExportPageSvg } from "./export-page";
import type { ExportAppearance, ExportPage } from "./export-display";
import "./watermark-dialog.css";
import { parseRecognitionPages } from "./mobile-import";
import { isTouchWorkspace } from "../bootstrap/device-mode";
import { isTauriRuntime } from "./fileio";

export interface PageExportOptions {
  watermark: WatermarkOptions;
  zip: boolean;
  transparent: boolean;
  includeRhythmGuides: boolean;
  appearance?: ExportAppearance;
  /** Zero-based source pages, in their original order. */
  pages?: number[];
}

export interface PageExportDisplaySettings {
  initialSurface: ExportAppearance["surface"];
  staffAvailable: boolean;
  staffReason?: string;
  renderPages: (appearance: ExportAppearance) => Promise<readonly ExportPage[]>;
}

/** Real page preview; each input refreshes the same composed SVG used by export. */
export function choosePageExportOptions(
  initialPages: ReadonlyArray<{ page: number; svg: SVGSVGElement }>,
  currentPage: number,
  title: string,
  pngOptions = false,
  display?: PageExportDisplaySettings,
): Promise<PageExportOptions | null> {
  let pages = initialPages;
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
    const rhythmGuides = document.createElement("input");
    rhythmGuides.type = "checkbox";
    rhythmGuides.checked = false;
    controls.append(labeled("导出刻度线", rhythmGuides, true));
    const pageRange = document.createElement("input");
    pageRange.type = "text";
    pageRange.placeholder = "全部；或填写 1-3,5";
    pageRange.setAttribute("aria-label", "导出页码（留空为全部）");
    controls.append(labeled("导出页码（留空为全部）", pageRange));
    const pageRangeError = document.createElement("small");
    pageRangeError.setAttribute("role", "alert");
    pageRangeError.hidden = true;
    controls.append(pageRangeError);
    const surface = document.createElement("select");
    surface.setAttribute("aria-label", "导出谱型");
    for (const [value, caption] of [["jianpu", "简谱"], ["staff", "五线谱"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = caption;
      option.disabled = value === "staff" && !display?.staffAvailable;
      surface.append(option);
    }
    surface.value = display?.initialSurface ?? "jianpu";
    const notation = document.createElement("select");
    notation.setAttribute("aria-label", "音符显示");
    for (const [value, caption] of [["current", "保持当前显示"], ["number", "数字简谱"], ["keyboard", "键盘字母"]]) {
      const option = document.createElement("option");
      option.value = value; option.textContent = caption; notation.append(option);
    }
    const voiceColors = document.createElement("input");
    voiceColors.type = "checkbox";
    voiceColors.checked = false;
    if (display) {
      controls.append(labeled("导出谱型", surface), labeled("音符显示", notation), labeled("显示颜色标记", voiceColors, true));
      if (!display.staffAvailable && display.staffReason) {
        const reason = document.createElement("small"); reason.textContent = display.staffReason; controls.append(reason);
      }
    }
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
    const densityField = labeled("水印密度", density);
    densityField.append(densityLabel);
    controls.append(densityField);
    const zip = document.createElement("input");
    zip.type = "checkbox";
    zip.checked = pages.length > 1;
    const transparent = document.createElement("input");
    transparent.type = "checkbox";
    transparent.checked = true;
    const zipRow = labeled("压缩为 ZIP 文件", zip, true);
    zipRow.hidden = pages.length <= 1;
    const requiresZip = isTouchWorkspace() && !isTauriRuntime()
      && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker !== "function";
    if (requiresZip) {
      zip.disabled = true;
      zip.title = "当前浏览器不能选择文件夹，多页 PNG 会打包成一个 ZIP 文件。";
    }
    if (pngOptions) {
      controls.append(labeled("透明背景", transparent, true));
      controls.append(zipRow);
      if (requiresZip && pages.length > 1) {
        const zipHint = document.createElement("small");
        zipHint.textContent = "当前浏览器不能选择文件夹，多页 PNG 将打包为 ZIP，再分享或下载。";
        controls.append(zipHint);
      }
    }
    const pageNav = document.createElement("div");
    pageNav.className = "inline";
    {
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
      pageNav.hidden = pages.length <= 1;
      pageNav.dataset.pageLabel = "";
      const updateLabel = () => { pageLabel.textContent = `第 ${previewIndex + 1} / ${pages.length} 页`; };
      pageNav.addEventListener("preview-page-changed", updateLabel);
    }
    const hint = document.createElement("small");
    hint.textContent = "预览与导出使用相同谱页；显示设置仅用于本次导出。水印按密度围绕页面中心对称排列。";
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
    const appearance = (): ExportAppearance => ({ surface: surface.value as ExportAppearance["surface"],
      notation: notation.value as ExportAppearance["notation"], voiceColors: voiceColors.checked });
    const renderPreview = () => {
      opacityLabel.textContent = `${opacity.value}%`;
      densityLabel.textContent = `${density.value} 档（稀疏 → 密集）`;
      if (!pages[previewIndex]) return;
      const svg = composeExportPageSvg(pages[previewIndex].svg, current(), pngOptions && transparent.checked, rhythmGuides.checked);
      const box = pageViewBox(svg);
      svg.setAttribute("width", String(box.width));
      svg.setAttribute("height", String(box.height));
      preview.replaceChildren(svg);
      preview.classList.toggle("transparent", pngOptions && transparent.checked);
      pageNav.dispatchEvent(new Event("preview-page-changed"));
    };
    let renderRevision = 0;
    const updateDisplay = async () => {
      if (!display) return;
      const revision = ++renderRevision;
      notation.disabled = surface.value === "staff";
      confirm.disabled = true;
      preview.setAttribute("aria-busy", "true");
      try {
        const next = await display.renderPages(appearance());
        if (revision !== renderRevision || settled) return;
        if (!next.length) throw new Error("当前没有可导出的谱面页面");
        pages = next;
        previewIndex = Math.min(previewIndex, pages.length - 1);
        pageNav.hidden = pages.length <= 1;
        zipRow.hidden = pages.length <= 1;
        if (requiresZip) zip.checked = pages.length > 1;
        confirm.disabled = false;
        renderPreview();
      } catch (error) {
        if (revision !== renderRevision || settled) return;
        const message = document.createElement("p");
        message.textContent = error instanceof Error ? error.message : String(error);
        preview.replaceChildren(message);
      } finally {
        if (revision === renderRevision) preview.removeAttribute("aria-busy");
      }
    };
    for (const input of [surface, notation, voiceColors]) input.addEventListener("change", () => { void updateDisplay(); });
    for (const input of [enabled, text, opacity, density, transparent, rhythmGuides]) input.addEventListener("input", renderPreview);
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const backgrounds = [...document.body.children].filter((node): node is HTMLElement => node instanceof HTMLElement)
      .map((node) => ({ node, inert: node.inert }));
    for (const entry of backgrounds) entry.node.inert = true;
    document.body.append(layer);
    let settled = false;
    const finish = (accepted: boolean) => {
      if (settled) return;
      let selectedPages = pages.map(page => page.page);
      if (accepted && pageRange.value.trim()) {
        try {
          selectedPages = parseRecognitionPages(pageRange.value, Math.max(...pages.map(page => page.page + 1)))
            .map(page => page - 1);
          if (selectedPages.some(index => !pages.some(page => page.page === index))) throw new Error("请选择本次预览中可用的页码");
        } catch (error) {
          pageRangeError.hidden = false;
          pageRangeError.textContent = error instanceof Error ? error.message : String(error);
          pageRange.focus();
          return;
        }
      }
      settled = true;
      renderRevision++;
      layer.remove();
      document.removeEventListener("editor:document-replaced", cancelExport);
      for (const entry of backgrounds) entry.node.inert = entry.inert;
      opener?.focus({ preventScroll: true });
      const value = current();
      if (accepted) saveWatermarkOptions(value);
      resolve(accepted ? { watermark: value, zip: zip.checked, transparent: transparent.checked,
        includeRhythmGuides: rhythmGuides.checked, pages: selectedPages, ...(display ? { appearance: appearance() } : {}) } : null);
    };
    const cancelExport = () => finish(false);
    cancel.onclick = cancelExport;
    closeButton.onclick = cancelExport;
    confirm.onclick = () => finish(true);
    layer.addEventListener("pointerdown", (event) => { if (event.target === layer) cancelExport(); });
    layer.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); cancelExport(); }
      else if (event.key === "Tab") {
        const focusable = [...dialog.querySelectorAll<HTMLElement>("button,input,select")]
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
    if (display) void updateDisplay();
    enabled.focus();
  });
}
