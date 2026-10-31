import { isTouchWorkspace } from "../bootstrap/device-mode";
import { createFileSheet, fileAction } from "./file-task";

export type MobileFileHandoff = "shared" | "downloaded" | "cancelled";

/** A mobile handoff is explicit and never masquerades as a writable file handle. */
export function needsMobileFileHandoff(): boolean {
  return isTouchWorkspace() && typeof window !== "undefined"
    && typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker !== "function";
}

export function canShareFile(file: File, target: Pick<Navigator, "canShare" | "share"> = navigator): boolean {
  if (typeof target.share !== "function" || typeof target.canShare !== "function") return false;
  try { return target.canShare({ files: [file] }); }
  catch { return false; }
}

export function mobileFileSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : bytes >= 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${bytes} 字节`;
}

/** Data is prepared before this sheet; Share always runs inside a fresh click. */
export function handoffMobileFile(bytes: Uint8Array | Blob, name: string, mime: string): Promise<MobileFileHandoff> {
  const file = new File([bytes instanceof Blob ? bytes : bytes as BlobPart], name, { type: mime.split(";")[0] });
  const sheet = createFileSheet("文件已准备好");
  const description = document.createElement("p");
  description.textContent = `${name} · ${mobileFileSize(file.size)}`;
  sheet.body.append(description);
  const hint = document.createElement("p");
  hint.textContent = "请选择分享并存到系统“文件”，或下载一份副本。此操作不会绑定或覆盖原文件。";
  sheet.body.append(hint);
  return new Promise(resolve => {
    let finished = false;
    let sharing = false;
    const finish = (result: MobileFileHandoff): void => {
      if (finished || sharing) return;
      finished = true;
      sheet.close();
      resolve(result);
    };
    const close = fileAction("暂不导出", () => finish("cancelled"));
    const download = fileAction("下载副本", () => {
      if (sharing) return;
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.rel = "noopener";
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      // WebKit can read the blob after the event has returned.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      finish("downloaded");
    });
    sheet.footer.append(close, download);
    if (canShareFile(file)) {
      const share = fileAction("分享 / 存到文件", () => {
        if (sharing) return;
        sharing = true;
        close.disabled = download.disabled = share.disabled = true;
        // Do not await any work before this call: transient activation matters.
        let pending: Promise<void>;
        try { pending = navigator.share({ files: [file] }); }
        catch (error) { pending = Promise.reject(error); }
        void pending.then(() => {
          sharing = false;
          finish("shared");
        }).catch((error: unknown) => {
          sharing = false;
          close.disabled = download.disabled = share.disabled = false;
          sheet.message.textContent = typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
            ? "已取消分享。文件仍在这里，可以重试或关闭。"
            : `分享未完成：${error instanceof Error ? error.message : String(error)}。可重试或选择下载副本。`;
          share.focus();
        });
      }, true);
      sheet.footer.append(share);
      share.focus();
    } else {
      sheet.message.textContent = "当前浏览器不能分享这种文件，可点击“下载副本”，再从系统下载列表打开。";
      download.focus();
    }
    sheet.onDismiss(() => finish("cancelled"));
  });
}

export function mobileHandoffMessage(result: Exclude<MobileFileHandoff, "cancelled">): string {
  return result === "shared" ? "文件已交给系统分享；请在所选目标确认保存。本机草稿仍保留。"
    : "已交给浏览器下载；请在系统下载列表确认文件。本机草稿仍保留。";
}
