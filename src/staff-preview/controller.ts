import type { App } from "../editor/app";
import type { ScoreSurface, StaffPlaybackState, StaffPreviewDocument, StaffPreviewNavigation, StaffPreviewSnapshot, StaffRenderedPage, StaffSelectionState, StaffViewMode } from "./types";
import "./staff-preview.css";

/** The existing jianpu DOM and its event listeners stay owned by App. */
export function wireStaffPreview(app: App): void {
  const root = document.getElementById("score-surfaces")!;
  const content = document.getElementById("score-surfaces-content")!;
  const pane = document.getElementById("staff-pane")!;
  const pages = document.getElementById("staff-pages")!;
  const divider = document.getElementById("staff-divider")!;
  const select = document.getElementById("staff-view-select") as HTMLSelectElement;
  const reason = document.getElementById("staff-view-reason")!;
  const status = document.getElementById("staff-preview-status")!;
  const surfaceLabel = document.getElementById("active-score-surface")!;
  const resume = document.getElementById("staff-resume-follow") as HTMLButtonElement;
  let mode: StaffViewMode = "jianpu";
  let preference: StaffViewMode = "compare";
  let firstOpen = true;
  try {
    const saved = localStorage.getItem("staff-preview-view");
    if (saved === "compare" || saved === "staff") { preference = saved; firstOpen = false; }
    const ratio = Number(localStorage.getItem("staff-preview-divider"));
    if (ratio >= 25 && ratio <= 75) root.style.setProperty("--staff-jianpu-ratio", `${ratio}%`);
  } catch { /* storage is optional */ }
  let active: ScoreSurface = "jianpu";
  let narrow = false;
  let zoom = 0.85;
  let zoomInitialized = false;
  let currentPage = 0;
  let prepared: StaffPreviewDocument | null = null;
  let snapshot: StaffPreviewSnapshot | null = null;
  let current = false;
  let abort: AbortController | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let follow = true;
  let playing: StaffPlaybackState = app.getStaffPlaybackState();
  let selection: StaffSelectionState = app.getStaffSelectionState();
  const mounted = new Map<number, StaffRenderedPage>();
  const wraps: HTMLElement[] = [];
  type MusicAnchor = { id: string; part: number; measure: number; beat: number; note: number; grace: boolean; offset: number };
  let savedAnchor: MusicAnchor | null = null;
  let savedJianpuPosition: { top: number; left: number } | null = null;
  const visible = (): boolean => mode !== "jianpu" && !pane.hidden;
  const notify = (): void => {
    const label = active === "staff" ? "五线谱 · 只读" : "简谱";
    if (surfaceLabel.textContent !== label) surfaceLabel.textContent = label;
    resume.hidden = active === "staff" ? follow : app.scorePane.dataset.staffFollow !== "paused";
    document.dispatchEvent(new Event("editor:workspace-change"));
    document.dispatchEvent(new Event("staff:navigation-change"));
  };
  const mark = (): void => {
    if (!mounted.size) return;
    const selected = new Set(selection.revision === prepared?.revision ? selection.notes.map(note => snapshot?.registry.refFor(note)?.id) : []);
    const chords = new Set(playing.revision === prepared?.revision ? playing.chords ?? [] : []);
    for (const page of mounted.values()) for (const note of page.notes) {
      note.element.classList.toggle("staff-selected", selected.has(note.ref.id));
      note.element.classList.toggle("staff-playing", chords.has(note.chord));
    }
  };
  const mountVisible = (): void => {
    if (!visible() || !prepared || !wraps.length) return;
    const top = pane.scrollTop;
    const bottom = top + pane.clientHeight;
    let first = wraps.findIndex(wrap => wrap.offsetTop + wrap.offsetHeight >= top);
    if (first < 0) first = wraps.length - 1;
    let last = first;
    while (last + 1 < wraps.length && wraps[last + 1].offsetTop < bottom) last++;
    const lo = Math.max(0, first - 1), hi = Math.min(wraps.length - 1, last + 1);
    for (const [index, page] of mounted) if (index < lo || index > hi) { page.svg.remove(); mounted.delete(index); }
    for (let index = lo; index <= hi; index++) {
      if (mounted.has(index)) continue;
      let page: StaffRenderedPage;
      try { page = prepared.renderPage(index); }
      catch (error) { current = false; status.textContent = `五线谱页面生成失败：${error instanceof Error ? error.message : String(error)}`; return; }
      page.svg.style.transform = `scale(${zoom})`;
      wraps[index].append(page.svg);
      mounted.set(index, page);
      for (const note of page.notes) note.hitElement.addEventListener("click", event => {
        if (!current || !app.isStaffPreviewCurrent() || note.ref.revision !== prepared?.revision) return;
        event.stopPropagation();
        activate("staff");
        pane.focus({ preventScroll: true });
        app.selectStaffPreviewNote(note.ref, { additive: (event as MouseEvent).ctrlKey || (event as MouseEvent).metaKey });
      });
    }
    currentPage = first;
    mark();
    notify();
  };
  const setZoom = (value: number): void => {
    const old = zoom;
    zoom = Math.max(0.2, Math.min(3, value));
    for (const wrap of wraps) { wrap.style.width = `${(prepared?.pageWidth ?? 0) * zoom}px`; wrap.style.height = `${(prepared?.pageHeight ?? 0) * zoom}px`; }
    for (const page of mounted.values()) page.svg.style.transform = `scale(${zoom})`;
    pane.scrollTop *= zoom / old;
    mountVisible(); notify();
  };
  const activate = (value: ScoreSurface): void => { if (value === "staff" && !visible()) return; active = value; notify(); };
  const pause = (surface: ScoreSurface): void => { if (surface === "staff") follow = false; else app.scorePane.dataset.staffFollow = "paused"; notify(); };
  const trackManualScroll = (element: HTMLElement, surface: ScoreSurface): void => {
    element.addEventListener("touchmove", () => { activate(surface); pause(surface); }, { passive: true });
    element.addEventListener("pointerdown", event => {
      const bounds = element.getBoundingClientRect();
      if (event.target === element && (event.clientX >= bounds.left + element.clientWidth
        || event.clientY >= bounds.top + element.clientHeight)) pause(surface);
    }, { passive: true });
  };
  trackManualScroll(app.scorePane, "jianpu");
  trackManualScroll(pane, "staff");
  const fitZoom = (): number => Math.max(0.2, Math.min(1, (pane.clientWidth - 40) / (prepared?.pageWidth ?? 800)));
  const noteIntoView = (index: number, find: (note: StaffRenderedPage["notes"][number]) => boolean): void => {
    if (!mounted.has(index)) { pane.scrollTop = wraps[index]?.offsetTop ?? pane.scrollTop; mountVisible(); }
    const element = mounted.get(index)?.notes.find(find)?.hitElement;
    if (!element) return;
    const bounds = pane.getBoundingClientRect(), rect = element.getBoundingClientRect();
    if (rect.top < bounds.top || rect.bottom > bounds.bottom || rect.left < bounds.left || rect.right > bounds.right) element.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  const captureAnchor = (): MusicAnchor | null => {
    if (!snapshot || !prepared) return savedAnchor;
    const primary = selection.primary ? snapshot.registry.refFor(selection.primary) : null;
    const sounding = Array.from(mounted.values()).flatMap(page => page.notes).find(note => playing.chords?.includes(note.chord));
    const bounds = pane.getBoundingClientRect();
    const visibleNote = Array.from(mounted.values()).flatMap(page => page.notes).find(note => note.hitElement.getBoundingClientRect().bottom >= bounds.top);
    const ref = primary ?? sounding?.ref ?? visibleNote?.ref;
    const target = ref ? snapshot.registry.resolve(ref) : null;
    if (!target) return savedAnchor;
    const element = Array.from(mounted.values()).flatMap(page => page.notes).find(note => note.ref.id === target.ref.id)?.hitElement;
    return { id: target.ref.id, part: target.partIndex, measure: target.measureIndex, beat: target.note.chord.position.toFloat(), note: target.noteIndex, grace: target.grace, offset: element ? element.getBoundingClientRect().top - bounds.top : 24 };
  };
  const restoreAnchor = (anchor: MusicAnchor | null): void => {
    if (!anchor || !prepared || !snapshot || !visible()) return;
    const candidates = snapshot.registry.targets.filter(target => target.partIndex === anchor.part && target.measureIndex === anchor.measure);
    const target = candidates.find(target => target.noteIndex === anchor.note && target.grace === anchor.grace && Math.abs(target.note.chord.position.toFloat() - anchor.beat) < 0.0001)
      ?? snapshot.registry.targets.find(target => target.ref.id === anchor.id);
    if (!target) return;
    const index = prepared.pageForRef(target.ref);
    if (index === null) return;
    if (!mounted.has(index)) { pane.scrollTop = wraps[index]?.offsetTop ?? pane.scrollTop; mountVisible(); }
    const element = mounted.get(index)?.notes.find(note => note.ref.id === target.ref.id)?.hitElement;
    if (element) pane.scrollTop += element.getBoundingClientRect().top - pane.getBoundingClientRect().top - anchor.offset;
    mountVisible();
  };
  const scrollRef = (): void => {
    if (!visible() || !prepared || !snapshot || selection.revision !== prepared.revision || !selection.primary) return;
    const ref = snapshot.registry.refFor(selection.primary);
    const index = ref ? prepared.pageForRef(ref) : null;
    if (index === null) return;
    noteIntoView(index, item => item.ref.id === ref?.id);
  };
  const refresh = async (): Promise<void> => {
    if (!visible() || !app.getStaffPreviewAvailability().supported || !app.isStaffPreviewCurrent()) return;
    selection = app.getStaffSelectionState(); playing = app.getStaffPlaybackState();
    const next = app.getStaffPreviewSnapshot();
    if (prepared?.revision === next.revision) { current = true; pane.setAttribute("aria-busy", "false"); status.textContent = prepared.diagnostics.join(" · "); mountVisible(); return; }
    abort?.abort(); const task = new AbortController(); abort = task;
    const anchor = captureAnchor();
    pane.setAttribute("aria-busy", "true");
    status.textContent = "正在生成五线谱…";
    try {
      const { prepareStaffPreview } = await import("./renderer");
      if (task.signal.aborted || !visible()) return;
      const result = await prepareStaffPreview(next, prepared ?? undefined, task.signal);
      if (task.signal.aborted || !visible() || !app.isStaffPreviewCurrent() || app.getStaffPreviewSnapshot().revision !== next.revision) { result.dispose(); return; }
      const old = prepared; prepared = result; snapshot = next; current = true;
      pane.dataset.staffRevision = String(result.revision); pane.setAttribute("aria-busy", "false");
      if (!zoomInitialized) { zoom = fitZoom(); zoomInitialized = true; }
      mounted.clear(); wraps.length = 0; pages.replaceChildren();
      for (let index = 0; index < result.pageCount; index++) { const wrap = document.createElement("div"); wrap.className = "staff-page"; wrap.dataset.page = String(index); wrap.style.width = `${result.pageWidth * zoom}px`; wrap.style.height = `${result.pageHeight * zoom}px`; wraps.push(wrap); pages.append(wrap); }
      if (old !== result) old?.dispose(); status.textContent = result.diagnostics.join(" · ");
      mountVisible(); restoreAnchor(anchor);
      if (selection.primary) scrollRef(); else if (playing.state === "playing") followPlayback();
    } catch (error) { if (!task.signal.aborted) { current = false; pane.setAttribute("aria-busy", "false"); status.textContent = `五线谱生成失败，保留上次预览：${error instanceof Error ? error.message : String(error)}`; } }
  };
  const schedule = (): void => { current = false; abort?.abort(); clearTimeout(refreshTimer); if (visible()) { pane.setAttribute("aria-busy", "true"); refreshTimer = setTimeout(() => void refresh(), 200); } };
  const setMode = (value: StaffViewMode, remember = true): void => {
    if (value !== "jianpu" && !app.getStaffPreviewAvailability().supported) value = "jianpu";
    if (remember && value !== "jianpu") { preference = value; try { localStorage.setItem("staff-preview-view", value); } catch { /* storage is optional */ } }
    const nextMode = narrow && value === "compare" ? "staff" : value;
    if (mode !== "staff" && nextMode === "staff") savedJianpuPosition = { top: app.scorePane.scrollTop, left: app.scorePane.scrollLeft };
    if (mode === "compare" && value === "jianpu") savedJianpuPosition = null;
    if (value === "jianpu" && mode !== "jianpu") savedAnchor = captureAnchor();
    mode = nextMode;
    root.dataset.staffView = mode; select.value = mode;
    app.scorePane.hidden = mode === "staff"; pane.hidden = mode === "jianpu"; divider.hidden = mode !== "compare";
    if (mode === "jianpu") {
      abort?.abort(); abort = null; clearTimeout(refreshTimer); active = "jianpu"; current = false; follow = true;
      prepared?.dispose(); prepared = null; snapshot = null; mounted.clear(); wraps.length = 0; pages.replaceChildren(); currentPage = 0;
      delete pane.dataset.staffRevision; pane.setAttribute("aria-busy", "false");
      if (savedJianpuPosition) { app.scorePane.scrollTop = savedJianpuPosition.top; app.scorePane.scrollLeft = savedJianpuPosition.left; savedJianpuPosition = null; }
    }
    else { active = mode === "staff" ? "staff" : active; void refresh(); }
    notify();
  };
  const availability = (): void => {
    const availability = app.getStaffPreviewAvailability();
    for (const option of Array.from(select.options)) if (option.value !== "jianpu") {
      const disabled = !availability.supported || (option.value === "compare" && narrow);
      if (option.disabled !== disabled) option.disabled = disabled;
    }
    const message = availability.supported ? (narrow ? "窄窗口使用单谱视图" : "五线谱只读，选择与播放同步") : availability.reason;
    if (reason.textContent !== message) reason.textContent = message;
    if (select.title !== availability.reason) select.title = availability.reason;
    if (!availability.supported && mode !== "jianpu") { setMode("jianpu", false); prepared?.dispose(); prepared = null; snapshot = null; pages.replaceChildren(); mounted.clear(); wraps.length = 0; }
  };
  const navigation: StaffPreviewNavigation = {
    get activeSurface() { return active; }, get staffVisible() { return visible(); },
    getPageSummary: () => ({ page: currentPage + 1, pages: prepared?.pageCount ?? 0, zoom }),
    goToPage: index => { pause("staff"); const target = Math.max(0, Math.min(index, wraps.length - 1)); wraps[target]?.scrollIntoView({ block: "start" }); mountVisible(); },
    zoomBy: factor => setZoom(zoom * factor), resetZoom: () => setZoom(fitZoom()),
    getExportPages: async () => {
      if (!app.isStaffPreviewCurrent()) throw new Error("五线谱正在更新，请稍后导出。");
      const source = app.getStaffPreviewSnapshot();
      const reusable = current && prepared?.revision === source.revision ? prepared : null;
      const document = reusable ?? await (await import("./renderer")).prepareStaffPreview(source);
      try {
        if (!source.current) throw new Error("乐谱已更新，请重新导出。");
        const exported = [];
        for (let page = 0; page < document.pageCount; page++) {
          exported.push({ page, svg: document.renderPage(page).svg });
        }
        return { currentPage: Math.min(currentPage, Math.max(0, document.pageCount - 1)), pages: exported };
      } finally { if (document !== reusable) document.dispose(); }
    },
  };
  app.setStaffPreviewNavigation(navigation);
  select.addEventListener("change", () => {
    const chosen = select.value as StaffViewMode;
    // Starting remains jianpu. The first preview opens in compare; subsequent
    // openings restore the last preview mode, while switches within it are explicit.
    const target = mode === "jianpu" && chosen !== "jianpu" ? (firstOpen ? "compare" : preference) : chosen;
    if (chosen !== "jianpu") firstOpen = false;
    setMode(target);
  });
  app.scorePane.addEventListener("pointerdown", () => activate("jianpu"), { passive: true });
  app.scorePane.addEventListener("focusin", () => activate("jianpu"));
  app.scorePane.addEventListener("wheel", event => { activate("jianpu"); if (!event.ctrlKey && !event.metaKey) pause("jianpu"); }, { passive: true, capture: true });
  document.addEventListener("editor:page-navigation", () => pause("jianpu"));
  pane.addEventListener("pointerdown", () => activate("staff"), { passive: true });
  pane.addEventListener("focusin", () => activate("staff"));
  pane.addEventListener("scroll", mountVisible, { passive: true });
  pane.addEventListener("wheel", event => { activate("staff"); if (event.ctrlKey || event.metaKey) { event.preventDefault(); setZoom(zoom * Math.exp(-event.deltaY * 0.0015)); } else pause("staff"); }, { passive: false });
  pane.addEventListener("keydown", event => {
    event.stopPropagation();
    if (event.key === " " && !app.workspaceSummary().inputEnabled) { event.preventDefault(); app.togglePlayback(); }
    else if (event.key === "PageDown") { event.preventDefault(); navigation.goToPage(currentPage + 1); }
    else if (event.key === "PageUp") { event.preventDefault(); navigation.goToPage(currentPage - 1); }
    else if ((event.ctrlKey || event.metaKey) && event.key === "Home") { event.preventDefault(); navigation.goToPage(0); }
    else if ((event.ctrlKey || event.metaKey) && event.key === "End") { event.preventDefault(); navigation.goToPage(1e9); }
    else if ((event.ctrlKey || event.metaKey) && ["+", "=", "-", "0"].includes(event.key)) { event.preventDefault(); event.key === "0" ? navigation.resetZoom() : navigation.zoomBy(event.key === "-" ? 1 / 1.2 : 1.2); }
    else if (["Delete", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "n", "N", " "].includes(event.key) || /^[0-7]$/.test(event.key)) event.preventDefault();
  }, { capture: true });
  resume.addEventListener("click", () => { if (active === "staff") { follow = true; followPlayback(); } else app.resumeJianpuPlaybackFollow(); notify(); });
  const followPlayback = (): void => {
    if (!follow || !visible() || !prepared || playing.revision !== prepared.revision || !playing.chords?.length) return;
    const index = prepared.pagesForChords(playing.chords)[0]; if (index === undefined) return;
    noteIntoView(index, note => !!playing.chords?.includes(note.chord));
  };
  document.addEventListener("staff:model-change", () => { availability(); schedule(); });
  document.addEventListener("editor:document-replaced", () => {
    // A new file must not inherit the previous file's viewport anchor or maps.
    abort?.abort(); abort = null; clearTimeout(refreshTimer);
    prepared?.dispose(); prepared = null; snapshot = null; current = false;
    mounted.clear(); wraps.length = 0; pages.replaceChildren(); currentPage = 0;
    savedAnchor = null; savedJianpuPosition = null; pane.scrollTop = 0;
    delete pane.dataset.staffRevision; pane.setAttribute("aria-busy", "false");
    selection = app.getStaffSelectionState(); playing = app.getStaffPlaybackState();
    availability(); schedule(); notify();
  });
  document.addEventListener("staff:stale", () => { current = false; abort?.abort(); if (visible()) pane.setAttribute("aria-busy", "true"); status.textContent = "文本正在更新，预览暂不可选择"; availability(); });
  document.addEventListener("staff:selection-change", event => { selection = (event as CustomEvent<StaffSelectionState>).detail; mark(); if (selection.origin !== "staff") scrollRef(); });
  document.addEventListener("staff:playback-change", event => { const next = (event as CustomEvent<StaffPlaybackState>).detail; if (next.state === "playing" && playing.state !== "playing") { follow = true; delete app.scorePane.dataset.staffFollow; } playing = next; mark(); followPlayback(); notify(); });
  document.addEventListener("editor:workspace-change", availability);
  const resize = (): void => { const next = content.clientWidth < 760; if (next !== narrow) { narrow = next; availability(); if (mode !== "jianpu") setMode(preference, false); } mountVisible(); };
  new ResizeObserver(resize).observe(content);
  let drag = false;
  divider.addEventListener("pointerdown", event => { drag = true; divider.setPointerCapture(event.pointerId); });
  divider.addEventListener("pointermove", event => { if (!drag) return; const bounds = content.getBoundingClientRect(); root.style.setProperty("--staff-jianpu-ratio", `${Math.max(25, Math.min(75, (event.clientX - bounds.left) / bounds.width * 100))}%`); });
  const saveDivider = (): void => { try { localStorage.setItem("staff-preview-divider", String(parseFloat(root.style.getPropertyValue("--staff-jianpu-ratio")) || 50)); } catch { /* storage is optional */ } };
  divider.addEventListener("pointerup", () => { drag = false; saveDivider(); }); divider.addEventListener("pointercancel", () => { drag = false; saveDivider(); });
  divider.addEventListener("keydown", event => { if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return; event.preventDefault(); const ratio = parseFloat(root.style.getPropertyValue("--staff-jianpu-ratio")) || 50; root.style.setProperty("--staff-jianpu-ratio", `${Math.max(25, Math.min(75, ratio + (event.key === "ArrowLeft" ? -5 : 5)))}%`); saveDivider(); });
  availability(); notify(); resize();
}
