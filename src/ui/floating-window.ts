/** Viewport-bound placement and pointer/keyboard gestures for an inspector window. */
interface Placement {
  left: number;
  top: number;
  width: number;
  height: number;
}

type Gesture = "move" | "resize";

const MARGIN = 14;
const MIN_WIDTH = 380;
const MIN_HEIGHT = 280;
const DEFAULT_WIDTH = 600;
const DEFAULT_HEIGHT = 760;

export interface FloatingWindowOptions {
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  centered?: boolean;
  persist?: boolean;
}

function storageKey(id: string): string {
  return `jpeditor:inspector-window:${id}:v1`;
}

function topBoundary(): number {
  const toolbarBottom = document.getElementById("toolbar")?.getBoundingClientRect().bottom ?? 0;
  // When the viewport is exceptionally short, leave room for the title controls.
  return Math.max(0, Math.min(Math.max(MARGIN, toolbarBottom + 10), bottomBoundary() - 64));
}

function bottomBoundary(): number {
  const statusTop = document.getElementById("statusbar")?.getBoundingClientRect().top;
  const workspaceBottom = document.getElementById("body")?.getBoundingClientRect().bottom;
  return Math.min(window.innerHeight, statusTop ?? window.innerHeight, workspaceBottom ?? window.innerHeight);
}

function limits(): { minTop: number; maxWidth: number; maxHeight: number } {
  const minTop = topBoundary();
  return {
    minTop,
    maxWidth: Math.max(1, window.innerWidth - MARGIN * 2),
    maxHeight: Math.max(1, bottomBoundary() - minTop - MARGIN),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function fit(placement: Placement, options: FloatingWindowOptions): Placement {
  const bounds = limits();
  const width = clamp(placement.width, Math.min(options.minWidth ?? MIN_WIDTH, bounds.maxWidth), bounds.maxWidth);
  const height = clamp(placement.height, Math.min(options.minHeight ?? MIN_HEIGHT, bounds.maxHeight), bounds.maxHeight);
  return {
    left: clamp(placement.left, MARGIN, Math.max(MARGIN, window.innerWidth - width - MARGIN)),
    top: clamp(placement.top, bounds.minTop, Math.max(bounds.minTop, bottomBoundary() - height - MARGIN)),
    width,
    height,
  };
}

function defaultPlacement(options: FloatingWindowOptions): Placement {
  const bounds = limits();
  const width = Math.min(options.width ?? DEFAULT_WIDTH, bounds.maxWidth);
  const height = Math.min(options.height ?? DEFAULT_HEIGHT, bounds.maxHeight);
  return fit({
    left: options.centered ? (window.innerWidth - width) / 2 : window.innerWidth - width - MARGIN,
    top: options.centered ? bounds.minTop + (bounds.maxHeight - height) / 2 : bounds.minTop,
    width,
    height,
  }, options);
}

function resizeFrom(start: Placement, width: number, height: number, options: FloatingWindowOptions): Placement {
  const maxWidth = Math.max(1, window.innerWidth - start.left - MARGIN);
  const maxHeight = Math.max(1, bottomBoundary() - start.top - MARGIN);
  return {
    ...start,
    width: clamp(width, Math.min(options.minWidth ?? MIN_WIDTH, maxWidth), maxWidth),
    height: clamp(height, Math.min(options.minHeight ?? MIN_HEIGHT, maxHeight), maxHeight),
  };
}

function readPlacement(id: string): Placement | null {
  try {
    const raw = localStorage.getItem(storageKey(id));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const candidate = value as Partial<Placement>;
    if (![candidate.left, candidate.top, candidate.width, candidate.height]
      .every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))) return null;
    return candidate as Placement;
  } catch {
    return null;
  }
}

function savePlacement(id: string, placement: Placement): void {
  try {
    localStorage.setItem(storageKey(id), JSON.stringify(placement));
  } catch {
    // Storage can be unavailable in private or restricted webviews.
  }
}

function removePlacement(id: string): void {
  try {
    localStorage.removeItem(storageKey(id));
  } catch {
    // The reset still takes effect for the current window.
  }
}

export class FloatingWindow {
  private placement: Placement;
  private gesture: { kind: Gesture; pointerId: number; x: number; y: number; start: Placement } | null = null;
  private keyboardResized = false;
  private resizeObserver: ResizeObserver | null = null;

  constructor(
    private readonly pane: HTMLElement,
    private readonly id: string,
    private readonly header: HTMLElement,
    private readonly grip: HTMLButtonElement,
    private readonly resetButton: HTMLButtonElement,
    private readonly options: FloatingWindowOptions = {},
  ) {
    this.placement = fit((options.persist === false ? null : readPlacement(id)) ?? defaultPlacement(options), options);
    this.render();
    header.addEventListener("pointerdown", this.onHeaderPointerDown);
    grip.addEventListener("pointerdown", this.onGripPointerDown);
    grip.addEventListener("keydown", this.onGripKeyDown);
    grip.addEventListener("keyup", this.onGripKeyUp);
    grip.addEventListener("blur", this.onGripBlur);
    resetButton.addEventListener("click", this.reset);
    window.addEventListener("resize", this.onViewportChange);
    window.visualViewport?.addEventListener("resize", this.onViewportChange);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.onViewportChange);
      for (const id of ["body", "toolbar", "statusbar"]) {
        const element = document.getElementById(id);
        if (element) this.resizeObserver.observe(element);
      }
    }
  }

  destroy(): void {
    this.cancelGesture();
    this.header.removeEventListener("pointerdown", this.onHeaderPointerDown);
    this.grip.removeEventListener("pointerdown", this.onGripPointerDown);
    this.grip.removeEventListener("keydown", this.onGripKeyDown);
    this.grip.removeEventListener("keyup", this.onGripKeyUp);
    this.grip.removeEventListener("blur", this.onGripBlur);
    this.resetButton.removeEventListener("click", this.reset);
    window.removeEventListener("resize", this.onViewportChange);
    window.visualViewport?.removeEventListener("resize", this.onViewportChange);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  private render(): void {
    this.pane.style.left = `${this.placement.left}px`;
    this.pane.style.top = `${this.placement.top}px`;
    this.pane.style.width = `${this.placement.width}px`;
    this.pane.style.height = `${this.placement.height}px`;
  }

  private readonly onViewportChange = (): void => {
    this.placement = fit(this.placement, this.options);
    this.render();
  };

  private readonly reset = (): void => {
    this.cancelGesture();
    this.placement = defaultPlacement(this.options);
    this.render();
    if (this.options.persist !== false) removePlacement(this.id);
  };

  private readonly onHeaderPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button, input, select, textarea, a, [contenteditable]"))) return;
    this.beginGesture("move", this.header, event);
  };

  private readonly onGripPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    this.beginGesture("resize", this.grip, event);
  };

  private beginGesture(kind: Gesture, target: HTMLElement, event: PointerEvent): void {
    this.cancelGesture();
    (kind === "move" ? this.pane : this.grip).focus({ preventScroll: true });
    this.gesture = {
      kind,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      start: { ...this.placement },
    };
    target.setPointerCapture(event.pointerId);
    target.addEventListener("pointermove", this.onPointerMove);
    target.addEventListener("pointerup", this.onPointerEnd);
    target.addEventListener("pointercancel", this.onPointerEnd);
    target.addEventListener("lostpointercapture", this.onPointerEnd);
    this.pane.classList.add("inspector-moving");
  }

  private cancelGesture(): void {
    const gesture = this.gesture;
    this.gesture = null;
    if (!gesture) {
      this.pane.classList.remove("inspector-moving");
      return;
    }
    const target = gesture.kind === "move" ? this.header : this.grip;
    target.removeEventListener("pointermove", this.onPointerMove);
    target.removeEventListener("pointerup", this.onPointerEnd);
    target.removeEventListener("pointercancel", this.onPointerEnd);
    target.removeEventListener("lostpointercapture", this.onPointerEnd);
    if (target.hasPointerCapture(gesture.pointerId)) target.releasePointerCapture(gesture.pointerId);
    this.pane.classList.remove("inspector-moving");
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    this.placement = gesture.kind === "move"
      ? fit({ ...gesture.start, left: gesture.start.left + dx, top: gesture.start.top + dy }, this.options)
      : resizeFrom(gesture.start, gesture.start.width + dx, gesture.start.height + dy, this.options);
    this.render();
  };

  private readonly onPointerEnd = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    this.cancelGesture();
    this.save();
  };

  private readonly onGripKeyDown = (event: KeyboardEvent): void => {
    const step = event.shiftKey ? 24 : 10;
    let width = this.placement.width;
    let height = this.placement.height;
    switch (event.key) {
      case "ArrowLeft": width -= step; break;
      case "ArrowRight": width += step; break;
      case "ArrowUp": height -= step; break;
      case "ArrowDown": height += step; break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.placement = resizeFrom(this.placement, width, height, this.options);
    this.render();
    this.keyboardResized = true;
  };

  private readonly onGripKeyUp = (event: KeyboardEvent): void => {
    if (!this.keyboardResized || !event.key.startsWith("Arrow")) return;
    this.keyboardResized = false;
    this.save();
  };

  private readonly onGripBlur = (): void => {
    if (!this.keyboardResized) return;
    this.keyboardResized = false;
    this.save();
  };

  private save(): void {
    if (this.options.persist !== false) savePlacement(this.id, this.placement);
  }
}
