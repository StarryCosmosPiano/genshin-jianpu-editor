/** Whole-page virtualization: layout and page indexes stay unchanged. */
export function visiblePageWindow(visible: Iterable<number>, count: number, fallback: number,
  requested: number | null = null): Set<number> {
  const result = new Set<number>();
  const add = (index: number): void => {
    for (let page = Math.max(0, index - 1); page <= Math.min(count - 1, index + 1); page++) result.add(page);
  };
  for (const index of visible) if (index >= 0 && index < count) add(index);
  if (!result.size && count) add(Math.max(0, Math.min(count - 1, fallback)));
  if (requested !== null) add(requested);
  return result;
}

export class ScorePageViewport {
  private observer: IntersectionObserver;
  private pages: HTMLElement[] = [];
  private indexes = new Map<Element, number>();
  private visible = new Set<number>();
  private mounted = new Set<number>();
  private requested: number | null = null;
  private fallback = 0;
  private frame = 0;
  private updating = false;

  constructor(root: HTMLElement, private hooks: {
    mount: (page: number) => void;
    unmount: (page: number) => void;
    changed: (mounted: ReadonlySet<number>) => void;
  }) {
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const index = this.indexes.get(entry.target);
        if (index === undefined) continue;
        if (entry.isIntersecting && entry.intersectionRatio > 0) this.visible.add(index);
        else this.visible.delete(index);
      }
      if (this.requested !== null && this.visible.has(this.requested)) this.requested = null;
      if (this.visible.size) this.fallback = Math.min(...this.visible);
      if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.update(); });
    }, { root, threshold: [0, .001] });
  }

  setPages(pages: HTMLElement[], current: number): void {
    this.observer.disconnect();
    this.pages = pages;
    this.indexes = new Map(pages.map((page, index) => [page, index]));
    this.visible.clear();
    this.mounted.clear();
    this.fallback = current;
    this.requested = null;
    for (const page of pages) this.observer.observe(page);
    this.update(true);
  }

  ensure(index: number): void {
    if (index < 0 || index >= this.pages.length) return;
    if (this.mounted.has(index)) return;
    this.requested = index;
    this.update();
  }

  private update(force = false): void {
    if (this.updating) return;
    this.updating = true;
    try {
      const keep = visiblePageWindow(this.visible, this.pages.length, this.fallback, this.requested);
      let changed = force;
      this.pages.forEach((page, index) => {
        if (keep.has(index)) {
          if (force || !this.mounted.has(index) || !page.firstElementChild) { this.hooks.mount(index); changed = true; }
        } else if (page.firstElementChild) { this.hooks.unmount(index); changed = true; }
      });
      this.mounted = keep;
      if (changed) this.hooks.changed(keep);
    } finally { this.updating = false; }
  }

  dispose(): void {
    this.observer.disconnect();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.pages = [];
    this.indexes.clear();
    this.visible.clear();
    this.mounted.clear();
  }
}
