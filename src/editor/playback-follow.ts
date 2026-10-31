import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

interface SourceRange { from: number; to: number }
const setPlaybackRanges = StateEffect.define<readonly SourceRange[]>();
const playingMark = Decoration.mark({ class: "cm-playback-source" });

/** Playback decoration is independent of both text and score selections. */
export const playbackSourceHighlighter = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = transaction.docChanged ? Decoration.none : value;
    for (const effect of transaction.effects) if (effect.is(setPlaybackRanges)) {
      next = Decoration.set(effect.value.filter(range => range.to > range.from)
        .map(range => playingMark.range(range.from, range.to)), true);
    }
    return next;
  },
  provide: field => EditorView.decorations.from(field),
});

/** Bring a newly reached system near the top, without nudging every note. */
export function scrollPlaybackTarget(container: HTMLElement, target: Element): void {
  const viewport = container.getBoundingClientRect();
  const bounds = target.getBoundingClientRect();
  if (viewport.height <= 0 || bounds.height <= 0) return;
  const margin = Math.min(32, viewport.height * 0.08);
  if (bounds.top < viewport.top + margin || bounds.bottom > viewport.bottom - margin) {
    container.scrollTop += bounds.top - viewport.top - viewport.height * 0.15;
  }
  if (bounds.left < viewport.left) container.scrollLeft += bounds.left - viewport.left - 16;
  else if (bounds.right > viewport.right) container.scrollLeft += bounds.right - viewport.right + 16;
}

export class TextPlaybackFollower {
  private following = true;
  private playing = false;
  private ranges: readonly SourceRange[] = [];
  private frame = 0;
  private readonly abort = new AbortController();
  readonly button: HTMLButtonElement;

  constructor(private readonly view: EditorView) {
    this.button = document.createElement("button");
    this.button.id = "text-resume-follow";
    this.button.type = "button";
    this.button.textContent = "恢复跟随";
    this.button.title = "恢复文本谱播放跟随";
    this.button.hidden = true;
    document.getElementById("code-workspace-header")?.append(this.button);
    const options = { signal: this.abort.signal };
    view.scrollDOM.addEventListener("wheel", event => {
      if (!event.ctrlKey && !event.metaKey) this.pause();
    }, { ...options, passive: true });
    view.scrollDOM.addEventListener("touchmove", () => this.pause(), { ...options, passive: true });
    view.scrollDOM.addEventListener("pointerdown", event => {
      const bounds = view.scrollDOM.getBoundingClientRect();
      if (event.clientX >= bounds.left + view.scrollDOM.clientWidth
        || event.clientY >= bounds.top + view.scrollDOM.clientHeight) this.pause();
    }, options);
    view.dom.addEventListener("keydown", event => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) this.pause();
    }, options);
    this.button.addEventListener("click", () => {
      this.following = true;
      this.button.hidden = true;
      this.follow();
    }, options);
  }

  private pause(): void {
    if (!this.playing) return;
    this.following = false;
    this.button.hidden = false;
  }

  setPlaying(playing: boolean): void {
    this.playing = playing;
    if (playing) this.following = true;
    else this.show([]);
    this.button.hidden = true;
  }

  show(ranges: readonly SourceRange[]): void {
    const length = this.view.state.doc.length;
    const unique = new Map(ranges.map(range => [`${range.from}:${range.to}`, range]));
    this.ranges = [...unique.values()].filter(range => range.from >= 0 && range.to <= length);
    this.view.dispatch({ effects: setPlaybackRanges.of(this.ranges) });
    this.follow();
  }

  private follow(): void {
    cancelAnimationFrame(this.frame);
    if (!this.following || !this.playing || this.ranges.length === 0) return;
    this.frame = requestAnimationFrame(() => {
      if (!this.following || !this.playing || this.ranges.length === 0
        || this.view.dom.getClientRects().length === 0) return;
      const position = Math.min(...this.ranges.map(range => range.from));
      const viewport = this.view.scrollDOM.getBoundingClientRect();
      if (viewport.height <= 0) return;
      const bounds = this.view.coordsAtPos(position);
      const margin = Math.min(32, viewport.height * 0.08);
      if (!bounds || bounds.top < viewport.top + margin || bounds.bottom > viewport.bottom - margin) {
        this.view.dispatch({ effects: EditorView.scrollIntoView(position, {
          y: "start", yMargin: Math.round(viewport.height * 0.15), x: "nearest",
        }) });
      }
    });
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.abort.abort();
    this.button.remove();
  }
}
