import { Font, VexFlow } from "vexflow/core";

let ready: Promise<void> | null = null;

/** The core entry point does not start the default CDN font requests. */
export function loadStaffFonts(): Promise<void> {
  if (!ready) {
    ready = Font.load("Bravura", `${import.meta.env.BASE_URL}redist/Bravura.woff2`)
      .then(() => {
        // Text remains an installed system font; all notation uses local Bravura.
        VexFlow.setFonts("Bravura", "Arial");
        VexFlow.UNISON = false;
      })
      .catch((error: unknown) => {
        ready = null;
        throw error;
      });
  }
  return ready;
}

export function abortStaffPreview(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Staff preview cancelled", "AbortError");
}

/** A task boundary allows editing and cancellation between layout batches. */
export async function yieldStaffPreview(signal?: AbortSignal): Promise<void> {
  abortStaffPreview(signal);
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  abortStaffPreview(signal);
}
