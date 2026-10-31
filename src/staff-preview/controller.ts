import type { App } from "../editor/app";
import type { ScoreSurface, StaffHeaderField, StaffInputSpan, StaffNoteRef, StaffPlaybackState, StaffPreviewDocument, StaffPreviewNavigation, StaffPreviewSnapshot, StaffRenderedPage, StaffSelectionState, StaffViewMode } from "./types";
import { staffCursorPoint, staffInputAtPoint, staffNextInputAnchor, staffPitchAtY, staffSnapAnchors } from "./input-geometry";
import { SVG_NS } from "./renderer-svg";
import { remapShortcutEvent } from "../editor/shortcuts";
import { scrollPlaybackTarget } from "../editor/playback-follow";
import { Chord } from "../score/score";
import { Fraction } from "../common/fraction";
import { spellPitch } from "../score/musicxml-export";
import { isTouchWorkspace } from "../bootstrap/device-mode";
import { registerTouchScoreSurface } from "../bootstrap/touch-score-bridge";
import type { ScoreSelectionMode, ScoreTouchCandidate } from "../editor/score-commands";
import type { TouchPoint } from "../bootstrap/touch-gesture-state";
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
  try {
    const saved = localStorage.getItem("staff-preview-view");
    if (saved === "compare" || saved === "staff") preference = saved;
    const ratio = Number(localStorage.getItem("staff-preview-divider"));
    if (ratio >= 25 && ratio <= 75) root.style.setProperty("--staff-jianpu-ratio", `${ratio}%`);
  } catch { /* storage is optional */ }
  let active: ScoreSurface = "jianpu";
  let narrow = false;
  let zoom = 0.85;
  let zoomInitialized = false;
  let fitToWidth = true;
  let currentPage = 0;
  let prepared: StaffPreviewDocument | null = null;
  let snapshot: StaffPreviewSnapshot | null = null;
  let current = false;
  let abort: AbortController | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let follow = true;
  let revealPending = false;
  let pendingInputMoves: Array<-1 | 1> = [];
  let playing: StaffPlaybackState = app.getStaffPlaybackState();
  let selection: StaffSelectionState = app.getStaffSelectionState();
  const mounted = new Map<number, StaffRenderedPage>();
  let marquee: { page: StaffRenderedPage; pointer: number; x: number; y: number; endX: number; endY: number;
    additive: boolean; armed: boolean; moved: boolean; rect: SVGRectElement | null; timer?: ReturnType<typeof setTimeout> } | null = null;
  let suppressClick = false;
  const cancelMarquee = (): void => {
    if (!marquee) return;
    clearTimeout(marquee.timer); marquee.rect?.remove(); marquee.page.svg.style.touchAction = "";
    if (marquee.page.svg.hasPointerCapture(marquee.pointer)) marquee.page.svg.releasePointerCapture(marquee.pointer);
    marquee = null;
  };
  const drawMarquee = (): void => {
    if (!marquee) return;
    const matrix = marquee.page.svg.getScreenCTM(); if (!matrix) return;
    const start = new DOMPoint(marquee.x, marquee.y).matrixTransform(matrix.inverse());
    const end = new DOMPoint(marquee.endX, marquee.endY).matrixTransform(matrix.inverse());
    if (!marquee.rect) {
      marquee.rect = document.createElementNS(SVG_NS, "rect");
      marquee.rect.setAttribute("class", "staff-marquee"); marquee.rect.setAttribute("pointer-events", "none");
      marquee.page.svg.append(marquee.rect);
    }
    for (const [key, value] of Object.entries({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) })) marquee.rect.setAttribute(key, String(value));
  };
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && marquee) {
      event.preventDefault(); event.stopImmediatePropagation(); cancelMarquee(); suppressClick = true;
      document.addEventListener("pointerup", () => setTimeout(() => { suppressClick = false; }, 0), { once: true });
    }
  }, { capture: true });
  const wraps: HTMLElement[] = [];
  type MusicAnchor = { id: string; part: number; measure: number; beat: number; note: number; grace: boolean; offset: number };
  let savedAnchor: MusicAnchor | null = null;
  let savedJianpuPosition: { top: number; left: number } | null = null;
  const visible = (): boolean => mode !== "jianpu" && !pane.hidden;
  const notify = (): void => {
    const label = active === "staff" ? "五线谱" : "简谱";
    if (surfaceLabel.textContent !== label) surfaceLabel.textContent = label;
    resume.hidden = active === "staff" ? follow : app.scorePane.dataset.staffFollow !== "paused";
    document.dispatchEvent(new Event("editor:workspace-change"));
    document.dispatchEvent(new Event("staff:navigation-change"));
  };
  const mark = (): void => {
    if (!mounted.size) return;
    const selected = new Set(selection.revision === prepared?.revision ? selection.notes.map(note => snapshot?.registry.refFor(note)?.id) : []);
    const chords = new Set(playing.revision === prepared?.revision ? playing.chords ?? [] : []);
    const tones = playing.notes ? new Set(playing.notes.map(note => snapshot?.registry.refFor(note)?.id)) : null;
    for (const page of mounted.values()) for (const note of page.notes) {
      note.element.classList.toggle("staff-selected", selected.has(note.ref.id));
      note.element.classList.toggle("staff-playing", chords.has(note.chord) && (!tones || tones.has(note.ref.id)));
    }
  };
  let hoverPreview: { page: StaffRenderedPage; x: number; y: number; span: StaffInputSpan } | null = null;
  const clearInputOverlays = (kind?: "hover" | "cursor"): void => {
    if (kind !== "cursor") hoverPreview = null;
    for (const page of mounted.values()) page.svg.querySelectorAll(kind ? `[data-staff-input-overlay="${kind}"]` : "[data-staff-input-overlay]").forEach(element => element.remove());
  };
  const drawInputPreview = (page: StaffRenderedPage, x: number, y: number, span: StaffInputSpan, hover: boolean): void => {
    const { lineSpacing, bottomLineY, rulerY } = span;
    clearInputOverlays(hover ? "hover" : "cursor");
    if (hover) hoverPreview = { page, x, y, span };
    const group = document.createElementNS(SVG_NS, "g"); group.setAttribute("data-staff-input-overlay", hover ? "hover" : "cursor");
    group.setAttribute("class", "staff-input-preview"); group.setAttribute("pointer-events", "none");
    const column = document.createElementNS(SVG_NS, "line");
    column.setAttribute("class", "staff-input-column"); column.setAttribute("data-staff-input-column", hover ? "hover" : "cursor");
    column.setAttribute("x1", String(x)); column.setAttribute("x2", String(x));
    column.setAttribute("y1", String(span.yTop)); column.setAttribute("y2", String(rulerY + lineSpacing));
    if (!hover) group.append(column);
    const coversSelected = selection.revision === prepared?.revision && selection.notes.some(note => {
      if (note.rest) return false;
      const ref = snapshot?.registry.refFor(note), target = ref ? snapshot?.registry.resolve(ref) : null;
      if (!target || target.grace || target.partIndex !== span.partIndex || target.measureIndex !== span.measureIndex) return false;
      const tick = note.chord.position.toFloat();
      const fifths = [...span.keyChanges].reverse().find(mark => mark.tick <= tick + 1e-8)?.fifths ?? span.fifths;
      const point = staffCursorPoint(span, note.chord.position.toString(), note.pitch, spellPitch(note, fifths));
      return Math.abs(point.x - x) < 0.01 && Math.abs(point.y - y) < 0.01;
    });
    if (coversSelected) { page.svg.append(group); return; }
    const size = Math.max(3, lineSpacing * 0.45);
    const path = (d: string): void => { const element = document.createElementNS(SVG_NS, "path"); element.setAttribute("d", d); group.append(element); };
    for (let ledger = bottomLineY + lineSpacing; ledger <= y + 0.1; ledger += lineSpacing) path(`M ${x - size * 1.8} ${ledger} L ${x + size * 1.8} ${ledger}`);
    for (let ledger = bottomLineY - lineSpacing * 5; ledger >= y - 0.1; ledger -= lineSpacing) path(`M ${x - size * 1.8} ${ledger} L ${x + size * 1.8} ${ledger}`);
    const head = document.createElementNS(SVG_NS, "ellipse"); head.setAttribute("cx", String(x)); head.setAttribute("cy", String(y));
    head.setAttribute("class", "staff-input-notehead");
    head.setAttribute("rx", String(size * 1.35)); head.setAttribute("ry", String(size)); head.setAttribute("transform", `rotate(-18 ${x} ${y})`); group.append(head);
    page.svg.append(group);
  };
  const renderInputCursor = (): void => {
    const state = app.getStaffEditorState(); clearInputOverlays("cursor");
    if (!state.inputEnabled) { pendingInputMoves = []; clearInputOverlays(); }
    if (!current || !state.inputEnabled || !state.cursor) return;
    for (const page of mounted.values()) {
      const span = page.inputSpans.find(item => item.partIndex === state.cursor!.partIndex && item.measureIndex === state.cursor!.measureIndex);
      if (!span) continue;
      const point = staffCursorPoint(span, state.cursor.offset, state.cursor.focusPitch, state.cursor);
      drawInputPreview(page, point.x, point.y, span, false);
      break;
    }
    if (hoverPreview && [...mounted.values()].includes(hoverPreview.page)) {
      const preview = hoverPreview;
      drawInputPreview(preview.page, preview.x, preview.y, preview.span, true);
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
      const pointAt = (event: MouseEvent): ReturnType<typeof staffInputAtPoint> => {
        const matrix = page.svg.getScreenCTM(); if (!matrix) return null;
        const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
        return staffInputAtPoint(page.inputSpans, point.x, point.y);
      };
      const exactInputNote = (hit: NonNullable<ReturnType<typeof staffInputAtPoint>>) => snapshot?.registry.targets.find(target => {
        if (target.grace || target.note.rest || target.partIndex !== hit.position.partIndex || target.measureIndex !== hit.position.measureIndex
          || !target.note.chord.position.equals(Fraction.fromString(hit.position.offset))) return false;
        const fifths = [...hit.span.keyChanges].reverse().find(mark => mark.tick <= target.note.chord.position.toFloat() + 1e-8)?.fifths ?? hit.span.fifths;
        const spelling = spellPitch(target.note, fifths);
        return target.note.pitch === hit.position.midi && spelling.step === hit.position.step && spelling.octave === hit.position.octave;
      });
      page.svg.addEventListener("pointerdown", event => {
        const inputMarquee = app.interactionMode === "input" && (event.ctrlKey || event.metaKey || event.shiftKey);
        if (event.button !== 0 || app.interactionMode !== "select" && !inputMarquee || !current || !app.isStaffPreviewCurrent()) return;
        if (event.target instanceof Element && event.target.closest("[data-staff-header],[data-staff-ref]")) return;
        if (page.notes.some(note => { const rect = note.hitElement.getBoundingClientRect();
          return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom; })) return;
        cancelMarquee(); activate("staff"); pane.focus({ preventScroll: true });
        const drag = marquee = { page, pointer: event.pointerId, x: event.clientX, y: event.clientY,
          endX: event.clientX, endY: event.clientY, additive: !event.shiftKey && (event.ctrlKey || event.metaKey),
          armed: event.pointerType !== "touch", moved: false, rect: null };
        if (drag.armed) { event.preventDefault(); page.svg.setPointerCapture(event.pointerId); }
        else marquee.timer = setTimeout(() => { if (marquee !== drag) return; drag.armed = true;
          page.svg.style.touchAction = "none"; page.svg.setPointerCapture(event.pointerId); drawMarquee(); }, 350);
      });
      page.svg.addEventListener("pointermove", event => {
        const drag = marquee; if (!drag || drag.pointer !== event.pointerId) return;
        drag.endX = event.clientX; drag.endY = event.clientY;
        if (Math.hypot(drag.endX - drag.x, drag.endY - drag.y) >= 4) {
          if (!drag.armed) { cancelMarquee(); return; } drag.moved = true;
        }
        if (drag.armed && drag.moved) { event.preventDefault(); drawMarquee(); }
      });
      page.svg.addEventListener("pointerup", event => {
        const drag = marquee; if (!drag || drag.pointer !== event.pointerId) return;
        drag.endX = event.clientX; drag.endY = event.clientY; cancelMarquee();
        if (!drag.armed || !drag.moved) { if (!drag.additive) app.clearStaffSelection(); return; }
        const left = Math.min(drag.x, drag.endX), right = Math.max(drag.x, drag.endX);
        const top = Math.min(drag.y, drag.endY), bottom = Math.max(drag.y, drag.endY);
        const refs: StaffNoteRef[] = Array.from(mounted.values()).flatMap(item => item.notes).filter(note => { const rect = note.hitElement.getBoundingClientRect();
          return rect.left <= right && rect.right >= left && rect.top <= bottom && rect.bottom >= top; }).map(note => note.ref);
        app.selectStaffPreviewNotes(refs, { additive: drag.additive, origin: "marquee" });
        suppressClick = true; event.preventDefault();
        setTimeout(() => { suppressClick = false; }, 0);
      });
      page.svg.addEventListener("touchmove", event => { if (marquee?.armed) event.preventDefault(); }, { passive: false });
      page.svg.addEventListener("pointercancel", () => cancelMarquee());
      page.svg.addEventListener("pointermove", event => {
        if (!current || !app.isStaffPreviewCurrent() || !app.getStaffEditorState().inputEnabled) return;
        if (event.target instanceof Element && event.target.closest("[data-staff-header]")) { clearInputOverlays("hover"); return; }
        const hit = pointAt(event);
        if (hit) drawInputPreview(page, hit.x, hit.y, hit.span, true);
        else clearInputOverlays("hover");
      });
      page.svg.addEventListener("pointerleave", () => clearInputOverlays("hover"));
      page.svg.addEventListener("click", event => {
        if (suppressClick) { suppressClick = false; event.preventDefault(); event.stopImmediatePropagation(); return; }
        if (app.interactionMode === "view") { event.stopImmediatePropagation(); return; }
        const header = event.target instanceof Element ? event.target.closest<SVGElement>("[data-staff-header]") : null;
        if (header && current) { event.preventDefault(); event.stopPropagation(); activate("staff"); if (app.inputModeEnabled) app.editStaffHeader(header.dataset.staffHeader as StaffHeaderField); return; }
        if (!current || !app.isStaffPreviewCurrent() || !app.getStaffEditorState().inputEnabled) return;
        const hit = pointAt(event); if (!hit) return;
        event.preventDefault(); event.stopImmediatePropagation(); activate("staff"); pane.focus({ preventScroll: true });
        const matrix = page.svg.getScreenCTM();
        const point = matrix ? new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()) : null;
        const ruler = point && Math.abs(point.y - hit.span.rulerY) <= hit.span.lineSpacing * 0.85;
        if (ruler) {
          const cursor = app.getStaffEditorState().cursor;
          const held = staffCursorPoint(hit.span, hit.position.offset, cursor?.focusPitch ?? null, cursor ?? undefined);
          hit.position = { ...hit.position, ...staffPitchAtY(hit.span, held.y, Fraction.fromString(hit.position.offset).toFloat()) };
        }
        app.setStaffInputCursor(hit.position, !!ruler);
        if (!ruler) {
          const exact = exactInputNote(hit);
          if (exact) app.selectStaffPreviewNote(exact.ref, { additive: event.ctrlKey || event.metaKey });
          else app.insertStaffInputNote(hit.position);
        }
        renderInputCursor();
      }, { capture: true });
      page.svg.addEventListener("contextmenu", event => {
        if (!app.inputModeEnabled) { event.preventDefault(); return; }
        if (!current || !app.isStaffPreviewCurrent()) return;
        const element = event.target instanceof Element ? event.target.closest<SVGElement>("[data-staff-ref]") : null;
        const note = element ? page.notes.find(item => item.ref.id === element.dataset.staffRef) : null;
        const hit = pointAt(event);
        const ref = app.getStaffEditorState().inputEnabled ? hit ? exactInputNote(hit)?.ref ?? null : null : note?.ref ?? null;
        if (!ref && !hit) return;
        event.preventDefault(); event.stopPropagation(); activate("staff"); pane.focus({ preventScroll: true });
        app.openStaffContextMenu(ref, event, hit?.position);
      });
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
    renderInputCursor();
    notify();
  };
  const setZoom = (value: number, fit = false): void => {
    fitToWidth = fit;
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
  document.addEventListener("workspace:manual-pan", event => {
    const element = (event as CustomEvent<{ element: HTMLElement }>).detail.element;
    if (element === pane) { activate("staff"); pause("staff"); }
    else if (element === app.scorePane) { activate("jianpu"); pause("jianpu"); }
  });
  const fitZoom = (): number => Math.max(0.2, Math.min(3, (pane.clientWidth - (isTouchWorkspace() ? 16 : 40)) / (prepared?.pageWidth ?? 800)));
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
    const tones = playing.notes ? new Set(playing.notes.map(note => snapshot?.registry.refFor(note)?.id)) : null;
    const sounding = Array.from(mounted.values()).flatMap(page => page.notes).find(note =>
      playing.chords?.includes(note.chord) && (!tones || tones.has(note.ref.id)));
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
    if (prepared?.revision === next.revision) {
      current = true; pane.setAttribute("aria-busy", "false"); status.textContent = prepared.diagnostics.join(" · ");
      mountVisible(); if (revealPending) revealEditorTarget(); drainInputMoves(); return;
    }
    abort?.abort(); const task = new AbortController(); abort = task;
    const anchor = captureAnchor();
    pane.setAttribute("aria-busy", "true");
    status.textContent = "正在生成五线谱…";
    try {
      const { prepareStaffPreview } = await import("./renderer");
      if (task.signal.aborted || !visible()) return;
      const result = await prepareStaffPreview(next, prepared ?? undefined, task.signal);
      if (task.signal.aborted || !visible() || !app.isStaffPreviewCurrent() || app.getStaffPreviewSnapshot().revision !== next.revision) { result.dispose(); return; }
      const old = prepared;
      if (old && (old.pageWidth !== result.pageWidth || old.pageHeight !== result.pageHeight)) fitToWidth = true;
      prepared = result; snapshot = next; current = true;
      pane.dataset.staffRevision = String(result.revision); pane.setAttribute("aria-busy", "false");
      if (!zoomInitialized || fitToWidth) { zoom = fitZoom(); zoomInitialized = true; }
      mounted.clear(); wraps.length = 0; pages.replaceChildren();
      for (let index = 0; index < result.pageCount; index++) { const wrap = document.createElement("div"); wrap.className = "staff-page"; wrap.dataset.page = String(index); wrap.style.width = `${result.pageWidth * zoom}px`; wrap.style.height = `${result.pageHeight * zoom}px`; wraps.push(wrap); pages.append(wrap); }
      if (old !== result) old?.dispose(); status.textContent = result.diagnostics.join(" · ");
      mountVisible(); restoreAnchor(anchor);
      if (revealPending) revealEditorTarget();
      drainInputMoves();
      if (selection.primary) scrollRef(); else if (playing.state === "playing") followPlayback();
    } catch (error) { if (!task.signal.aborted) { current = false; pane.setAttribute("aria-busy", "false"); status.textContent = `五线谱生成失败，保留上次预览：${error instanceof Error ? error.message : String(error)}`; } }
  };
  const schedule = (): void => { current = false; clearInputOverlays(); abort?.abort(); clearTimeout(refreshTimer); if (visible()) { pane.setAttribute("aria-busy", "true"); refreshTimer = setTimeout(() => void refresh(), 200); } };
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
      pendingInputMoves = [];
      abort?.abort(); abort = null; clearTimeout(refreshTimer); active = "jianpu"; current = false; follow = true;
      prepared?.dispose(); prepared = null; snapshot = null; mounted.clear(); wraps.length = 0; pages.replaceChildren(); currentPage = 0;
      delete pane.dataset.staffRevision; pane.setAttribute("aria-busy", "false");
      if (savedJianpuPosition) { app.scorePane.scrollTop = savedJianpuPosition.top; app.scorePane.scrollLeft = savedJianpuPosition.left; savedJianpuPosition = null; }
    }
    else { active = mode === "staff" ? "staff" : active; if (prepared && fitToWidth) setZoom(fitZoom(), true); void refresh(); }
    notify();
  };
  const availability = (): void => {
    const availability = app.getStaffPreviewAvailability();
    for (const option of Array.from(select.options)) if (option.value !== "jianpu") {
      const disabled = !availability.supported || (option.value === "compare" && narrow);
      if (option.disabled !== disabled) option.disabled = disabled;
    }
    const message = availability.supported ? (narrow ? "窄窗口使用单谱视图" : "五线谱可编辑 · N 打谱") : availability.reason;
    if (reason.textContent !== message) reason.textContent = message;
    if (select.title !== availability.reason) select.title = availability.reason;
    if (!availability.supported && mode !== "jianpu") { setMode("jianpu", false); prepared?.dispose(); prepared = null; snapshot = null; pages.replaceChildren(); mounted.clear(); wraps.length = 0; }
  };
  const inputSpanFor = (partIndex: number, measureIndex: number): StaffInputSpan | null => {
    for (const page of mounted.values()) {
      const span = page.inputSpans.find(item => item.partIndex === partIndex && item.measureIndex === measureIndex);
      if (span) return span;
    }
    if (!prepared || !snapshot) return null;
    const measure = snapshot.score.parts[partIndex]?.measures[measureIndex];
    const chords = measure?.entries.filter((entry): entry is Chord => entry instanceof Chord) ?? [];
    const indexes = prepared.pagesForChords(chords);
    const fallback = prepared.pageForMeasure?.(partIndex, measureIndex);
    if (fallback !== null && fallback !== undefined && !indexes.includes(fallback)) indexes.push(fallback);
    for (const index of indexes) {
      if (!mounted.has(index)) { pane.scrollTop = wraps[index]?.offsetTop ?? pane.scrollTop; mountVisible(); }
      const span = mounted.get(index)?.inputSpans.find(item => item.partIndex === partIndex && item.measureIndex === measureIndex);
      if (span) return span;
    }
    return null;
  };
  const drainInputMoves = (): void => {
    const queued = pendingInputMoves; pendingInputMoves = [];
    for (const direction of queued) navigation.moveInputCursor?.(direction);
  };
  const pageAtTouch = (point: TouchPoint): StaffRenderedPage | null => {
    for (const page of mounted.values()) {
      const rect = page.svg.getBoundingClientRect();
      if (point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom) return page;
    }
    return null;
  };
  const touchCandidates = (point: TouchPoint): ScoreTouchCandidate[] => {
    if (!current || !prepared || !snapshot || !app.isStaffPreviewCurrent()) return [];
    const candidates: ScoreTouchCandidate[] = [];
    const exact = new Set<string>();
    const seen = new Set<string>();
    for (const page of mounted.values()) for (const rendered of page.notes) {
      if (seen.has(rendered.ref.id)) continue;
      const rect = rendered.hitElement.getBoundingClientRect();
      const distance = Math.hypot(Math.max(rect.left - point.x, 0, point.x - rect.right),
        Math.max(rect.top - point.y, 0, point.y - rect.bottom));
      if (distance > 22) continue;
      const target = snapshot.registry.resolve(rendered.ref);
      if (!target) continue;
      const matrix = (rendered.hitElement as SVGGraphicsElement).getScreenCTM();
      if (matrix && rendered.hitElement.hasAttribute("data-staff-ink-x")) {
        const local = new DOMPoint(point.x, point.y).matrixTransform(matrix.inverse());
        const x = Number(rendered.hitElement.getAttribute("data-staff-ink-x"));
        const y = Number(rendered.hitElement.getAttribute("data-staff-ink-y"));
        const width = Number(rendered.hitElement.getAttribute("data-staff-ink-width"));
        const height = Number(rendered.hitElement.getAttribute("data-staff-ink-height"));
        if (local.x >= x && local.x <= x + width && local.y >= y && local.y <= y + height) exact.add(rendered.ref.id);
      }
      seen.add(rendered.ref.id);
      const span = page.inputSpans.find(span => span.partIndex === target.partIndex && span.measureIndex === target.measureIndex);
      const fifths = span ? [...span.keyChanges].reverse().find(mark => mark.tick <= target.note.chord.position.toFloat() + 1e-8)?.fifths ?? span.fifths : 0;
      const pitch = target.note.rest ? "休止" : (() => { const value = spellPitch(target.note, fifths); return `${value.step}${value.octave}`; })();
      candidates.push({ kind: "note", ref: rendered.ref, partIndex: target.partIndex,
        measureIndex: target.measureIndex, offset: target.note.chord.position.toString(), distance,
        label: `${app.getPartLabel(target.partIndex)} · 第${target.measureIndex + 1}小节 · ${pitch}` });
    }
    if (exact.size === 1) return candidates.filter(candidate => exact.has(candidate.ref.id));
    return candidates.sort((a, b) => a.distance - b.distance || a.partIndex - b.partIndex);
  };
  const touchTap = (point: TouchPoint, selectionMode: ScoreSelectionMode, candidate?: ScoreTouchCandidate): void => {
    if (!current || !app.isStaffPreviewCurrent() || app.interactionMode === "view") return;
    activate("staff"); pane.focus({ preventScroll: true });
    const target = candidate ?? touchCandidates(point)[0];
    if (target) {
      void app.executeScoreCommand({ type: "select-notes", refs: [target.ref],
        additive: selectionMode === "multiple", range: selectionMode === "range" });
      return;
    }
    const page = pageAtTouch(point), matrix = page?.svg.getScreenCTM();
    if (!page || !matrix) return;
    const local = new DOMPoint(point.x, point.y).matrixTransform(matrix.inverse());
    const hit = staffInputAtPoint(page.inputSpans, local.x, local.y);
    if (hit && app.inputModeEnabled) void app.executeScoreCommand({ type: "set-position", position: hit.position });
    else if (selectionMode === "single") void app.executeScoreCommand({ type: "clear-selection" });
    renderInputCursor();
  };
  registerTouchScoreSurface("staff", {
    activate: () => { activate("staff"); pane.focus({ preventScroll: true }); },
    zoom: () => zoom,
    setZoom: value => setZoom(value),
    pageAt: point => {
      let best: HTMLElement | null = null, distance = Infinity;
      for (const wrap of wraps) {
        const rect = wrap.getBoundingClientRect();
        const delta = point.y < rect.top ? rect.top - point.y : point.y > rect.bottom ? point.y - rect.bottom : 0;
        if (delta < distance) { distance = delta; best = wrap; }
      }
      return best;
    },
    candidates: touchCandidates,
    tap: touchTap,
    marquee: (rect, additive) => {
      if (!current || !app.isStaffPreviewCurrent() || app.interactionMode === "view") return;
      const refs = [...mounted.values()].flatMap(page => page.notes).filter(note => {
        const bounds = note.hitElement.getBoundingClientRect();
        return bounds.left <= rect.right && bounds.right >= rect.left && bounds.top <= rect.bottom && bounds.bottom >= rect.top;
      }).map(note => note.ref);
      void app.executeScoreCommand({ type: "select-notes", refs, additive });
    },
    context: point => {
      const header = document.elementFromPoint(point.x, point.y)?.closest<SVGElement>("[data-staff-header]");
      if (header && app.inputModeEnabled) { app.editStaffHeader(header.dataset.staffHeader as StaffHeaderField); return; }
      touchTap(point, app.getScoreEditorState().selectionMode);
      document.dispatchEvent(new CustomEvent("workspace:touch-actions", { detail: { surface: "staff", point } }));
    },
  });
  const revealEditorTarget = (): void => {
    if (!visible()) return;
    if (!current || !prepared || !snapshot || !app.isStaffPreviewCurrent()) { revealPending = true; return; }
    revealPending = false;
    const cursor = app.getStaffEditorState().cursor;
    const primary = selection.primary ? snapshot.registry.refFor(selection.primary) : null;
    const index = cursor ? prepared.pageForMeasure?.(cursor.partIndex, cursor.measureIndex) ?? null
      : primary ? prepared.pageForRef(primary) : null;
    if (index !== null && !mounted.has(index)) {
      pane.scrollTop = wraps[index]?.offsetTop ?? pane.scrollTop;
      mountVisible();
    }
    renderInputCursor();
    const target = cursor ? pane.querySelector<SVGElement>('[data-staff-input-overlay="cursor"]')
      : primary ? [...mounted.values()].flatMap(page => page.notes).find(note => note.ref.id === primary.id)?.hitElement : null;
    if (!target) return;
    const viewport = pane.getBoundingClientRect(), rect = target.getBoundingClientRect();
    const margin = Math.min(20, viewport.height * 0.08);
    if (rect.top < viewport.top + margin) pane.scrollTop += rect.top - viewport.top - margin;
    else if (rect.bottom > viewport.bottom - margin) pane.scrollTop += rect.bottom - viewport.bottom + margin;
    if (rect.left < viewport.left + margin) pane.scrollLeft += rect.left - viewport.left - margin;
    else if (rect.right > viewport.right - margin) pane.scrollLeft += rect.right - viewport.right + margin;
    mountVisible();
  };
  const navigation: StaffPreviewNavigation = {
    get activeSurface() { return active; }, get staffVisible() { return visible(); },
    getPageSummary: () => ({ page: currentPage + 1, pages: prepared?.pageCount ?? 0, zoom }),
    goToPage: index => { pause("staff"); const target = Math.max(0, Math.min(index, wraps.length - 1)); wraps[target]?.scrollIntoView({ block: "start" }); mountVisible(); },
    zoomBy: factor => setZoom(zoom * factor), resetZoom: () => setZoom(fitZoom(), true),
    revealEditorTarget,
    moveInputCursor: direction => {
      const state = app.getStaffEditorState();
      if (!visible() || !state.inputEnabled || !state.cursor || !app.isStaffPreviewCurrent()) return false;
      // A just-edited source awaits its asynchronous renderer. Consume arrows
      // without falling back to a conflicting uniform binary step.
      if (!current || prepared?.revision !== app.getStaffPreviewSnapshot().revision) {
        if (pendingInputMoves.length < 64) pendingInputMoves.push(direction);
        return true;
      }
      const cursor = state.cursor;
      let span = inputSpanFor(cursor.partIndex, cursor.measureIndex);
      if (!span) return true;
      let anchor = staffNextInputAnchor(span, cursor.offset, direction);
      if (!anchor) {
        const measureIndex = cursor.measureIndex + direction;
        if (measureIndex < 0 || measureIndex >= (snapshot?.score.parts[cursor.partIndex]?.measures.length ?? 0)) return true;
        span = inputSpanFor(cursor.partIndex, measureIndex);
        if (!span) return true;
        const anchors = staffSnapAnchors(span);
        anchor = direction > 0 ? anchors[0] ?? null : anchors[anchors.length - 1] ?? null;
        if (!anchor) return true;
      }
      const offset = new Fraction(Math.round(anchor.tick * 192), 192).toString();
      const point = staffCursorPoint(span, offset, cursor.focusPitch, cursor);
      app.setStaffInputCursor({ partIndex: span.partIndex, measureIndex: span.measureIndex, offset,
        gridDivision: span.division, ...staffPitchAtY(span, point.y, anchor.tick) }, false);
      renderInputCursor();
      pane.querySelector<SVGElement>('[data-staff-input-overlay="cursor"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
      return true;
    },
    getExportPages: async (options) => {
      if (!app.isStaffPreviewCurrent()) throw new Error("五线谱正在更新，请稍后导出。");
      const source = app.getStaffPreviewSnapshot();
      const reusable = current && prepared?.revision === source.revision ? prepared : null;
      const document = reusable ?? await (await import("./renderer")).prepareStaffPreview(source);
      try {
        if (!source.current) throw new Error("乐谱已更新，请重新导出。");
        const exported = [];
        for (let page = 0; page < document.pageCount; page++) {
          const svg = document.renderPage(page).svg;
          svg.querySelectorAll(options?.includeRhythmGuides ? "[data-staff-input-overlay]" : ".staff-rhythm-guide, [data-staff-input-overlay]").forEach(element => element.remove());
          exported.push({ page, svg });
        }
        return { currentPage: Math.min(currentPage, Math.max(0, document.pageCount - 1)), pages: exported };
      } finally { if (document !== reusable) document.dispose(); }
    },
  };
  app.setStaffPreviewNavigation(navigation);
  select.addEventListener("change", () => {
    const chosen = select.value as StaffViewMode;
    setMode(chosen);
  });
  document.addEventListener("workspace:score-view", event => {
    const requested = (event as CustomEvent<StaffViewMode>).detail;
    if (requested === "jianpu" || requested === "staff" || requested === "compare") setMode(requested);
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
    if (event.isComposing || event.getModifierState("AltGraph")) return;
    event.stopPropagation();
    // Keyboard edits use the current authoritative model; the SVG may still
    // be regenerating after the previous keystroke. Old pointer refs stay blocked.
    if (app.isStaffPreviewCurrent() && app.handleStaffKeyDown(event)) { event.preventDefault(); renderInputCursor(); return; }
    const mapped = remapShortcutEvent(event, "global");
    if (mapped?.key === "PageDown") { event.preventDefault(); navigation.goToPage(currentPage + 1); }
    else if (mapped?.key === "PageUp") { event.preventDefault(); navigation.goToPage(currentPage - 1); }
    else if (mapped && (mapped.ctrlKey || mapped.metaKey) && mapped.key === "Home") { event.preventDefault(); navigation.goToPage(0); }
    else if (mapped && (mapped.ctrlKey || mapped.metaKey) && mapped.key === "End") { event.preventDefault(); navigation.goToPage(1e9); }
    else if (mapped && (mapped.ctrlKey || mapped.metaKey) && ["+", "=", "-", "0"].includes(mapped.key)) { event.preventDefault(); mapped.key === "0" ? navigation.resetZoom() : navigation.zoomBy(mapped.key === "-" ? 1 / 1.2 : 1.2); }
    else if (["Delete", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "n", "N", " "].includes(event.key) || /^[0-7]$/.test(event.key)) event.preventDefault();
  }, { capture: true });
  resume.addEventListener("click", () => { if (active === "staff") { follow = true; followPlayback(); } else app.resumeJianpuPlaybackFollow(); notify(); });
  const followPlayback = (): void => {
    if (!follow || !visible() || !prepared || playing.revision !== prepared.revision || !playing.chords?.length) return;
    const index = prepared.pagesForChords(playing.chords)[0]; if (index === undefined) return;
    if (!mounted.has(index)) { pane.scrollTop = wraps[index]?.offsetTop ?? pane.scrollTop; mountVisible(); }
    const tones = playing.notes ? new Set(playing.notes.map(note => snapshot?.registry.refFor(note)?.id)) : null;
    const element = mounted.get(index)?.notes.find(note => !!playing.chords?.includes(note.chord)
      && (!tones || tones.has(note.ref.id)))?.hitElement;
    if (!element) return;
    scrollPlaybackTarget(pane, element);
  };
  document.addEventListener("staff:model-change", () => { availability(); schedule(); });
  document.addEventListener("editor:document-replaced", () => {
    cancelMarquee();
    // A new file must not inherit the previous file's viewport anchor or maps.
    abort?.abort(); abort = null; clearTimeout(refreshTimer);
    prepared?.dispose(); prepared = null; snapshot = null; current = false;
    mounted.clear(); wraps.length = 0; pages.replaceChildren(); currentPage = 0;
    savedAnchor = null; savedJianpuPosition = null; pane.scrollTop = 0;
    pendingInputMoves = [];
    delete pane.dataset.staffRevision; pane.setAttribute("aria-busy", "false");
    selection = app.getStaffSelectionState(); playing = app.getStaffPlaybackState();
    availability(); schedule(); notify();
  });
  document.addEventListener("staff:stale", () => { current = false; clearInputOverlays(); abort?.abort(); if (visible()) pane.setAttribute("aria-busy", "true"); status.textContent = "文本正在更新，预览暂不可选择"; availability(); });
  document.addEventListener("staff:selection-change", event => { selection = (event as CustomEvent<StaffSelectionState>).detail; mark(); renderInputCursor(); if (selection.origin !== "staff") scrollRef(); });
  document.addEventListener("staff:playback-change", event => { const next = (event as CustomEvent<StaffPlaybackState>).detail; if (next.state === "playing" && playing.state !== "playing") { follow = true; delete app.scorePane.dataset.staffFollow; } playing = next; mark(); followPlayback(); notify(); });
  document.addEventListener("editor:workspace-change", () => { if (app.interactionMode === "view") cancelMarquee(); availability(); renderInputCursor(); });
  const dividerLimits = (): [number, number] => {
    const minimum = isTouchWorkspace() ? Math.max(25, Math.min(50, 424 / Math.max(1, content.clientWidth) * 100)) : 25;
    return [minimum, 100 - minimum];
  };
  const resize = (): void => {
    const next = content.clientWidth < (isTouchWorkspace() ? 848 : 760);
    if (next !== narrow) { narrow = next; availability(); if (mode !== "jianpu") setMode(preference, false); else notify(); }
    if (!narrow) {
      const [minimum, maximum] = dividerLimits();
      const ratio = parseFloat(root.style.getPropertyValue("--staff-jianpu-ratio")) || 50;
      root.style.setProperty("--staff-jianpu-ratio", `${Math.max(minimum, Math.min(maximum, ratio))}%`);
    }
    if (prepared && fitToWidth) setZoom(fitZoom(), true); else mountVisible();
  };
  new ResizeObserver(resize).observe(content);
  document.addEventListener("workspace:mode-change", resize);
  let drag = false;
  divider.addEventListener("pointerdown", event => { drag = true; divider.setPointerCapture(event.pointerId); });
  divider.addEventListener("pointermove", event => { if (!drag) return; const bounds = content.getBoundingClientRect(); const [minimum, maximum] = dividerLimits(); root.style.setProperty("--staff-jianpu-ratio", `${Math.max(minimum, Math.min(maximum, (event.clientX - bounds.left) / bounds.width * 100))}%`); });
  const saveDivider = (): void => { try { localStorage.setItem("staff-preview-divider", String(parseFloat(root.style.getPropertyValue("--staff-jianpu-ratio")) || 50)); } catch { /* storage is optional */ } };
  divider.addEventListener("pointerup", () => { drag = false; saveDivider(); }); divider.addEventListener("pointercancel", () => { drag = false; saveDivider(); });
  divider.addEventListener("keydown", event => { if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return; event.preventDefault(); const ratio = parseFloat(root.style.getPropertyValue("--staff-jianpu-ratio")) || 50; const [minimum, maximum] = dividerLimits(); root.style.setProperty("--staff-jianpu-ratio", `${Math.max(minimum, Math.min(maximum, ratio + (event.key === "ArrowLeft" ? -5 : 5)))}%`); saveDivider(); });
  availability(); notify(); resize();
}
