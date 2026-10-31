import { createFileSheet, fileAction } from "./file-task";
import { indexedDbDraftStore, mobileDraftFailure, type MobileDraftRecord } from "./mobile-drafts";

export function confirmMobileDraftReplacement(action: string): Promise<"draft" | "discard" | "cancel"> {
  const sheet = createFileSheet("保留当前乐谱");
  const text = document.createElement("p");
  text.textContent = `${action}前，要把当前内容保留为本机草稿吗？本机草稿不会覆盖原文件，可稍后继续编辑或导出。`;
  sheet.body.append(text);
  return new Promise(resolve => {
    const finish = (result: "draft" | "discard" | "cancel") => { sheet.close(); resolve(result); };
    sheet.footer.append(fileAction("取消", () => finish("cancel")),
      fileAction("不保留草稿", () => finish("discard")),
      fileAction("保留草稿并继续", () => finish("draft"), true));
    sheet.onDismiss(() => finish("cancel"));
  });
}

export async function showMobileDraftHistory(restore: (record: MobileDraftRecord) => Promise<void>): Promise<void> {
  const sheet = createFileSheet("本机草稿");
  sheet.message.textContent = "正在读取草稿…";
  const done = fileAction("关闭", sheet.close);
  sheet.footer.append(done);
  sheet.onDismiss(sheet.close);
  const description = document.createElement("p");
  description.textContent = "草稿只保存在当前浏览器。清理网站数据会移除草稿，请把重要乐谱导出备份。恢复时会建立独立副本。";
  sheet.body.append(description);
  try {
    const records = await indexedDbDraftStore.list();
    if (!sheet.element.isConnected) return;
    sheet.message.textContent = records.length ? `${records.length} 份草稿` : "还没有本机草稿。编辑乐谱后会自动保存。";
    const list = document.createElement("div");
    list.className = "mobile-file-list";
    for (const record of records) {
      const row = document.createElement("div");
      const button = fileAction(record.name, () => { sheet.close(); void restore(record); });
      const metadata = document.createElement("small");
      metadata.textContent = `${new Date(record.updatedAt).toLocaleString()} · ${record.text.length.toLocaleString()} 字符`;
      button.append(metadata);
      const remove = fileAction("删除这份草稿", () => {
        if (remove.dataset.confirm !== "true") {
          remove.dataset.confirm = "true";
          remove.textContent = "再次点击确认删除";
          return;
        }
        remove.disabled = true;
        void indexedDbDraftStore.remove(record.id).then(() => {
          row.remove();
          sheet.message.textContent = "草稿已删除，外部文件没有更改。";
        }).catch(error => {
          remove.disabled = false;
          sheet.message.textContent = mobileDraftFailure(error);
        });
      });
      row.append(button, remove);
      list.append(row);
    }
    sheet.body.append(list);
  } catch (error) { sheet.message.textContent = mobileDraftFailure(error); }
}

export function offerLastMobileDraft(record: MobileDraftRecord,
  restore: (record: MobileDraftRecord) => Promise<void>, list: () => Promise<void>): void {
  const sheet = createFileSheet("继续上次编辑");
  const text = document.createElement("p");
  text.textContent = `找到本机草稿“${record.name}”（${new Date(record.updatedAt).toLocaleString()}）。恢复会建立副本，原文件不变。`;
  sheet.body.append(text);
  sheet.footer.append(fileAction("稍后", sheet.close), fileAction("查看全部草稿", () => { sheet.close(); void list(); }),
    fileAction("继续编辑", () => { sheet.close(); void restore(record); }, true));
  sheet.onDismiss(sheet.close);
}
