import assert from "node:assert/strict";
import { TouchGestureState, TOUCH_HOLD_MS, type TouchGestureHooks } from "./src/bootstrap/touch-gesture-state";
import { resolveWorkspaceMode } from "./src/bootstrap/device-mode";

function fixture() {
  const events: Array<{ type: string; value?: unknown }> = [];
  const hooks: TouchGestureHooks = {
    tap: value => events.push({ type: "tap", value }),
    context: value => events.push({ type: "context", value }),
    pan: (x, y) => events.push({ type: "pan", value: [x, y] }),
    pinchStart: value => events.push({ type: "pinchStart", value }),
    pinch: (scale, center) => events.push({ type: "pinch", value: { scale, center } }),
    marquee: (rect, committed) => { if (rect || committed) events.push({ type: committed ? "selection" : "marquee", value: rect }); },
  };
  return { state: new TouchGestureState(hooks), events };
}

{
  const { state, events } = fixture();
  state.down(1, { x: 10, y: 20 }, 0);
  state.move(1, { x: 13, y: 23 });
  state.up(1, { x: 13, y: 23 }, 80);
  assert.equal(events.filter(event => event.type === "tap").length, 1, "one stationary touch resolves to one tap");
  assert.equal(state.phase, "idle");
}
{
  const { state, events } = fixture();
  state.down(1, { x: 10, y: 20 }, 0);
  state.move(1, { x: 10, y: 70 });
  state.hold(600);
  state.up(1, { x: 10, y: 70 }, 620);
  assert.deepEqual(events.map(event => event.type), ["pan"], "a drag cannot fall through to a tap or long press");
}
{
  const { state, events } = fixture();
  state.down(1, { x: 10, y: 20 }, 0);
  state.down(2, { x: 110, y: 20 }, 40);
  state.hold(800);
  state.move(2, { x: 210, y: 20 });
  state.up(2, { x: 210, y: 20 }, 850);
  state.up(1, { x: 10, y: 20 }, 860);
  assert.deepEqual(events.filter(event => ["tap", "context", "selection"].includes(event.type)), [], "second finger cancels every pending edit gesture");
  assert.deepEqual(events.find(event => event.type === "pinch")?.value, { scale: 2, center: { x: 110, y: 20 } });
}
{
  const { state, events } = fixture();
  state.down(1, { x: 30, y: 30 }, 0, "marquee");
  state.move(1, { x: 80, y: 70 });
  state.down(2, { x: 100, y: 100 }, 120, "marquee");
  state.up(2, { x: 100, y: 100 }, 130);
  state.up(1, { x: 80, y: 70 }, 140);
  assert.equal(events.filter(event => event.type === "selection").length, 0, "pinch cancels an in-progress marquee without committing it");
}
{
  const { state, events } = fixture();
  state.down(1, { x: 80, y: 70 }, 0, "marquee");
  state.move(1, { x: 30, y: 20 });
  state.up(1, { x: 30, y: 20 }, 200);
  assert.deepEqual(events.find(event => event.type === "selection")?.value, { left: 30, top: 20, right: 80, bottom: 70 });
  assert.equal(events.filter(event => event.type === "tap").length, 0);
}
{
  const { state, events } = fixture();
  state.down(1, { x: 10, y: 10 }, 0);
  state.hold(TOUCH_HOLD_MS);
  state.up(1, { x: 10, y: 10 }, TOUCH_HOLD_MS + 1);
  assert.deepEqual(events.map(event => event.type), ["context"], "long press opens one menu without a release click");
}
{
  const { state, events } = fixture();
  state.down(1, { x: 10, y: 10 }, 0);
  state.cancel();
  state.hold(600);
  state.up(1, { x: 10, y: 10 }, 700);
  assert.deepEqual(events, [], "cancel/disconnect/document replacement cannot select or type");
  assert.equal(state.pointers.size, 0);
}
assert.equal(resolveWorkspaceMode("auto", 767, false), "phone");
assert.equal(resolveWorkspaceMode("auto", 768, true), "tablet");
assert.equal(resolveWorkspaceMode("auto", 1024, false), "desktop");
assert.equal(resolveWorkspaceMode("desktop", 390, true), "desktop");
assert.equal(resolveWorkspaceMode("phone", 1440, false), "phone");
console.log("Touch gesture arbitration: tap, pan, pinch, cancellation, long press, marquee and explicit workspace modes OK");
