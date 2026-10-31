/** Pure pointer arbitration. No score mutation, DOM geometry or browser timers. */
export interface TouchPoint { x: number; y: number }
export interface TouchRect { left: number; top: number; right: number; bottom: number }
export type TouchTool = "pan" | "marquee";
export type TouchPhase = "idle" | "pending" | "pan" | "pinch" | "marquee" | "context";
export interface TouchGestureHooks {
  tap(point: TouchPoint): void;
  context(point: TouchPoint): void;
  pan(dx: number, dy: number): void;
  pinchStart(center: TouchPoint): void;
  pinch(scale: number, center: TouchPoint): void;
  marquee(rect: TouchRect | null, committed: boolean): void;
  phase?(phase: TouchPhase): void;
}

export const TOUCH_SLOP = 9;
export const TOUCH_HOLD_MS = 480;

function center(a: TouchPoint, b: TouchPoint): TouchPoint { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
function distance(a: TouchPoint, b: TouchPoint): number { return Math.hypot(a.x - b.x, a.y - b.y); }
function rectangle(a: TouchPoint, b: TouchPoint): TouchRect {
  return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
}

export class TouchGestureState {
  readonly pointers = new Map<number, TouchPoint>();
  phase: TouchPhase = "idle";
  private origin: TouchPoint = { x: 0, y: 0 };
  private last: TouchPoint = { x: 0, y: 0 };
  private startedAt = 0;
  private pinchDistance = 1;
  private suppressTap = false;
  private tool: TouchTool = "pan";

  constructor(private readonly hooks: TouchGestureHooks) {}

  private setPhase(value: TouchPhase): void {
    if (value === this.phase) return;
    this.phase = value;
    this.hooks.phase?.(value);
  }

  down(id: number, point: TouchPoint, now: number, tool: TouchTool = "pan"): void {
    if (this.pointers.has(id)) return;
    this.pointers.set(id, point);
    if (this.pointers.size === 1) {
      this.origin = this.last = point;
      this.startedAt = now;
      this.suppressTap = false;
      this.tool = tool;
      this.setPhase(tool === "marquee" ? "marquee" : "pending");
    } else if (this.pointers.size === 2) {
      this.suppressTap = true;
      this.hooks.marquee(null, false);
      const [a, b] = [...this.pointers.values()];
      this.pinchDistance = Math.max(1, distance(a, b));
      this.setPhase("pinch");
      this.hooks.pinchStart(center(a, b));
    }
  }

  move(id: number, point: TouchPoint): void {
    if (!this.pointers.has(id)) return;
    this.pointers.set(id, point);
    if (this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      this.hooks.pinch(distance(a, b) / this.pinchDistance, center(a, b));
      return;
    }
    if (this.phase === "context") return;
    if (this.phase === "pending" && distance(point, this.origin) > TOUCH_SLOP) this.setPhase("pan");
    if (this.phase === "pan") {
      this.suppressTap = true;
      this.hooks.pan(point.x - this.last.x, point.y - this.last.y);
    } else if (this.phase === "marquee" && distance(point, this.origin) > TOUCH_SLOP) {
      this.hooks.marquee(rectangle(this.origin, point), false);
    }
    this.last = point;
  }

  hold(now: number): void {
    if (this.phase !== "pending" || this.pointers.size !== 1 || this.suppressTap || now - this.startedAt < TOUCH_HOLD_MS) return;
    this.suppressTap = true;
    this.setPhase("context");
    this.hooks.context(this.last);
  }

  up(id: number, point: TouchPoint, now: number): void {
    if (!this.pointers.has(id)) return;
    const phase = this.phase;
    this.pointers.delete(id);
    if (this.pointers.size) {
      this.suppressTap = true;
      if (this.pointers.size === 1) {
        this.last = [...this.pointers.values()][0];
        this.setPhase("pan");
      } else {
        const [a, b] = [...this.pointers.values()];
        this.pinchDistance = Math.max(1, distance(a, b));
        this.hooks.pinchStart(center(a, b));
      }
      return;
    }
    if (!this.suppressTap && phase === "pending" && distance(point, this.origin) <= TOUCH_SLOP) {
      if (now - this.startedAt >= TOUCH_HOLD_MS) this.hooks.context(point);
      else this.hooks.tap(point);
    } else if (!this.suppressTap && this.tool === "marquee" && phase === "marquee"
      && distance(point, this.origin) > TOUCH_SLOP) this.hooks.marquee(rectangle(this.origin, point), true);
    this.hooks.marquee(null, false);
    this.setPhase("idle");
  }

  cancel(): void {
    this.suppressTap = true;
    this.pointers.clear();
    this.hooks.marquee(null, false);
    this.setPhase("idle");
  }
}
