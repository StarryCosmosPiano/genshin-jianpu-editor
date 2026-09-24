import {
  SHORTCUT_ACTIONS,
  defaultShortcutBindings,
  findShortcutConflicts,
  getShortcutBindings,
  saveShortcutBindings,
  shortcutBindingAllowed,
  shortcutChordFromEvent,
  shortcutLabel,
  type ShortcutBindings,
  type ShortcutCategory,
} from "../editor/shortcuts";

const CATEGORIES: ShortcutCategory[] = ["谱面选择", "打谱输入", "声部", "页面", "文本编辑"];

function button(label: string, action: () => void, className = ""): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  element.addEventListener("click", action);
  return element;
}

function addStyles(): void {
  if (document.getElementById("shortcut-settings-style")) return;
  const style = document.createElement("style");
  style.id = "shortcut-settings-style";
  style.textContent = `
    .shortcut-overlay{position:fixed;inset:0;z-index:10020;background:rgba(17,20,30,.58);display:grid;place-items:center;padding:18px}
    .shortcut-dialog{box-sizing:border-box;width:min(920px,100%);max-height:min(92vh,900px);display:flex;flex-direction:column;overflow:hidden;border-radius:16px;border:1px solid var(--border);background:var(--surface,#fff);color:var(--text,#222);box-shadow:0 28px 90px #0005}
    .shortcut-head{padding:18px 22px 12px;border-bottom:1px solid #8883}
    .shortcut-title{font-size:20px;font-weight:700;margin:0 0 5px}
    .shortcut-hint{font-size:12px;line-height:1.5;opacity:.72;margin:0 0 12px}
    .shortcut-search{box-sizing:border-box;width:100%;padding:9px 11px;border:1px solid #8887;border-radius:9px;background:transparent;color:inherit;font:inherit}
    .shortcut-body{overflow:auto;padding:4px 22px 16px}
    .shortcut-group{margin:15px 0 0}
    .shortcut-group h3{font-size:13px;letter-spacing:.03em;margin:0 0 5px;opacity:.72}
    .shortcut-row{display:grid;grid-template-columns:minmax(170px,1fr) minmax(220px,1.6fr) auto;align-items:center;gap:10px;padding:8px 2px;border-bottom:1px solid #8882}
    .shortcut-name{font-size:13px;line-height:1.35}
    .shortcut-keys{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
    .shortcut-dialog button{font:inherit;color:inherit;cursor:pointer}
    .shortcut-key{display:inline-flex;align-items:center;gap:0;border:1px solid #8887;border-radius:7px;background:#8881;overflow:hidden;white-space:nowrap}
    .shortcut-key button{border:0;background:transparent;font-size:12px;padding:5px 7px}
    .shortcut-key button:hover,.shortcut-subtle:hover{background:#8883}
    .shortcut-remove{opacity:.7;border-left:1px solid #8885!important}
    .shortcut-subtle{border:1px solid #8885;background:transparent;border-radius:7px;padding:5px 8px;font-size:12px!important}
    .shortcut-empty{font-size:12px;opacity:.55}
    .shortcut-conflict{color:#bd3838;font-size:12px;margin:9px 22px 0;min-height:18px}
    .shortcut-row[data-conflict=true]{background:#ef555514}
    .shortcut-footer{display:flex;align-items:center;gap:8px;padding:12px 22px 18px;border-top:1px solid #8883}
    .shortcut-footer .spacer{flex:1}
    .shortcut-footer button{border:1px solid #8886;border-radius:8px;background:transparent;padding:7px 12px}
    .shortcut-footer .primary{background:var(--gold);color:var(--gold-ink);border-color:var(--gold)}
    .shortcut-footer .primary:hover{background:var(--gold-hover);color:var(--gold-ink);border-color:var(--gold-hover)}
    .shortcut-footer button:disabled{opacity:.45;cursor:not-allowed}
    .shortcut-recording{position:absolute;inset:0;z-index:2;display:grid;place-items:center;background:#10131bbd;color:white;font-size:17px;text-align:center;padding:20px}
    @media(max-width:640px){.shortcut-row{grid-template-columns:1fr auto}.shortcut-keys{grid-column:1 / -1;grid-row:2}.shortcut-body{padding-left:13px;padding-right:13px}.shortcut-head,.shortcut-footer{padding-left:13px;padding-right:13px}}
  `;
  document.head.append(style);
}

/** Open the keyboard shortcut editor. Edits stay in a draft until Apply. */
export function showShortcutSettingsDialog(): void {
  document.querySelector(".shortcut-overlay")?.remove();
  addStyles();
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const draft: ShortcutBindings = getShortcutBindings();
  const defaults = defaultShortcutBindings();
  const overlay = document.createElement("div");
  overlay.className = "shortcut-overlay";
  overlay.setAttribute("role", "presentation");
  const dialog = document.createElement("section");
  dialog.className = "shortcut-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "快捷键编辑");
  dialog.tabIndex = -1;
  overlay.append(dialog);

  const head = document.createElement("header");
  head.className = "shortcut-head";
  const title = document.createElement("h2");
  title.className = "shortcut-title";
  title.textContent = "快捷键编辑";
  const hint = document.createElement("p");
  hint.className = "shortcut-hint";
  hint.textContent = "点击键位后按新组合键；一个操作可保留多个键位。Esc 取消录制，仅在“应用”后保存。复制、剪切、粘贴沿用系统快捷键。";
  const search = document.createElement("input");
  search.className = "shortcut-search";
  search.type = "search";
  search.placeholder = "搜索操作或按键";
  search.setAttribute("aria-label", "搜索快捷键");
  head.append(title, hint, search);
  const body = document.createElement("div");
  body.className = "shortcut-body";
  const conflict = document.createElement("div");
  conflict.className = "shortcut-conflict";
  conflict.setAttribute("role", "status");
  const footer = document.createElement("footer");
  footer.className = "shortcut-footer";
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  const apply = button("应用", () => {
    try { saveShortcutBindings(draft); close(); }
    catch (error) { conflict.textContent = error instanceof Error ? error.message : "保存失败"; }
  }, "primary");
  footer.append(button("全部恢复默认", () => {
    for (const item of SHORTCUT_ACTIONS) draft[item.id] = [...defaults[item.id]];
    render();
  }), spacer, button("取消", () => close()), apply);
  dialog.append(head, body, conflict, footer);

  let recording: { id: string; index: number | null; trigger: HTMLButtonElement } | null = null;
  let recordingPane: HTMLElement | null = null;

  const stopRecording = (): void => {
    recording = null;
    recordingPane?.remove();
    recordingPane = null;
  };
  const close = (): void => {
    stopRecording();
    overlay.remove();
    opener?.focus();
  };
  const startRecording = (id: string, index: number | null, trigger: HTMLButtonElement): void => {
    stopRecording();
    recording = { id, index, trigger };
    recordingPane = document.createElement("div");
    recordingPane.className = "shortcut-recording";
    recordingPane.textContent = "请按新快捷键 · Esc 取消";
    dialog.append(recordingPane);
    dialog.focus();
  };

  const render = (): void => {
    const query = search.value.trim().toLocaleLowerCase();
    body.replaceChildren();
    const conflicted = findShortcutConflicts(draft);
    const ids = new Set(conflicted.flatMap((item) => [item.first.id, item.second.id]));
    apply.disabled = conflicted.length > 0;
    conflict.textContent = conflicted.length
      ? `键位冲突：${shortcutLabel(conflicted[0].chord)} 同时分配给“${conflicted[0].first.label}”和“${conflicted[0].second.label}”。`
      : "";
    for (const category of CATEGORIES) {
      const items = SHORTCUT_ACTIONS.filter((item) => item.category === category &&
        (!query || `${item.label} ${item.id} ${(draft[item.id] ?? []).map(shortcutLabel).join(" ")}`
          .toLocaleLowerCase().includes(query)));
      if (!items.length) continue;
      const group = document.createElement("section");
      group.className = "shortcut-group";
      const heading = document.createElement("h3");
      heading.textContent = category;
      group.append(heading);
      for (const item of items) {
        const row = document.createElement("div");
        row.className = "shortcut-row";
        row.dataset.conflict = String(ids.has(item.id));
        const name = document.createElement("span");
        name.className = "shortcut-name";
        name.textContent = item.label;
        const keys = document.createElement("div");
        keys.className = "shortcut-keys";
        for (const [index, chord] of (draft[item.id] ?? []).entries()) {
          const capsule = document.createElement("span");
          capsule.className = "shortcut-key";
          const edit = button(shortcutLabel(chord), () => startRecording(item.id, index, edit));
          edit.title = `修改“${item.label}”的键位`;
          const remove = button("×", () => {
            draft[item.id].splice(index, 1);
            render();
          }, "shortcut-remove");
          remove.setAttribute("aria-label", `清除“${item.label}”的 ${shortcutLabel(chord)}`);
          capsule.append(edit, remove);
          keys.append(capsule);
        }
        if (!draft[item.id].length) {
          const empty = document.createElement("span");
          empty.className = "shortcut-empty";
          empty.textContent = "未设置";
          keys.append(empty);
        }
        if (draft[item.id].length < 4) {
          const add = button("＋ 添加", () => startRecording(item.id, null, add), "shortcut-subtle");
          keys.append(add);
        }
        const reset = button("默认", () => { draft[item.id] = [...defaults[item.id]]; render(); }, "shortcut-subtle");
        reset.setAttribute("aria-label", `恢复“${item.label}”的默认键位`);
        row.append(name, keys, reset);
        group.append(row);
      }
      body.append(group);
    }
    if (!body.childElementCount) {
      const empty = document.createElement("p");
      empty.textContent = "没有匹配的操作";
      body.append(empty);
    }
  };

  search.addEventListener("input", render);
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay && !recording) close();
  });
  overlay.addEventListener("keydown", (event) => {
    if (recording) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") { stopRecording(); return; }
      const chord = shortcutChordFromEvent(event);
      if (!chord) return;
      const { id, index } = recording;
      if (!shortcutBindingAllowed(id, chord)) {
        if (recordingPane) recordingPane.textContent = "文本编辑不能占用普通文字或符号，请加 Ctrl／⌘／Alt 等修饰键";
        return;
      }
      if (index === null) draft[id].push(chord);
      else draft[id][index] = chord;
      draft[id] = [...new Set(draft[id])];
      stopRecording();
      render();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }, true);
  document.body.append(overlay);
  render();
  search.focus();
}
