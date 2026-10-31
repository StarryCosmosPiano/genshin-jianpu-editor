import { TouchGestureState, TOUCH_HOLD_MS, type TouchPoint, type TouchRect, type TouchTool } from "./touch-gesture-state";
import type { TouchScoreSurface } from "./touch-score-bridge";

export interface TouchGestureOptions {
  enabled(): boolean;
  interactionMode(): string;
  surface(): TouchScoreSurface | undefined;
  tool(): TouchTool;
  tap(point: TouchPoint): void;
  context(point: TouchPoint): void;
  marquee(rect: TouchRect): void;
}

/** Own touch gestures only inside the score viewport. Mouse, text and forms
 * retain their existing browser behavior. Page viewBoxes never change. */
export function wireTouchGestures(container: HTMLElement, options: TouchGestureOptions): () => void {
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let animation = 0;
  let velocityX = 0, velocityY = 0, lastMoveTime = 0, lastFrameTime = 0;
  let lastTouchAt = -Infinity;
  let baseZoom = 1;
  let anchor: { page: HTMLElement; x: number; y: number } | null = null;
  let overlay: HTMLDivElement | null = null;
  let zoomFrame = 0;
  let pendingPinch: { scale: number; center: TouchPoint } | null = null;
  let penPointer: number | null = null;
  let interactionMode = options.interactionMode();

  const stopMomentum = (): void => {
    cancelAnimationFrame(animation); animation = 0;
    velocityX = velocityY = 0;
  };
  const showMarquee = (rect: TouchRect | null): void => {
    if (!rect) { overlay?.remove(); overlay = null; return; }
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "touch-score-marquee";
      overlay.setAttribute("aria-hidden", "true");
      document.body.append(overlay);
    }
    Object.assign(overlay.style, { left: `${rect.left}px`, top: `${rect.top}px`,
      width: `${rect.right - rect.left}px`, height: `${rect.bottom - rect.top}px` });
  };
  const flushPinch = (): void => {
    zoomFrame = 0;
    const update = pendingPinch; pendingPinch = null;
    const surface = options.surface();
    if (!update || !surface) return;
    surface.setZoom(baseZoom * update.scale);
    if (anchor?.page.isConnected) {
      const rect = anchor.page.getBoundingClientRect();
      container.scrollLeft += rect.left + anchor.x * rect.width - update.center.x;
      container.scrollTop += rect.top + anchor.y * rect.height - update.center.y;
    }
  };
  const machine = new TouchGestureState({
    tap: options.tap,
    context: options.context,
    pan(dx, dy) {
      const now = performance.now();
      const elapsed = Math.max(8, Math.min(40, now - lastMoveTime));
      const beforeX = container.scrollLeft, beforeY = container.scrollTop;
      container.scrollLeft -= dx;
      container.scrollTop -= dy;
      velocityX = velocityX * 0.35 + (container.scrollLeft - beforeX) / elapsed * 0.65;
      velocityY = velocityY * 0.35 + (container.scrollTop - beforeY) / elapsed * 0.65;
      lastMoveTime = now;
      document.dispatchEvent(new CustomEvent("workspace:manual-pan", { detail: { element: container } }));
    },
    pinchStart(center) {
      stopMomentum();
      flushPinch();
      const surface = options.surface();
      baseZoom = surface?.zoom() ?? 1;
      const page = surface?.pageAt(center);
      const rect = page?.getBoundingClientRect();
      anchor = page && rect?.width && rect.height ? { page, x: (center.x - rect.left) / rect.width, y: (center.y - rect.top) / rect.height } : null;
      document.dispatchEvent(new CustomEvent("workspace:manual-pan", { detail: { element: container } }));
    },
    pinch(scale, center) {
      pendingPinch = { scale, center };
      if (!zoomFrame) zoomFrame = requestAnimationFrame(flushPinch);
    },
    marquee(rect, committed) {
      showMarquee(rect);
      if (committed && rect) options.marquee(rect);
    },
    phase(phase) {
      container.dataset.touchGesture = phase;
      if (phase !== "pending") clearTimeout(holdTimer);
    },
  });
  const momentumFrame = (time: number): void => {
    const dt = Math.min(32, time - lastFrameTime); lastFrameTime = time;
    const oldX = container.scrollLeft, oldY = container.scrollTop;
    container.scrollLeft += velocityX * dt; container.scrollTop += velocityY * dt;
    if (Math.abs(container.scrollLeft - oldX) < 0.1) velocityX = 0;
    if (Math.abs(container.scrollTop - oldY) < 0.1) velocityY = 0;
    const damping = Math.pow(0.9, dt / 16);
    velocityX *= damping; velocityY *= damping;
    if (Math.hypot(velocityX, velocityY) > 0.025 && options.enabled()) animation = requestAnimationFrame(momentumFrame);
    else stopMomentum();
  };
  const cancel = (): void => {
    clearTimeout(holdTimer); stopMomentum();
    cancelAnimationFrame(zoomFrame); zoomFrame = 0; pendingPinch = null; anchor = null;
    const ids = [...machine.pointers.keys()]; machine.cancel();
    penPointer = null;
    for (const id of ids) if (container.hasPointerCapture(id)) container.releasePointerCapture(id);
  };
  const down = (event: PointerEvent): void => {
    if (!options.enabled() || !["touch", "pen"].includes(event.pointerType)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.pointerType === "touch" && penPointer !== null) return;
    if (event.pointerType === "pen") {
      if (machine.pointers.size) cancel();
      penPointer = event.pointerId;
    }
    stopMomentum(); lastMoveTime = performance.now(); lastTouchAt = lastMoveTime;
    options.surface()?.activate();
    container.setPointerCapture(event.pointerId);
    machine.down(event.pointerId, { x: event.clientX, y: event.clientY }, lastMoveTime, options.tool());
    clearTimeout(holdTimer);
    if (machine.phase === "pending") holdTimer = setTimeout(() => machine.hold(performance.now()), TOUCH_HOLD_MS + 8);
  };
  const move = (event: PointerEvent): void => {
    if (penPointer !== null && event.pointerType === "touch") { event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (!machine.pointers.has(event.pointerId)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    lastTouchAt = performance.now();
    machine.move(event.pointerId, { x: event.clientX, y: event.clientY });
  };
  const up = (event: PointerEvent): void => {
    if (!machine.pointers.has(event.pointerId)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    lastTouchAt = performance.now();
    const wasPan = machine.phase === "pan";
    flushPinch();
    machine.up(event.pointerId, { x: event.clientX, y: event.clientY }, lastTouchAt);
    if (penPointer === event.pointerId) penPointer = null;
    if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
    if (machine.phase === "idle" && wasPan && lastTouchAt - lastMoveTime < 70
      && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      lastFrameTime = performance.now(); animation = requestAnimationFrame(momentumFrame);
    }
  };
  const canceled = (event: PointerEvent): void => {
    if (machine.pointers.has(event.pointerId)) { event.stopImmediatePropagation(); cancel(); }
  };
  const suppressCompatibilityClick = (event: MouseEvent): void => {
    if (!options.enabled()) return;
    if (["touch", "pen"].includes((event as PointerEvent).pointerType) || performance.now() - lastTouchAt < 800) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  };
  const contextMenu = (event: MouseEvent): void => {
    if (options.enabled() && performance.now() - lastTouchAt < 1200) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  const onModeChange = (): void => { cancel(); };
  const onWorkspaceChange = (): void => {
    const next = options.interactionMode();
    if (next !== interactionMode) { interactionMode = next; cancel(); }
  };
  const onWheel = (): void => { stopMomentum(); };
  const capture = { capture: true };
  container.addEventListener("pointerdown", down, capture);
  container.addEventListener("pointermove", move, capture);
  container.addEventListener("pointerup", up, capture);
  container.addEventListener("pointercancel", canceled, capture);
  container.addEventListener("lostpointercapture", canceled, capture);
  container.addEventListener("click", suppressCompatibilityClick, capture);
  container.addEventListener("dblclick", suppressCompatibilityClick, capture);
  container.addEventListener("contextmenu", contextMenu, capture);
  container.addEventListener("wheel", onWheel, { passive: true });
  document.addEventListener("workspace:mode-change", onModeChange);
  document.addEventListener("editor:workspace-change", onWorkspaceChange);
  document.addEventListener("editor:document-replaced", cancel);
  window.addEventListener("blur", cancel);
  return () => {
    cancel();
    container.removeEventListener("pointerdown", down, capture);
    container.removeEventListener("pointermove", move, capture);
    container.removeEventListener("pointerup", up, capture);
    container.removeEventListener("pointercancel", canceled, capture);
    container.removeEventListener("lostpointercapture", canceled, capture);
    container.removeEventListener("click", suppressCompatibilityClick, capture);
    container.removeEventListener("dblclick", suppressCompatibilityClick, capture);
    container.removeEventListener("contextmenu", contextMenu, capture);
    container.removeEventListener("wheel", onWheel);
    document.removeEventListener("workspace:mode-change", onModeChange);
    document.removeEventListener("editor:workspace-change", onWorkspaceChange);
    document.removeEventListener("editor:document-replaced", cancel);
    window.removeEventListener("blur", cancel);
  };
}
