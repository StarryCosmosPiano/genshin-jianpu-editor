import { JinpuPainter } from "../layout/painter";
import { parseSlashScore, type SlashScoreOptions } from "../slashscore";
import "./slash-score-preview.css";

let makePainter: (() => JinpuPainter) | null = null;
let pageSize: () => { width: number; height: number } = () => ({ width: 595, height: 842 });

/** Reuse the app's loaded music metadata and engraving settings in isolated previews. */
export function configureSlashScorePreview(
  factory: () => JinpuPainter,
  size?: () => { width: number; height: number },
): void {
  makePainter = factory;
  if (size) pageSize = size;
}

/** Isolated score and source-text previews; never changes the open editor document. */
export class SlashScorePreview {
  readonly element = document.createElement("section");
  private readonly heading = document.createElement("strong");
  private readonly scoreView = document.createElement("button");
  private readonly textView = document.createElement("button");
  private readonly sourceView = document.createElement("div");
  private readonly lineNumbers = document.createElement("div");
  private readonly lineNumberText = document.createElement("pre");
  private readonly sourceText = document.createElement("textarea");
  private readonly status = document.createElement("div");
  private readonly sheet = document.createElement("div");
  private readonly previous = document.createElement("button");
  private readonly next = document.createElement("button");
  private readonly pageLabel = document.createElement("span");
  private readonly navigation = document.createElement("div");
  private painter: JinpuPainter | null = null;
  private pageIndex = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private revision = 0;
  private disposed = false;
  private view: "score" | "text" = "score";

  constructor() {
    this.element.className = "slash-score-preview";
    this.element.setAttribute("aria-label", "导入预览");
    const header = document.createElement("div");
    header.className = "slash-score-preview-header";
    const views = document.createElement("div");
    views.className = "slash-score-preview-views";
    views.setAttribute("role", "group");
    views.setAttribute("aria-label", "预览方式");
    this.scoreView.type = this.textView.type = "button";
    this.scoreView.textContent = "简谱";
    this.textView.textContent = "文本谱";
    this.scoreView.dataset.previewView = "score";
    this.textView.dataset.previewView = "text";
    this.scoreView.onclick = () => this.selectView("score");
    this.textView.onclick = () => this.selectView("text");
    views.append(this.scoreView, this.textView);
    header.append(this.heading, views);
    this.sourceText.className = "slash-score-preview-text";
    this.sourceText.readOnly = true;
    this.sourceText.spellcheck = false;
    this.sourceText.wrap = "off";
    this.sourceText.setAttribute("aria-label", "文本谱预览");
    this.sourceView.className = "slash-score-preview-source";
    this.lineNumbers.className = "slash-score-preview-line-numbers";
    this.lineNumbers.setAttribute("aria-hidden", "true");
    this.lineNumbers.append(this.lineNumberText);
    this.sourceView.append(this.lineNumbers, this.sourceText);
    this.sourceText.onscroll = () => this.syncLineNumbers();
    this.status.className = "slash-score-preview-status";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.sheet.className = "slash-score-preview-sheet";
    this.navigation.className = "slash-score-preview-navigation";
    this.previous.type = this.next.type = "button";
    this.previous.textContent = "上一页";
    this.next.textContent = "下一页";
    this.previous.onclick = () => this.turn(-1);
    this.next.onclick = () => this.turn(1);
    this.navigation.append(this.previous, this.pageLabel, this.next);
    this.navigation.hidden = true;
    this.element.append(header, this.status, this.sheet, this.sourceView, this.navigation);
    this.selectView("score");
    this.clear("填写时值后显示简谱。");
  }

  set(text: string, options: SlashScoreOptions): void {
    if (this.disposed) return;
    this.cancelPending();
    // Show the draft verbatim, including the original duration symbols.
    this.setSourceText(text);
    const revision = this.revision;
    // A delayed render uses an immutable draft so later UI edits cannot leak in.
    const draft = structuredClone(options);
    this.status.textContent = "正在更新预览…";
    this.status.classList.remove("has-error");
    this.element.setAttribute("aria-busy", "true");
    this.timer = setTimeout(() => {
      this.timer = null;
      void document.fonts.ready.then(() => {
        if (this.disposed || revision !== this.revision) return;
        try {
          if (!makePainter) throw new Error("简谱预览尚未初始化。");
          const result = parseSlashScore(text, draft);
          const painter = makePainter();
          const size = pageSize();
          painter.score = result.score;
          painter.resize(size.width, size.height, null);
          this.painter = painter;
          this.pageIndex = Math.min(this.pageIndex, Math.max(0, painter.pageCount - 1));
          this.renderPage();
          const issues = result.summary.diagnostics.map((item) => item.message);
          this.status.textContent = `${result.summary.measures} 小节 · ${draft.voiceCount} 声部` +
            (issues.length ? `；${issues[0]}` : "");
          this.status.classList.toggle("has-error", issues.length > 0);
        } catch (reason) {
          this.painter = null;
          this.sheet.replaceChildren();
          this.navigation.hidden = true;
          this.status.textContent = reason instanceof Error ? reason.message : String(reason);
          this.status.classList.add("has-error");
        } finally {
          this.element.removeAttribute("aria-busy");
        }
      });
    }, 140);
  }

  clear(message = "填写时值后显示简谱。", text = ""): void {
    this.cancelPending();
    this.painter = null;
    this.pageIndex = 0;
    this.sheet.replaceChildren();
    this.setSourceText(text);
    this.status.textContent = message;
    this.status.classList.remove("has-error");
    this.navigation.hidden = true;
    this.element.removeAttribute("aria-busy");
  }

  showError(message: string, text: string): void {
    this.clear(message, text);
    this.status.classList.add("has-error");
  }

  destroy(): void {
    this.disposed = true;
    this.clear("");
    this.previous.onclick = this.next.onclick = null;
    this.scoreView.onclick = this.textView.onclick = null;
    this.sourceText.onscroll = null;
    this.element.remove();
  }

  private cancelPending(): void {
    this.revision++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private setSourceText(text: string): void {
    const scrollTop = this.sourceText.scrollTop;
    const scrollLeft = this.sourceText.scrollLeft;
    this.sourceText.value = text;
    // Keep numbers outside the selectable text. Empty and trailing lines count,
    // and textarea's newline normalization matches its actual visible rows.
    const count = this.sourceText.value.split("\n").length;
    this.lineNumberText.textContent = Array.from({ length: count }, (_, index) => String(index + 1)).join("\n");
    this.lineNumbers.dataset.lineCount = String(count);
    this.sourceText.scrollTop = scrollTop;
    this.sourceText.scrollLeft = scrollLeft;
    this.syncLineNumbers();
  }

  private syncLineNumbers(): void {
    // Translate rather than scroll the gutter: the textarea's horizontal
    // scrollbar reduces its viewport height, so their maximum scroll differs.
    this.lineNumberText.style.transform = `translateY(${-this.sourceText.scrollTop}px)`;
  }

  private selectView(view: "score" | "text"): void {
    this.view = view;
    this.heading.textContent = view === "score" ? "简谱预览" : "文本谱预览";
    this.scoreView.setAttribute("aria-pressed", String(view === "score"));
    this.textView.setAttribute("aria-pressed", String(view === "text"));
    this.sheet.hidden = view !== "score";
    this.sourceView.hidden = view !== "text";
    this.sourceText.hidden = view !== "text";
    this.navigation.hidden = view !== "score" || !this.painter || this.painter.pageCount <= 1;
  }

  private turn(delta: number): void {
    if (!this.painter) return;
    this.pageIndex = Math.max(0, Math.min(this.painter.pageCount - 1, this.pageIndex + delta));
    this.renderPage();
    this.sheet.scrollTop = 0;
  }

  private renderPage(): void {
    const painter = this.painter;
    if (!painter || painter.pageCount === 0) {
      this.sheet.replaceChildren();
      this.navigation.hidden = true;
      return;
    }
    const svg = painter.renderPage(this.pageIndex);
    svg.classList.add("slash-score-preview-svg");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `简谱预览，第 ${this.pageIndex + 1} 页`);
    // Only mount one page, even for a long song.
    this.sheet.replaceChildren(svg);
    this.pageLabel.textContent = `${this.pageIndex + 1} / ${painter.pageCount}`;
    this.previous.disabled = this.pageIndex === 0;
    this.next.disabled = this.pageIndex === painter.pageCount - 1;
    this.navigation.hidden = this.view !== "score" || painter.pageCount <= 1;
  }
}
