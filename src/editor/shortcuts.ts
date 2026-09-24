import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import type { EditorView, KeyBinding } from "@codemirror/view";

export type ShortcutContext = "selection" | "input" | "object" | "text" | "global";
export type ShortcutCategory = "谱面选择" | "打谱输入" | "声部" | "页面" | "文本编辑";

export interface ShortcutAction {
  id: string;
  label: string;
  category: ShortcutCategory;
  contexts: readonly ShortcutContext[];
  defaults: readonly string[];
  description?: string;
}

const STORAGE_KEY = "jpeditor.ui.shortcuts.v1";
const SCORE = ["selection", "input", "object"] as const;
const INPUT = ["input", "object"] as const;
const VOICE = ["selection", "input", "object", "text"] as const;
const GLOBAL = ["global"] as const;
const action = (id: string, label: string, category: ShortcutCategory,
  contexts: readonly ShortcutContext[], ...defaults: string[]): ShortcutAction =>
  ({ id, label, category, contexts, defaults });

const scoreActions: ShortcutAction[] = [
  { ...action("score.toggleInput", "进入／退出打谱", "打谱输入", SCORE, "n", "Shift+n"),
    description: "选音后进入打谱；显示键盘按键时，打谱中的 N 改音，使用 Esc 退出。" },
  action("score.play", "从选中音播放／停止", "谱面选择", ["selection"], "Space"),
  action("score.undo", "撤销", "谱面选择", SCORE, "Mod+z"),
  action("score.redo", "重做", "谱面选择", SCORE, "Mod+Shift+z", "Mod+y"),
  action("score.delete", "删除所选音符／对象", "谱面选择", SCORE, "Delete", "Backspace"),
  action("score.octaveUp", "所选音升八度", "谱面选择", ["selection"], "ArrowUp"),
  action("score.octaveDown", "所选音降八度", "谱面选择", ["selection"], "ArrowDown"),
  action("score.movePartUp", "所选音移到上一声部", "谱面选择", ["selection"], "Alt+ArrowUp"),
  action("score.movePartDown", "所选音移到下一声部", "谱面选择", ["selection"], "Alt+ArrowDown"),
  action("object.edit", "编辑所选记号", "谱面选择", ["object"], "Enter"),
  action("input.exit", "退出打谱", "打谱输入", INPUT, "Escape"),
  ...Array.from({ length: 8 }, (_, n) => action(
    `input.degree${n}`, n === 0 ? "输入休止符 0" : `输入音级 ${n}`,
    "打谱输入", INPUT, String(n))),
  action("input.advance", "按当前时值前进", "打谱输入", INPUT, "Space"),
  action("input.left", "光标左移", "打谱输入", INPUT, "ArrowLeft"),
  action("input.right", "光标右移", "打谱输入", INPUT, "ArrowRight"),
  action("input.up", "选择上方和弦层", "打谱输入", INPUT, "ArrowUp"),
  action("input.down", "选择下方和弦层", "打谱输入", INPUT, "ArrowDown"),
  action("input.shorter", "缩短当前音时值", "打谱输入", INPUT, "Mod+ArrowLeft"),
  action("input.longer", "延长当前音时值", "打谱输入", INPUT, "Mod+ArrowRight"),
  action("input.octaveUp", "当前音升八度", "打谱输入", INPUT, "Mod+ArrowUp"),
  action("input.octaveDown", "当前音降八度", "打谱输入", INPUT, "Mod+ArrowDown"),
  action("input.earlier", "当前音向前移动", "打谱输入", INPUT, "Alt+ArrowLeft"),
  action("input.later", "当前音向后移动", "打谱输入", INPUT, "Alt+ArrowRight"),
  action("input.partUp", "当前音移到上一声部", "打谱输入", INPUT, "Alt+ArrowUp"),
  action("input.partDown", "当前音移到下一声部", "打谱输入", INPUT, "Alt+ArrowDown"),
  ...Array.from({ length: 9 }, (_, n) => action(
    `voice.${n + 1}`, `分配到声部 V${n + 1}`, "声部", VOICE, `Alt+${n + 1}`)),
  action("page.zoomIn", "放大", "页面", GLOBAL, "Mod+Plus", "Mod+Shift+Plus"),
  action("page.zoomOut", "缩小", "页面", GLOBAL, "Mod+Minus"),
  action("page.zoomReset", "恢复 100%", "页面", GLOBAL, "Mod+0"),
  action("page.previous", "上一页", "页面", GLOBAL, "PageUp"),
  action("page.next", "下一页", "页面", GLOBAL, "PageDown"),
  action("page.first", "首页", "页面", GLOBAL, "Mod+Home"),
  action("page.last", "末页", "页面", GLOBAL, "Mod+End"),
];

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const linux = typeof navigator !== "undefined" && /Linux/.test(navigator.platform);
const cmBindings: KeyBinding[] = [...defaultKeymap, ...historyKeymap];

function keymapDefault(binding: KeyBinding): string | undefined {
  return mac ? binding.mac ?? binding.key : linux ? binding.linux ?? binding.key : binding.win ?? binding.key;
}

// Use declared keys rather than function.name: Vite minifies function names.
const TEXT_KEY_LABELS: Record<string, string> = {
  "Alt-ArrowLeft": "按语法向左移动光标", "Alt-ArrowRight": "按语法向右移动光标",
  "Alt-ArrowUp": "上移当前行", "Shift-Alt-ArrowUp": "向上复制当前行",
  "Alt-ArrowDown": "下移当前行", "Shift-Alt-ArrowDown": "向下复制当前行",
  "Mod-Alt-ArrowUp": "向上增加光标", "Mod-Alt-ArrowDown": "向下增加光标",
  Escape: "收起多重选择", "Mod-Enter": "在下方插入空行",
  "Alt-l": "选择当前行", "Mod-i": "选择父级语法结构",
  "Mod-[": "减少缩进", "Mod-]": "增加缩进", "Mod-Alt-\\": "整理选区缩进",
  "Shift-Mod-k": "删除当前行", "Shift-Mod-\\": "跳到匹配括号",
  "Mod-/": "切换注释", "Alt-A": "扩展语法选择", "Ctrl-m": "切换 Tab 焦点模式",
  ArrowLeft: "光标左移字符", "Mod-ArrowLeft": "光标左移词组", "Cmd-ArrowLeft": "光标移到行首",
  ArrowRight: "光标右移字符", "Mod-ArrowRight": "光标右移词组", "Cmd-ArrowRight": "光标移到行尾",
  ArrowUp: "光标上移一行", "Cmd-ArrowUp": "光标移到文档开头", "Ctrl-ArrowUp": "光标上移一页",
  ArrowDown: "光标下移一行", "Cmd-ArrowDown": "光标移到文档结尾", "Ctrl-ArrowDown": "光标下移一页",
  PageUp: "光标上移一页", PageDown: "光标下移一页",
  Home: "光标移到行首", "Mod-Home": "光标移到文档开头",
  End: "光标移到行尾", "Mod-End": "光标移到文档结尾",
  Enter: "文本换行", "Mod-a": "全选文本", Backspace: "向前删除字符", Delete: "向后删除字符",
  "Mod-Backspace": "向前删除词组", "Mod-Delete": "向后删除词组",
  "Ctrl-b": "光标左移字符", "Ctrl-f": "光标右移字符",
  "Ctrl-p": "光标上移一行", "Ctrl-n": "光标下移一行",
  "Ctrl-a": "光标移到行首", "Ctrl-e": "光标移到行尾",
  "Ctrl-d": "向后删除字符", "Ctrl-h": "向前删除字符",
  "Ctrl-k": "删除到行尾", "Ctrl-Alt-h": "向前删除词组",
  "Ctrl-o": "拆分当前行", "Ctrl-t": "交换相邻字符", "Ctrl-v": "光标下移一页",
};

/** Match CodeMirror's current platform bindings, including its less visible navigation commands. */
const textActions: ShortcutAction[] = cmBindings.flatMap((binding, index) => {
  const raw = keymapDefault(binding);
  if (!raw || raw.includes(" ")) return [];
  const chord = fromCodeMirrorKey(raw);
  if (!chord) return [];
  const label = index >= defaultKeymap.length
    ? ["撤销文本", "重做文本", "重做文本", "撤销选择", "重做选择"][index - defaultKeymap.length] ?? `文本操作 ${index}`
    : TEXT_KEY_LABELS[binding.key ?? binding.mac ?? binding.linux ?? raw] ?? `文本操作：${raw}`;
  const base: ShortcutAction = { id: `text.command.${index}`, label, category: "文本编辑",
    contexts: ["text"], defaults: [chord] };
  if (!binding.shift) return [base];
  const shiftChord = normalizeShortcutChord(`Shift+${chord}`);
  if (!shiftChord) return [base];
  const shiftLabel = raw === "Enter" ? "Shift+Enter 换行" : `扩展选择：${label}`;
  return [base, { id: `${base.id}.shift`, label: shiftLabel,
    category: "文本编辑", contexts: ["text"], defaults: [shiftChord] }];
});

export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [...scoreActions, ...textActions];
const byId = new Map(SHORTCUT_ACTIONS.map((item) => [item.id, item]));
const textById = new Map(textActions.map((item) => {
  const segments = item.id.split(".");
  const binding = cmBindings[Number(segments[2])];
  return [item.id, item.id.endsWith(".shift") ? binding.shift : binding.run] as const;
}));

export type ShortcutBindings = Record<string, string[]>;
let current: ShortcutBindings | null = null;

function fromCodeMirrorKey(raw: string): string | null {
  const parts = raw.split("-");
  const key = parts.pop();
  if (!key) return null;
  return formatChord({
    mod: parts.includes("Mod") || parts.includes("Cmd"),
    ctrl: parts.includes("Ctrl") && !(parts.includes("Mod") && !mac),
    alt: parts.includes("Alt"), shift: parts.includes("Shift"),
    key: key === " " ? "Space" : key,
  });
}

function canonicalKey(raw: string): string {
  if (raw === " " || raw === "Spacebar") return "Space";
  if (raw === "=" || raw === "+" || raw === "Plus") return "Plus";
  if (raw === "-" || raw === "Minus") return "Minus";
  if (/^Digit[0-9]$/.test(raw) || /^Numpad[0-9]$/.test(raw)) return raw[raw.length - 1];
  return raw.length === 1 ? raw.toLowerCase() : raw;
}

function formatChord(value: { mod: boolean; ctrl?: boolean; meta?: boolean; alt: boolean; shift: boolean; key: string }): string {
  const parts: string[] = [];
  if (value.mod) parts.push("Mod");
  if (value.ctrl) parts.push("Ctrl");
  if (value.meta) parts.push("Meta");
  if (value.alt) parts.push("Alt");
  if (value.shift) parts.push("Shift");
  parts.push(canonicalKey(value.key));
  return parts.join("+");
}

export function normalizeShortcutChord(raw: string): string | null {
  const parts = raw.split("+");
  const key = parts.pop();
  if (!key || key === "Unidentified") return null;
  const modifiers = new Set(parts);
  if (parts.some((part) => !["Mod", "Ctrl", "Meta", "Alt", "Shift"].includes(part))) return null;
  return formatChord({ mod: modifiers.has("Mod"), ctrl: modifiers.has("Ctrl"),
    meta: modifiers.has("Meta"), alt: modifiers.has("Alt"), shift: modifiers.has("Shift"), key });
}

/** Keep ordinary typing available in CodeMirror, including shifted symbols. */
export function shortcutBindingAllowed(actionId: string, chord: string): boolean {
  const item = byId.get(actionId);
  const normalized = normalizeShortcutChord(chord);
  if (!item || !normalized) return false;
  if (!item.contexts.includes("text")) return true;
  const parts = normalized.split("+");
  const key = parts.pop()!;
  if (parts.some((part) => part === "Mod" || part === "Ctrl" || part === "Meta" || part === "Alt")) return true;
  return key !== "Space" && key !== "Plus" && key !== "Minus"
    && key !== "Dead" && Array.from(key).length !== 1;
}

export function shortcutChordFromEvent(event: KeyboardEvent): string | null {
  if (event.isComposing || event.key === "Process" || event.getModifierState?.("AltGraph")) return null;
  if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return null;
  const key = /^(?:Digit|Numpad)[0-9]$/.test(event.code) && !event.shiftKey
    ? event.code[event.code.length - 1] : event.key;
  return formatChord({ mod: mac ? event.metaKey : event.ctrlKey,
    ctrl: mac && event.ctrlKey, meta: !mac && event.metaKey,
    alt: event.altKey, shift: event.shiftKey, key });
}

export function shortcutLabel(chord: string): string {
  return chord.replace(/^Mod(?=\+|$)/, mac ? "⌘" : "Ctrl")
    .replace(/\+Mod(?=\+|$)/g, mac ? "+⌘" : "+Ctrl")
    .replace(/Plus$/, "+").replace(/Minus$/, "−")
    .replace(/Space$/, "空格").replace(/ArrowLeft$/, "←")
    .replace(/ArrowRight$/, "→").replace(/ArrowUp$/, "↑")
    .replace(/ArrowDown$/, "↓");
}

export function defaultShortcutBindings(): ShortcutBindings {
  return Object.fromEntries(SHORTCUT_ACTIONS.map((item) => [item.id, [...item.defaults]]));
}

function validBindings(value: unknown): ShortcutBindings {
  const defaults = defaultShortcutBindings();
  if (!value || typeof value !== "object") return defaults;
  for (const [id, chords] of Object.entries(value)) {
    if (!byId.has(id) || !Array.isArray(chords) || chords.length > 4) continue;
    const normalized = chords.map((chord) => typeof chord === "string" ? normalizeShortcutChord(chord) : null);
    if (normalized.some((chord) => !chord || !shortcutBindingAllowed(id, chord))) continue;
    defaults[id] = [...new Set(normalized as string[])];
  }
  return defaults;
}

function activeBindings(): ShortcutBindings {
  if (current === null) {
    try { current = validBindings(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")); }
    catch { current = defaultShortcutBindings(); }
  }
  return current;
}

export function getShortcutBindings(): ShortcutBindings {
  return structuredClone(activeBindings());
}

export function saveShortcutBindings(bindings: ShortcutBindings): void {
  const next = validBindings(bindings);
  const conflicts = findShortcutConflicts(next);
  if (conflicts.length) throw new Error(`快捷键冲突：${conflicts[0].chord}`);
  current = next;
  const defaults = defaultShortcutBindings();
  const overrides = Object.fromEntries(Object.entries(next).filter(([id, chords]) =>
    JSON.stringify(chords) !== JSON.stringify(defaults[id])));
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides)); } catch { /* Session still uses edits. */ }
  document.dispatchEvent(new CustomEvent("shortcutchange"));
}

export interface ShortcutConflict { chord: string; first: ShortcutAction; second: ShortcutAction }

function overlap(a: ShortcutAction, b: ShortcutAction): boolean {
  if (a.contexts.some((context) => b.contexts.includes(context))) return true;
  // Page commands are active while the score has focus. Text navigation owns its own keys.
  return a.contexts.includes("global") && b.contexts.some((context) => context !== "text")
    || b.contexts.includes("global") && a.contexts.some((context) => context !== "text");
}

export function findShortcutConflicts(bindings: ShortcutBindings): ShortcutConflict[] {
  const conflicts: ShortcutConflict[] = [];
  for (let i = 0; i < SHORTCUT_ACTIONS.length; i++) {
    const first = SHORTCUT_ACTIONS[i];
    for (let j = i + 1; j < SHORTCUT_ACTIONS.length; j++) {
      const second = SHORTCUT_ACTIONS[j];
      if (!overlap(first, second)) continue;
      for (const chord of bindings[first.id] ?? []) {
        if ((bindings[second.id] ?? []).includes(chord)) conflicts.push({ chord, first, second });
      }
    }
  }
  return conflicts;
}

function activeIn(action: ShortcutAction, context: ShortcutContext): boolean {
  return action.contexts.includes(context);
}

function canonicalEvent(event: KeyboardEvent, chord: string): KeyboardEvent {
  const parts = chord.split("+");
  const keyName = parts.pop()!;
  const modifiers = new Set(parts);
  const key = keyName === "Space" ? " " : keyName === "Plus" ? "+"
    : keyName === "Minus" ? "-" : keyName;
  const code = /^[0-9]$/.test(key) ? `Digit${key}` : key;
  const override: Record<string, unknown> = {
    key, code,
    ctrlKey: modifiers.has("Ctrl") || modifiers.has("Mod") && !mac
      || modifiers.has("Mod") && (keyName === "Home" || keyName === "End"),
    metaKey: modifiers.has("Meta") || modifiers.has("Mod") && mac,
    altKey: modifiers.has("Alt"), shiftKey: modifiers.has("Shift"),
  };
  // Existing handlers call preventDefault/stopPropagation on the same physical event.
  return new Proxy(event, {
    get(target, property) {
      if (typeof property === "string" && property in override) return override[property];
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Translate a physical key to an existing score/global handler's original key.
 * null means a displaced default was deliberately swallowed. */
export function remapShortcutEvent(event: KeyboardEvent, context: ShortcutContext): KeyboardEvent | null {
  const chord = shortcutChordFromEvent(event);
  if (!chord) return event;
  const bindings = activeBindings();
  const actions = scoreActions.filter((item) => activeIn(item, context));
  const matching = actions.find((item) => bindings[item.id]?.includes(chord));
  if (matching) return canonicalEvent(event, matching.defaults[0]);
  if (context !== "global" && context !== "text"
    && scoreActions.some((item) => item.contexts.includes("global") && bindings[item.id]?.includes(chord))) {
    // Let the original physical event bubble to the window-level page handler,
    // while presenting a neutral key to the score handler's old loose checks.
    return canonicalEvent(event, "F24");
  }
  if (actions.some((item) => item.defaults.includes(chord))) {
    event.preventDefault();
    event.stopPropagation();
    return null;
  }
  return event;
}

/** Run customizable CodeMirror keys before its static default keymap extension. */
export function handleTextShortcut(
  event: KeyboardEvent,
  view: EditorView,
  beforeCommand?: (canonicalEvent: KeyboardEvent) => boolean,
): boolean {
  const chord = shortcutChordFromEvent(event);
  if (!chord) return false;
  const bindings = activeBindings();
  const matched = textActions.find((item) => bindings[item.id]?.includes(chord));
  if (matched) {
    const command = textById.get(matched.id);
    if (!command) return false;
    event.preventDefault();
    event.stopPropagation();
    if (beforeCommand?.(canonicalEvent(event, matched.defaults[0]))) return true;
    command(view);
    return true;
  }
  // A text command's displaced default can be reassigned to a voice command
  // in this same context. Let the caller's voice dispatcher receive it.
  if (scoreActions.some((item) => activeIn(item, "text") && bindings[item.id]?.includes(chord))) return false;
  if (textActions.some((item) => item.defaults.includes(chord))) {
    event.preventDefault();
    event.stopPropagation();
    return true;
  }
  return false;
}
