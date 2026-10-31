export type SaveResult = { status: "success"; snapshot: SaveSnapshot }
  | { status: "exported"; snapshot: SaveSnapshot; method: "shared" | "downloaded" }
  | { status: "cancelled" } | { status: "failed"; error: string };

export interface SaveContent {
  text: string;
  format: string;
  options: unknown;
}

export interface SaveSnapshot {
  session: number;
  content: SaveContent;
  key: string;
}

function contentKey(content: SaveContent): string {
  // TXT settings are persisted in the source metadata. Parsed options may lag
  // behind a text edit and settle after Save; they are not additional bytes.
  return JSON.stringify({ format: content.format, text: content.text });
}

/** A save acknowledges the bytes captured for that write, never later edits. */
export class DocumentSaveSession {
  private session = 0;
  private baseline: string | null = null;

  capture(content: SaveContent): SaveSnapshot {
    const copy = structuredClone(content);
    return { session: this.session, content: copy, key: contentKey(copy) };
  }

  begin(content: SaveContent, savedContent: SaveContent | null = content): void {
    this.session++;
    this.baseline = savedContent === null ? null : contentKey(savedContent);
  }

  isDirty(content: SaveContent): boolean {
    return this.baseline === null || this.baseline !== contentKey(content);
  }

  isCurrent(snapshot: SaveSnapshot): boolean { return snapshot.session === this.session; }

  acknowledge(snapshot: SaveSnapshot): boolean {
    if (!this.isCurrent(snapshot)) return false;
    this.baseline = snapshot.key;
    return true;
  }
}
