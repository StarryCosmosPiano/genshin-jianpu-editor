import type { App } from "../editor/app";
import { remapShortcutEvent } from "../editor/shortcuts";

/** Wire page zoom, pointer anchoring, touchpad gestures and page-navigation keys. */
export function wireZoomControls(app: App, scorePane: HTMLElement): void {
  const zoomLabel = document.getElementById("btn-zoom-reset");
  const updateZoom = (): void => {
    if (zoomLabel) zoomLabel.textContent = `${Math.round(app.zoom * 100)}%`;
  };
  const on = (id: string, listener: () => void): void => {
    document.getElementById(id)?.addEventListener("click", listener);
  };
  on("btn-zoom-in", () => { app.zoomBy(1.2); updateZoom(); });
  on("btn-zoom-out", () => { app.zoomBy(1 / 1.2); updateZoom(); });
  on("btn-zoom-reset", () => { app.resetZoom(); updateZoom(); });
  updateZoom();

  // A gesture keeps one normalized point inside its page under the pointer.
  // Wheel/gesture updates are coalesced to one layout write per animation frame.
  let pendingZoom: number | null = null;
  let anchorX = 0;
  let anchorY = 0;
  let rafId = 0;
  const anchorPage = (y: number): HTMLElement | null => {
    const wraps = scorePane.querySelectorAll<HTMLElement>(".score-page-wrap");
    let best: HTMLElement | null = null;
    let bestDistance = Infinity;
    for (const wrap of wraps) {
      const rect = wrap.getBoundingClientRect();
      if (y >= rect.top && y <= rect.bottom) return wrap;
      const distance = y < rect.top ? rect.top - y : y - rect.bottom;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = wrap;
      }
    }
    return best;
  };

  let gestureAnchor: { page: HTMLElement; fx: number; fy: number } | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const beginOrKeepAnchor = (clientX: number, clientY: number): void => {
    if (!gestureAnchor) {
      const page = anchorPage(clientY);
      if (page) {
        const rect = page.getBoundingClientRect();
        gestureAnchor = {
          page,
          fx: (clientX - rect.left) / rect.width,
          fy: (clientY - rect.top) / rect.height,
        };
      }
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { gestureAnchor = null; }, 250);
  };
  const flushZoom = (): void => {
    rafId = 0;
    if (pendingZoom === null) return;
    app.setZoom(pendingZoom);
    pendingZoom = null;
    if (gestureAnchor) {
      const post = gestureAnchor.page.getBoundingClientRect();
      const desiredLeft = anchorX - gestureAnchor.fx * post.width;
      const desiredTop = anchorY - gestureAnchor.fy * post.height;
      scorePane.scrollLeft += post.left - desiredLeft;
      scorePane.scrollTop += post.top - desiredTop;
    }
    updateZoom();
  };
  const scheduleZoom = (target: number, clientX: number, clientY: number): void => {
    pendingZoom = target;
    anchorX = clientX;
    anchorY = clientY;
    beginOrKeepAnchor(clientX, clientY);
    if (!rafId) rafId = requestAnimationFrame(flushZoom);
  };
  const zoomBy = (clientX: number, clientY: number, factor: number): void => {
    scheduleZoom((pendingZoom ?? app.zoom) * factor, clientX, clientY);
  };

  scorePane.addEventListener("wheel", (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoomBy(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0015));
  }, { passive: false });

  let gestureBase = 1;
  type GestureEventLike = Event & { scale: number; clientX: number; clientY: number };
  scorePane.addEventListener("gesturestart", (rawEvent) => {
    const event = rawEvent as GestureEventLike;
    event.preventDefault();
    gestureBase = app.zoom;
    gestureAnchor = null;
  });
  scorePane.addEventListener("gesturechange", (rawEvent) => {
    const event = rawEvent as GestureEventLike;
    event.preventDefault();
    scheduleZoom(gestureBase * event.scale, event.clientX, event.clientY);
  });
  scorePane.addEventListener("gestureend", (event) => event.preventDefault());

  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) return;
    const mapped = remapShortcutEvent(event, "global");
    if (!mapped) return;
    event = mapped;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && (event.key === "=" || event.key === "+")) {
      event.preventDefault();
      app.zoomBy(1.2);
      updateZoom();
    } else if (modifier && event.key === "-") {
      event.preventDefault();
      app.zoomBy(1 / 1.2);
      updateZoom();
    } else if (modifier && event.key === "0") {
      event.preventDefault();
      app.resetZoom();
      updateZoom();
    } else if (event.key === "PageDown") {
      event.preventDefault();
      app.nextPage();
    } else if (event.key === "PageUp") {
      event.preventDefault();
      app.prevPage();
    } else if (event.key === "Home" && event.ctrlKey) {
      event.preventDefault();
      app.goToPage(0);
    } else if (event.key === "End" && event.ctrlKey) {
      event.preventDefault();
      app.goToPage(1e9);
    }
  });
}
