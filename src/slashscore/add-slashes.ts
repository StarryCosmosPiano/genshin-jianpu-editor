import { buildTimeline } from "../score/timeline";
import { MusicCommon } from "../score/score";
import {
  defaultSlashScoreOptions, hasSlashScoreLines, parseSlashScore, SLASH_VOICE_SEPARATOR, slashUsesBareChords,
  type SlashDurationDivision, type SlashScoreKind, type SlashScoreOptions,
} from "./index";

/** Source settings are deliberately separate from the explicit output settings. */
export interface AddSlashesOptions {
  kind?: SlashScoreKind;
  beats?: number | null;
  beatType?: number;
  symbolDurations?: Record<string, SlashDurationDivision>;
  noteDivision?: SlashDurationDivision | null;
  spaceDivision?: SlashDurationDivision | null;
  adjacentAsChord?: boolean;
  /** Numeric notation normally reserves +/- for octave prefixes. */
  numberPlusMinusAsDurations?: boolean;
}
export interface AddSlashesLineStat { line: number; quarterNotes: number; attacks: number }
export interface AddSlashesDurationCandidate {
  id: string;
  symbolDurations: Record<string, SlashDurationDivision>;
  noteDivision: SlashDurationDivision | null;
  adjacentAsChord: boolean;
  /** Ranking evidence, not a probability that this interpretation is correct. */
  score: number;
  reasons: string[];
}
export interface AddSlashesMeterCandidate {
  beats: number; beatType: number; score: number; reasons: string[];
}
export interface AddSlashesAnalysis {
  detected: boolean; hasExistingSlashes: boolean; kind: SlashScoreKind;
  observedSymbols: string[]; hasParentheses: boolean;
  lineStats: AddSlashesLineStat[];
  durationCandidates: AddSlashesDurationCandidate[];
  meterCandidates: AddSlashesMeterCandidate[];
  warnings: string[]; errors: string[];
}
export interface AddSlashesResult {
  text: string; options: SlashScoreOptions; canImport: boolean;
  lineStats: AddSlashesLineStat[]; warnings: string[]; errors: string[];
}
export interface SourceTimedRowsReencoding {
  text: string; options: SlashScoreOptions; canImport: boolean;
  warnings: string[]; errors: string[];
}

const DIVISIONS: SlashDurationDivision[] = [4, 8, 16, 32, 64];
const KEYS = ["ZXCVBNM", "ASDFGHJ", "QWERTYU"];
const STEPS = [0, 2, 4, 5, 7, 9, 11];
const EPS = 1e-8;
interface Atom {
  pitches: string[]; pitchOffsets: number[][]; pitchEnds: number[];
  symbols: string[]; symbolOffsets: number[]; explicitChord: boolean; rest: boolean;
  from: number; pitchTo: number;
}
interface Row {
  line: number; raw: string; from: number; code: string; codeTo: number;
  atoms: Atom[]; comment: string; score: boolean;
}
interface Source { rows: Row[]; kind: SlashScoreKind; observedSymbols: string[]; hasParentheses: boolean; errors: string[]; warnings: string[]; existing: boolean }
interface Event { token: string; tokenOffsets: number[]; pitches: number[]; duration: number; line: number; rest: boolean }

function normalizedSymbols(options: AddSlashesOptions): Record<string, SlashDurationDivision> {
  const result = {} as Record<string, SlashDurationDivision>;
  for (const [symbol, division] of Object.entries(options.symbolDurations ?? {})) {
    if (symbol === "\t") continue;
    result[symbol === "＋" ? "+" : symbol] = division;
  }
  if (options.spaceDivision) result[" "] = options.spaceDivision;
  return result;
}
function normalizeLine(line: string): string { return line.replace(/＋/g, "+").replace(/（/g, "(").replace(/）/g, ")"); }
function isWholeMultiple(value: number, unit: number): boolean {
  return value > EPS && Math.abs(value / unit - Math.round(value / unit)) < EPS;
}
function source(text: string, options: AddSlashesOptions, allowSlashes = false): Source {
  const mappings = normalizedSymbols(options);
  const rawRows = text.split(/\r\n|\r|\n/);
  let rawOffset = 0;
  let keyboard = 0; let number = 0;
  const candidates = rawRows.map((raw, index) => {
    const normalized = normalizeLine(raw);
    const split = /(?:^\/\/|\s\/\/|[;；])/.exec(normalized);
    const rawEnd = split ? split.index : normalized.length;
    const chars = normalized.slice(0, rawEnd).split("").map((char, at) => ({ char, at: rawOffset + at }))
      .filter((item) => !allowSlashes || item.char !== "/");
    while (chars.length && /\s/.test(chars[0].char)) chars.shift();
    while (chars.length && /\s/.test(chars[chars.length - 1].char)) chars.pop();
    const code = chars.map((item) => item.char).join("");
    const charOffsets = chars.map((item) => item.at);
    const from = rawOffset; const codeTo = chars.length ? chars[chars.length - 1].at + 1 : from;
    rawOffset += raw.length;
    rawOffset += text[rawOffset] === "\r" && text[rawOffset + 1] === "\n" ? 2 : /[\r\n]/.test(text[rawOffset] ?? "") ? 1 : 0;
    const comment = split ? normalized.slice(split.index) : "";
    const metadata = !code || /[\u3400-\u9fff]/.test(code)
      || /^(?:END|INTRO|OUTRO|CHORUS|VERSE|BRIDGE|TITLE|TEMPO)$/i.test(code)
      || /^\d+(?:\.\d+)?$/.test(code) || /^\d+\s*\/\s*\d+/.test(code);
    const punctuation = Array.from(code).filter((char) => char !== SLASH_VOICE_SEPARATOR && !/[\sZXCVBNMASDFGHJQWERTYU0-7#b♭♯(),'\[\]{}<>|/]/.test(char));
    const hasDuration = punctuation.length > 0 || /[+-]/.test(code);
    const keyCount = (code.match(/[ZXCVBNMASDFGHJQWERTYU]/g) ?? []).length;
    const numCount = (code.match(/[0-7]/g) ?? []).length;
    const allowed = Array.from(code).every((char) => !/[A-Za-z0-9]/.test(char) || /[ZXCVBNMASDFGHJQWERTYU0-7b]/.test(char));
    const invalidScoreShape = !allowed && hasDuration && /^[A-Z0-9#b♭♯\s(),'()\[\]{}<>|+\-=.?!_*~:·]+$/.test(code);
    const rhythmic = !metadata && (allowed || invalidScoreShape) && (hasDuration || /[()]/.test(code)) && (keyCount > 0 || numCount > 0);
    if (rhythmic) { keyboard += keyCount; number += numCount; }
    return { line: index + 1, raw, from, codeTo, code, charOffsets, comment, metadata, allowed, rhythmic, keyCount, numCount };
  });
  const kind = options.kind ?? (number > keyboard ? "number" : "keyboard");
  const existing = !allowSlashes && (hasSlashScoreLines(candidates.map((row) => row.code).join("\n"), kind)
    || rawRows.some((row) => /^\/+[ZXCVBNMASDFGHJQWERTYU1-7].*\//.test(row.trim())));
  const errors: string[] = []; const warnings: string[] = [];
  const observed = new Set<string>(); let hasParentheses = false;
  const firstRhythmic = candidates.findIndex((row) => row.rhythmic);
  const rows: Row[] = candidates.map((row, index) => {
    // A bare run in a score body may be an unfinished chord. Do not silently
    // discard it as a heading; users can explicitly comment ambiguous prose.
    const bareInBody = !row.metadata && row.allowed && (row.keyCount + row.numCount > 0)
      && (index > firstRhythmic && firstRhythmic >= 0 || options.noteDivision != null);
    const score = !row.code.includes("/") && (row.rhythmic || bareInBody);
    const record: Row = { line: row.line, raw: row.raw, from: row.from, code: row.code,
      codeTo: row.codeTo, atoms: [], comment: row.comment, score };
    if (!score) {
      if (!row.metadata && row.allowed && row.keyCount > 0 && index < firstRhythmic) {
        warnings.push(`第 ${row.line} 行全字母文本暂按标题保留；若是音符，请补时值符号。`);
      }
      return record;
    }
    if (!row.allowed) {
      errors.push(`第 ${row.line} 行含无效键名或音级，请修正；若是英文说明，请在前面加 //。`);
      return record;
    }
    if (kind === "keyboard" && row.numCount > 0 && /[1-7]/.test(row.code)
      || kind === "number" && row.keyCount > 0) {
      errors.push(`第 ${row.line} 行混合了键盘键名与数字音级，请明确谱种后修正。`);
      return record;
    }
    hasParentheses ||= /[()]/.test(row.code);
    if (/[\[\]{}<>|]/.test(row.code)) {
      errors.push(`第 ${row.line} 行含特殊括号，请先明确其用途；添加斜杠不会自动猜测三连音、装饰音或琶音。`);
      return record;
    }
    if (kind === "number" && /[+-]/.test(row.code) && !options.numberPlusMinusAsDurations) {
      errors.push(`第 ${row.line} 行数字谱的 +、- 可能表示八度；请明确启用“+、- 作为时值”或改用其他时值符号。`);
      return record;
    }
    let cursor = 0;
    const pitch = (): string | null => {
      const regex = kind === "keyboard" ? /^\u2063*(?:0|[#b♭♯]?[,'']*[ZXCVBNMASDFGHJQWERTYU])/ : /^\u2063*[#b♭♯]?[0-7]/;
      const match = regex.exec(row.code.slice(cursor));
      if (!match) return null;
      cursor += match[0].length; return match[0];
    };
    while (cursor < row.code.length) {
      if (/\s/.test(row.code[cursor])) {
        const previous = record.atoms[record.atoms.length - 1];
        if (row.code[cursor] === " " && options.spaceDivision && previous) {
          previous.symbols.push(" "); previous.symbolOffsets.push(row.charOffsets[cursor]);
        }
        cursor++; continue;
      }
      const currentChar = String.fromCodePoint(row.code.codePointAt(cursor)!);
      if (mappings[currentChar] !== undefined || /[+\-=]/.test(currentChar)
        || currentChar !== SLASH_VOICE_SEPARATOR && !/[ZXCVBNMASDFGHJQWERTYU0-7#b♭♯(),'()\s]/.test(currentChar)) {
        const symbolOffset = row.charOffsets[cursor]; const char = currentChar; cursor += char.length; observed.add(char);
        if (mappings[char] === undefined) errors.push(`第 ${row.line} 行时值符号 ${char} 尚未指定时值。`);
        const previous = record.atoms[record.atoms.length - 1];
        if (previous) { previous.symbols.push(char); previous.symbolOffsets.push(symbolOffset); }
        else record.atoms.push({ pitches: [], pitchOffsets: [], pitchEnds: [], symbols: [char],
          symbolOffsets: [symbolOffset], explicitChord: false, rest: false, from: symbolOffset, pitchTo: symbolOffset });
        continue;
      }
      const from = row.charOffsets[cursor]; const explicitChord = row.code[cursor] === "(";
      if (explicitChord) cursor++;
      const pitches: string[] = []; const pitchOffsets: number[][] = []; const pitchEnds: number[] = [];
      const innerSpaces: number[] = [];
      let closed = !explicitChord;
      while (cursor < row.code.length) {
        if (explicitChord && /\s/.test(row.code[cursor])) {
          if (row.code[cursor] === " " && options.spaceDivision) innerSpaces.push(row.charOffsets[cursor]);
          cursor++; continue;
        }
        if (explicitChord && row.code[cursor] === ")") { cursor++; closed = true; break; }
        const pitchFrom = cursor; const value = pitch();
        if (!value) break;
        pitches.push(value);
        pitchOffsets.push(row.charOffsets.slice(pitchFrom, cursor));
        pitchEnds.push(row.charOffsets[cursor - 1] + 1);
      }
      if (!closed) {
        errors.push(`第 ${row.line} 行括号未闭合，或括号内部含时值/嵌套内容；请先整理成明确的 (和弦)。`);
        break;
      }
      if (pitches.length === 0) {
        errors.push(`第 ${row.line} 行的 ${row.code[cursor] ?? "空括号"} 不能解释为音符或时值。`);
        break;
      }
      if (pitches.some((value) => value.replace(/\u2063/g, "") === "0") && pitches.length > 1) {
        errors.push(`第 ${row.line} 行休止符 0 与和弦音连写，请将它们分开。`);
      }
      record.atoms.push({ pitches, pitchOffsets, pitchEnds, symbols: innerSpaces.map(() => " "), symbolOffsets: innerSpaces,
        explicitChord, rest: pitches[0].replace(/\u2063/g, "") === "0", from, pitchTo: row.charOffsets[cursor - 1] + 1 });
    }
    return record;
  });
  if (existing) errors.unshift("文本已有斜杠谱，不能重复添加；请使用原有导入方式。");
  return { rows, kind, observedSymbols: [...observed], hasParentheses, errors: [...new Set(errors)], warnings, existing };
}

function pitchValue(token: string, kind: SlashScoreKind): number {
  token = token.replace(/\u2063/g, "");
  let accidental = 0; let index = 0;
  if (/[#♯]/.test(token[index] ?? "")) { accidental = 1; index++; }
  else if (/[b♭]/.test(token[index] ?? "")) { accidental = -1; index++; }
  let extra = 0;
  while (token[index] === "'" || token[index] === ",") { extra += token[index] === "'" ? 1 : -1; index++; }
  const tonic = MusicCommon.getBasePitch("C");
  if (kind === "number") return tonic + STEPS[Number(token[index]) - 1] + accidental;
  for (const [row, keys] of KEYS.entries()) {
    const degree = keys.indexOf(token[index]);
    if (degree >= 0) return tonic + STEPS[degree] + (row - 1 + extra) * 12 + accidental;
  }
  throw new Error(`不能解释音符 ${token}`);
}
function eventData(src: Source, options: AddSlashesOptions): { events: Event[]; lineStats: AddSlashesLineStat[]; errors: string[] } {
  const mappings = normalizedSymbols(options);
  const intrinsic = options.noteDivision ? 4 / options.noteDivision : 0;
  const adjacentAsChord = options.adjacentAsChord ?? true;
  const events: Event[] = []; const lineStats: AddSlashesLineStat[] = []; const errors: string[] = [];
  for (const row of src.rows.filter((candidate) => candidate.score)) {
    let quarterNotes = 0; let attacks = 0;
    for (const atom of row.atoms) {
      const markerDuration = atom.symbols.reduce((total, symbol) => total + (mappings[symbol] ? 4 / mappings[symbol] : 0), 0);
      if (atom.pitches.length === 0) {
        const previous = events[events.length - 1];
        if (previous) previous.duration += markerDuration;
        else errors.push(`第 ${row.line} 行前置时值符号没有上一音可延续，请明确休止或补上音符。`);
        quarterNotes += markerDuration;
        continue;
      }
      const indexed = atom.pitches.map((value, index) => ({ value, offsets: atom.pitchOffsets[index] }));
      const groups = atom.explicitChord || adjacentAsChord || atom.rest ? [indexed] : indexed.map((value) => [value]);
      groups.forEach((group, index) => {
        const duration = intrinsic + (index === groups.length - 1 ? markerDuration : 0);
        if (duration <= EPS) errors.push(`第 ${row.line} 行音符 ${group.map((item) => item.value).join("")} 没有时值；请补符号或指定音符自身时值。`);
        const rest = group[0].value.replace(/\u2063/g, "") === "0";
        const spelling = new Map<string, { value: string; offsets: number[]; pitch: number }>();
        if (!rest) for (const item of group) {
          const valuePitch = pitchValue(item.value, src.kind);
          const key = `${valuePitch}:${item.value.match(/^\u2063*/)?.[0].length ?? 0}`;
          if (!spelling.has(key)) spelling.set(key, { ...item, pitch: valuePitch });
        }
        const unique = rest ? [group[0]] : [...spelling.values()];
        const token = unique.length > 1 ? `(${unique.map((item) => item.value).join("")})` : unique[0].value;
        const tokenOffsets = unique.length > 1 ? [-1, ...unique.flatMap((item) => item.offsets), -1] : unique[0].offsets;
        const pitches = [...spelling.values()].map((item) => item.pitch).sort((a, b) => a - b);
        events.push({ token, tokenOffsets, pitches, duration, line: row.line, rest });
        quarterNotes += duration; attacks += rest ? 0 : 1;
      });
    }
    lineStats.push({ line: row.line, quarterNotes, attacks });
  }
  return { events, lineStats, errors: [...new Set(errors)] };
}

function rowEvidence(stats: AddSlashesLineStat[], length: number): { matched: number; ratio: number; typical: number; exact: number; exactRatio: number; multiplePenalty: number } {
  const useful = stats.filter((row) => row.quarterNotes > EPS);
  const matched = useful.filter((row) => isWholeMultiple(row.quarterNotes, length)).length;
  const full = useful.filter((row) => isWholeMultiple(row.quarterNotes, length));
  const counts = new Map<number, number>();
  for (const row of full) { const count = Math.round(row.quarterNotes / length); counts.set(count, (counts.get(count) ?? 0) + 1); }
  const typical = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0;
  const exact = useful.filter((row) => Math.abs(row.quarterNotes - length) < EPS).length;
  const multiplePenalty = full.reduce((sum, row) => sum + Math.max(0, row.quarterNotes / length - 1), 0) / Math.max(1, stats.length);
  return { matched, ratio: stats.length ? matched / stats.length : 0, typical,
    exact, exactRatio: stats.length ? exact / stats.length : 0, multiplePenalty };
}
export function analyzeAddSlashes(text: string, options: AddSlashesOptions = {}): AddSlashesAnalysis {
  const src = source(text, options); const current = eventData(src, options);
  const warnings = [...src.warnings]; const errors = [...src.errors, ...current.errors];
  const durationCandidates: AddSlashesDurationCandidate[] = [];
  const meterCandidates: AddSlashesMeterCandidate[] = [];
  const knownMeter = options.beats != null && options.beats > 0;
  const baseMappings = normalizedSymbols(options);
  const baseline = options.noteDivision ?? null;
  // The symbol names carry no rhythmic prior. Prefer a source row being one
  // measure; an interpretation needing multiple measures is weaker evidence.
  const sourceRows = src.rows.filter((row) => row.score);
  const ownCandidates: Array<SlashDurationDivision | null> = baseline !== null ? [baseline]
    : src.hasParentheses ? [null, 8, 16, 4, 32, 64] : [null];
  const unknown = src.observedSymbols.filter((symbol) => baseMappings[symbol] === undefined);
  if (src.observedSymbols.length > 3) warnings.push("正文时值符号超过三个；仅枚举前三个，请手动填写其余符号。 ");
  const enumerateMappings = (initial: Record<string, SlashDurationDivision>): Array<Record<string, SlashDurationDivision>> => {
    let variants = [initial];
    for (const symbol of src.observedSymbols.slice(0, 3)) variants = variants.flatMap((variant) => DIVISIONS.map((division) => ({ ...variant, [symbol]: division })));
    return variants;
  };
  const chordCandidates = src.hasParentheses && options.adjacentAsChord === undefined ? [false, true] : [options.adjacentAsChord ?? true];
  if (knownMeter) {
    for (const candidateMappings of enumerateMappings(baseMappings)) for (const own of ownCandidates) for (const adjacentAsChord of chordCandidates) {
      const data = eventData(src, { ...options, adjacentAsChord, symbolDurations: candidateMappings, noteDivision: own });
      const evidence = rowEvidence(data.lineStats, options.beats! * 4 / (options.beatType ?? 4));
      const unmapped = src.observedSymbols.some((symbol) => candidateMappings[symbol] === undefined);
      const score = Math.max(0, evidence.exactRatio * 0.88 + evidence.ratio * 0.08
        + (own === baseline ? 0.025 : 0) + (adjacentAsChord ? 0.005 : 0)
        - Math.min(0.15, evidence.multiplePenalty * 0.025) - (data.errors.length > 0 || unmapped ? 0.4 : 0));
      const reasons = [`${evidence.exact}/${data.lineStats.length} 个原文行恰好一小节，优先按一行一小节核对。`,
        `${evidence.matched - evidence.exact} 行需要多个小节；符号值从正文组合试算，不预设符号名字的含义。`];
      if (own !== null) reasons.push(`假设每个音符/和弦另有 ${own} 分音符自身时值；括号本身不能证明此假设。`);
      if (!adjacentAsChord) reasons.push("括号内仍为和弦；括号外连写键名按逐音解释。 ");
      if (unknown.length) reasons.push("未映射符号采用有限组合试算；请核对候选的符号值后采纳。 ");
      if (data.errors.length) reasons.push("仍有缺时值音符，需要手动修正。");
      reasons.push("行长只约束总时值，不能唯一证明每个符号或拍号。");
      durationCandidates.push({ id: `${own ?? "none"}:${adjacentAsChord}:${src.observedSymbols.map((symbol) => candidateMappings[symbol]).join(",")}`, symbolDurations: candidateMappings, noteDivision: own, adjacentAsChord, score, reasons });
    }
  }
  durationCandidates.sort((a, b) => b.score - a.score);
  if (durationCandidates.length && durationCandidates[0].score <= 0) {
    durationCandidates.length = 0;
    warnings.push("当前拍号无法给出可信的一行一小节候选；请手动指定时值或核对拍号，不会自动采纳任意符号值。 ");
  }
  durationCandidates.splice(24);
  if (!knownMeter && unknown.length > 0) warnings.push("拍号留空时，请先手动指定正文符号时值，再根据行长查看拍号候选。 ");
  if (!knownMeter && unknown.length === 0 && current.lineStats.length > 0) {
    for (const [beats, beatType] of [[4, 4], [3, 4], [2, 4], [6, 8], [9, 8], [12, 8], [3, 8], [2, 2]]) {
      const length = beats * 4 / beatType; const evidence = rowEvidence(current.lineStats, length);
      if (evidence.matched === 0) continue;
      const score = evidence.exactRatio * 0.8 + evidence.ratio * 0.1 + (beats === 4 && beatType === 4 ? 0.025 : 0.01) - Math.min(0.1, evidence.multiplePenalty * 0.025);
      meterCandidates.push({ beats, beatType, score: Math.min(1, score), reasons: [
        `${evidence.exact}/${current.lineStats.length} 个原文行恰好一小节；${evidence.matched - evidence.exact} 行需多个小节。`,
        "这是行长与时值的相容性，重音与音乐结构仍须人工确认。",
      ] });
    }
    meterCandidates.sort((a, b) => b.score - a.score);
    if (meterCandidates.length > 1) warnings.push("当前时值符合多个拍号，无法仅靠行长确定唯一拍号。");
  }
  if (src.hasParentheses) warnings.push("括号可明确和弦，但不能单独证明音符是否另有自身时值；候选需核对。 ");
  if (!sourceRows.length && !src.existing) errors.push("没有找到带时值的键盘谱或数字谱正文。");
  return { detected: sourceRows.length > 0 && !src.existing, hasExistingSlashes: src.existing, kind: src.kind,
    observedSymbols: src.observedSymbols, hasParentheses: src.hasParentheses, lineStats: current.lineStats,
    durationCandidates, meterCandidates, warnings: [...new Set(warnings)], errors: [...new Set(errors)] };
}

function durationAlphabet(mappings: Record<string, SlashDurationDivision>, finest: number): { mappings: Record<string, SlashDurationDivision>; symbols: Map<number, string>; safeSymbols: Map<number, string> } {
  const result = { ...mappings }; const symbols = new Map<number, string>(); const safeSymbols = new Map<number, string>();
  // '-' is the parser's historical whole-beat rest shortcut when alone.
  // Never emit it in a duration-only continuation; use a safe alias instead.
  for (const [symbol, division] of Object.entries(result)) {
    if (/^[+\-.=*_~:·]$/.test(symbol) && !symbols.has(division)) symbols.set(division, symbol);
    if (/^[.=*_~:·]$/.test(symbol) && !safeSymbols.has(division)) safeSymbols.set(division, symbol);
  }
  const spare = [".", "_", "~", ":", "*", "·"];
  for (const division of DIVISIONS) {
    if (division > finest) continue;
    if (safeSymbols.has(division)) continue;
    const alias = spare.find((symbol) => result[symbol] === undefined);
    if (!alias) throw new Error("时值符号不足，请减少自定义符号后重试。");
    result[alias] = division; safeSymbols.set(division, alias);
    if (!symbols.has(division)) symbols.set(division, alias);
  }
  return { mappings: result, symbols, safeSymbols };
}

/** Re-spell fixed first-step durations with the second-step alphabet.
 * Always call this with the immutable first-step text/settings, never the
 * previous preview. Slashes, pitch spelling, comments and line breaks retain
 * their original positions relative to the surrounding source characters.
 */
export function reencodeSourceTimedRows(
  text: string, sourceOptions: SlashScoreOptions, targetOptions: SlashScoreOptions,
): SourceTimedRowsReencoding {
  const active = Object.entries(targetOptions.symbolDurations)
    .filter(([symbol]) => symbol !== " ");
  const configuredAlphabet = (targetOptions.multiDurationSymbols === false ? active.slice(0, 1) : active)
    .map(([symbol, division]) => ({ symbol: symbol === "＋" ? "+" : symbol, division, unit: 4 / division }));
  const alphabet = [...configuredAlphabet].sort((a, b) => b.unit - a.unit);
  const options: SlashScoreOptions = { ...targetOptions,
    symbolDurations: Object.fromEntries(configuredAlphabet.map(({ symbol, division }) => [symbol, division])),
    sourceTimedRows: true, adjacentAsChord: sourceOptions.adjacentAsChord ?? true,
  };
  const warnings: string[] = []; const errors: string[] = [];
  const result = (output: string): SourceTimedRowsReencoding => ({
    text: output, options, canImport: errors.length === 0, warnings, errors: [...new Set(errors)],
  });
  const sourceSettings: AddSlashesOptions = { kind: sourceOptions.kind,
    symbolDurations: sourceOptions.symbolDurations, noteDivision: sourceOptions.noteDivision,
    spaceDivision: sourceOptions.spaceDivision, adjacentAsChord: options.adjacentAsChord,
    numberPlusMinusAsDurations: true,
  };
  const src = source(text, sourceSettings, true);
  const before = eventData(src, sourceSettings);
  errors.push(...src.errors, ...before.errors);
  if (sourceOptions.kind !== options.kind) errors.push("请保留第一步的谱种后修改时值符号。");
  if (src.hasParentheses && (options.parenMode ?? "chord") !== "chord") {
    errors.push("请将圆括号设为和弦，才能保留第一步已确认的音长。");
  }
  if (alphabet.some(({ symbol, division }) => Array.from(symbol).length !== 1
    || !DIVISIONS.includes(division)
    || /[\sA-Za-z0-9#b♭♯(),'\[\]{}<>|/;；]/.test(symbol)
    || symbol === SLASH_VOICE_SEPARATOR)) {
    errors.push("时值符号须为单个非音符、非分隔符字符。");
  }
  if (errors.length) return result(text);
  const sourceMapping = normalizedSymbols(sourceSettings);
  const unchanged = (sourceOptions.noteDivision ?? null) === (options.noteDivision ?? null)
    && (sourceOptions.spaceDivision ?? null) === (options.spaceDivision ?? null)
    && src.observedSymbols.every((symbol) => options.symbolDurations[symbol] === sourceMapping[symbol]);
  if (unchanged) return result(text);

  const sourceIntrinsic = sourceOptions.noteDivision ? 4 / sourceOptions.noteDivision : 0;
  const targetIntrinsic = options.noteDivision ? 4 / options.noteDivision : 0;
  const targetSpaceRows = source(text, { ...sourceSettings, spaceDivision: options.spaceDivision }, true);
  const edits: Array<{ from: number; to: number; text: string }> = [];
  const requiredDivision = (duration: number): number =>
    DIVISIONS.find((division) => Math.abs(duration / (4 / division) - Math.round(duration / (4 / division))) < EPS) ?? 64;
  const encode = (duration: number): string | null => {
    if (duration < -EPS) return null;
    let remaining = duration; let value = "";
    for (const { symbol, unit } of alphabet) {
      const count = Math.floor((remaining + EPS) / unit);
      if (count > 0) { value += symbol.repeat(count); remaining -= count * unit; }
    }
    return Math.abs(remaining) <= EPS ? value : null;
  };
  let finestRequired = 0; let firstCoarseLine = 0; let firstExcessLine = 0;
  const issue = (line: number, duration: number): void => {
    if (duration < -EPS) firstExcessLine ||= line;
    else {
      firstCoarseLine ||= line;
      finestRequired = Math.max(finestRequired, requiredDivision(duration));
    }
  };
  for (const row of src.rows.filter((item) => item.score)) {
    const targetRow = targetSpaceRows.rows.find((item) => item.line === row.line)!;
    for (const [atomIndex, atom] of row.atoms.entries()) {
      const targetAtom = targetRow.atoms[atomIndex];
      const sourceDuration = atom.symbols.reduce((sum, symbol) => sum + 4 / sourceMapping[symbol], 0);
      const targetSpaces = targetAtom.symbols.filter((symbol) => symbol === " ").length;
      const targetSpaceDuration = options.spaceDivision ? targetSpaces * 4 / options.spaceDivision : 0;
      const symbolEntries = atom.symbols.flatMap((symbol, index) => symbol === " " ? [] : [{ symbol, at: atom.symbolOffsets[index] }]);
      // A direct per-character spelling keeps each existing slash between the
      // same source duration pieces whenever that spelling is exact.
      if (sourceIntrinsic === targetIntrinsic && (sourceOptions.spaceDivision ?? null) === (options.spaceDivision ?? null)) {
        const converted = symbolEntries.map(({ symbol }) => encode(4 / sourceMapping[symbol]));
        if (converted.every((value) => value !== null)) {
          symbolEntries.forEach(({ symbol, at }, index) => edits.push({ from: at, to: at + symbol.length, text: converted[index]! }));
          continue;
        }
      }
      const groups = atom.explicitChord || options.adjacentAsChord || atom.rest ? 1 : atom.pitches.length;
      for (let index = 0; index < Math.max(1, groups); index++) {
        const last = index === Math.max(1, groups) - 1;
        const hasPitch = atom.pitches.length > 0;
        const duration = (hasPitch ? sourceIntrinsic - targetIntrinsic : 0)
          + (last ? sourceDuration - targetSpaceDuration : 0);
        const encoded = encode(duration);
        if (encoded === null) { issue(row.line, duration); continue; }
        let spelling = encoded;
        if (!last) {
          const at = atom.pitchEnds[index]; edits.push({ from: at, to: at, text: spelling });
        } else {
          const nextAtom = row.atoms[atomIndex + 1];
          if (!spelling && hasPitch && !atom.explicitChord && nextAtom?.pitches.length
            && !nextAtom.explicitChord
            && !/\s/.test(text.slice(atom.pitchTo, nextAtom.from))) spelling = "\t";
          symbolEntries.forEach(({ symbol, at }, entryIndex) => edits.push({
            from: at, to: at + symbol.length, text: entryIndex === symbolEntries.length - 1 ? spelling : "",
          }));
          if (!symbolEntries.length && spelling) {
            const at = atom.pitchTo; edits.push({ from: at, to: at, text: spelling });
          }
        }
      }
    }
  }
  if (firstExcessLine) errors.push(`第 ${firstExcessLine} 行音符自身时值或空格时值超过原音长，请调小或留空。`);
  if (finestRequired) errors.push(`原谱时值无法精确换写（从第 ${firstCoarseLine} 行起），请将时值符号改为至少 ${finestRequired} 分音符。`);
  if (errors.length) return result(text);
  let output = text;
  for (const edit of edits.sort((a, b) => b.from - a.from || b.to - a.to)) {
    output = output.slice(0, edit.from) + edit.text + output.slice(edit.to);
  }
  // Compare source events directly: changing key, title or meter in step two
  // must not turn a legitimate timing conversion into a pitch mismatch.
  const afterSource = source(output, { ...sourceSettings, symbolDurations: options.symbolDurations,
    noteDivision: options.noteDivision, spaceDivision: options.spaceDivision }, true);
  const after = eventData(afterSource, { ...sourceSettings, symbolDurations: options.symbolDurations,
    noteDivision: options.noteDivision, spaceDivision: options.spaceDivision });
  if (afterSource.errors.length || after.errors.length || before.events.length !== after.events.length
    || before.events.some((event, index) => Math.abs(event.duration - (after.events[index]?.duration ?? -1)) > EPS
      || event.token !== after.events[index]?.token)) {
    errors.push("当前音符自身时值、空格或符号组合无法保留原音长，请调整时值设置。");
    return result(text);
  }
  return result(output);
}

/** Internal-only projection. User text is never replaced by this grammar. */
export function projectSourceTimedRows(text: string, base: SlashScoreOptions): {
  text: string; options: SlashScoreOptions; sourceOffsets: number[];
} {
  const adjacentAsChord = slashUsesBareChords(base) ? true : base.adjacentAsChord ?? true;
  const src = source(text, {
    kind: base.kind, symbolDurations: base.symbolDurations,
    noteDivision: base.noteDivision, adjacentAsChord,
    spaceDivision: base.spaceDivision,
    numberPlusMinusAsDurations: true,
  }, true);
  const data = eventData(src, {
    kind: base.kind, symbolDurations: base.symbolDurations,
    noteDivision: base.noteDivision, adjacentAsChord,
    spaceDivision: base.spaceDivision,
  });
  const problems = [...src.errors, ...data.errors];
  if (src.hasParentheses && (base.parenMode ?? "chord") !== "chord") {
    problems.push("添加斜杠目前按圆括号表示和弦。请将“圆括号 ()”设为“和弦”后继续导入。");
  }
  if (problems.length) throw new Error([...new Set(problems)].join("；"));
  const options: SlashScoreOptions = {
    ...base, symbolDurations: { ...base.symbolDurations }, sourceTimedRows: false,
    noteDivision: null, spaceDivision: null, multiDurationSymbols: true,
    wholeMeasureGroups: false, parenMode: "chord", braceMode: "none",
    bracketMode: "none", angleMode: "none", barMode: "none",
  };
  const finest = Math.max(4, base.noteDivision ?? 4, base.spaceDivision ?? 4, base.beatType, ...Object.values(base.symbolDurations));
  const alphabet = durationAlphabet(options.symbolDurations, finest);
  options.symbolDurations = alphabet.mappings;
  const measureLength = options.beats * 4 / options.beatType;
  const groupLength = options.beatType === 8 && options.beats >= 6 && options.beats % 3 === 0 ? 1.5 : 4 / options.beatType;
  const groupsPerMeasure = Math.round(measureLength / groupLength);
  let projected = ""; const sourceOffsets: number[] = [];
  let group = ""; let groupOffsets: number[] = []; let groupOffset = 0; let groupCount = 0;
  const append = (value: string, origins?: number[]): void => {
    projected += value;
    sourceOffsets.push(...(origins ?? Array(value.length).fill(-1)));
  };
  const markers = (duration: number, safe: boolean): string => {
    let remaining = Math.round(duration * 16); let value = "";
    for (const division of DIVISIONS) {
      const ticks = 64 / division; const count = Math.floor(remaining / ticks);
      if (count === 0) continue;
      value += (safe ? alphabet.safeSymbols : alphabet.symbols).get(division)!.repeat(count);
      remaining -= count * ticks;
    }
    if (remaining !== 0) throw new Error("时值无法投影到六十四分音符网格。");
    return value;
  };
  const closeGroup = (): void => {
    append(group, groupOffsets); append("/");
    group = ""; groupOffsets = []; groupOffset = 0; groupCount++;
    if (groupCount === groupsPerMeasure) { append("\n"); groupCount = 0; }
  };
  append(base.kind === "keyboard" ? "键盘谱\n" : "数字谱\n");
  for (const event of data.events) {
    let remaining = event.duration; let firstPiece = true;
    while (remaining > EPS) {
      const piece = Math.min(remaining, groupLength - groupOffset);
      const addRestVoice = event.rest && !event.token.startsWith(SLASH_VOICE_SEPARATOR);
      const token = firstPiece ? addRestVoice ? `${SLASH_VOICE_SEPARATOR}${event.token}` : event.token : "";
      const origins = firstPiece ? addRestVoice ? [-1, ...event.tokenOffsets] : event.tokenOffsets : [];
      const durationText = markers(piece, !firstPiece);
      group += token + durationText;
      groupOffsets.push(...origins, ...Array(durationText.length).fill(-1));
      firstPiece = false; remaining -= piece; groupOffset += piece;
      if (groupOffset >= groupLength - EPS) closeGroup();
    }
  }
  if (group) closeGroup();
  return { text: projected.trimEnd(), options, sourceOffsets: sourceOffsets.slice(0, projected.trimEnd().length) };
}

/** Insert slash hints without rewriting source pitches, symbols or comments. */
export function convertAddSlashes(text: string, draft: AddSlashesOptions): AddSlashesResult {
  const src = source(text, draft); const data = eventData(src, draft);
  const errors = [...src.errors, ...data.errors]; const warnings = [...src.warnings];
  const options = defaultSlashScoreOptions(src.kind);
  options.beats = draft.beats ?? 4; options.beatType = draft.beatType ?? 4;
  options.noteDivision = draft.noteDivision ?? null; options.spaceDivision = draft.spaceDivision ?? null;
  options.symbolDurations = normalizedSymbols(draft); options.multiDurationSymbols = true;
  options.wholeMeasureGroups = false; options.parenMode = "chord";
  options.braceMode = "none"; options.bracketMode = "none"; options.angleMode = "none"; options.barMode = "none";
  options.sourceTimedRows = true; options.adjacentAsChord = draft.adjacentAsChord ?? true;
  if (draft.beats == null) errors.push("请先选择拍号；拍号留空时请手动指定时值后查看候选。 ");
  if (!Number.isInteger(options.beats) || options.beats < 1 || options.beats > 32 || ![2, 4, 8, 16].includes(options.beatType)) errors.push("拍号无效。 ");
  if (!data.events.length) errors.push("没有可转换的音符。 ");
  if (errors.length) return { text, options, canImport: false, lineStats: data.lineStats, warnings, errors: [...new Set(errors)] };
  const measureLength = options.beats * 4 / options.beatType;
  const groupLength = options.beatType === 8 && options.beats >= 6 && options.beats % 3 === 0 ? 1.5 : 4 / options.beatType;
  const first = data.lineStats[0];
  const padding = first.quarterNotes < measureLength - EPS ? measureLength - first.quarterNotes : 0;
  let paddedText = text;
  if (padding > EPS) {
    const intrinsic = options.noteDivision ? 4 / options.noteDivision : 0;
    const separator = options.spaceDivision ? "\t" : " ";
    let prefix = "";
    if (intrinsic > EPS && src.observedSymbols.length === 0 && isWholeMultiple(padding, intrinsic)) {
      prefix = (`0${separator}`).repeat(Math.round(padding / intrinsic));
    } else {
      let remaining = padding - intrinsic;
      if (remaining >= -EPS) {
        const symbols = src.observedSymbols.map((symbol) => ({ symbol, unit: 4 / options.symbolDurations[symbol] }))
          .sort((a, b) => b.unit - a.unit);
        prefix = "0";
        for (const { symbol, unit } of symbols) {
          const count = Math.floor((remaining + EPS) / unit);
          const atom = src.rows.flatMap((row) => row.atoms).find((item) => item.symbols.includes(symbol));
          const at = atom ? atom.symbolOffsets[atom.symbols.indexOf(symbol)] : -1;
          const rawSymbol = at >= 0 ? String.fromCodePoint(text.codePointAt(at)!) : symbol;
          prefix += rawSymbol.repeat(count); remaining -= count * unit;
        }
        if (Math.abs(remaining) > EPS) prefix = "";
        else prefix += separator;
      }
    }
    if (!prefix) errors.push(`首行缺 ${padding} 个四分音符，但现有符号与自身时值不能精确表示前置休止；请调整时值或手动补休止。`);
    else {
      const row = src.rows.find((candidate) => candidate.line === first.line)!;
      const at = row.atoms[0]?.from ?? row.from;
      paddedText = text.slice(0, at) + prefix + text.slice(at);
      warnings.push(`第 ${first.line} 行按弱起处理，前补 ${padding} 个四分音符的休止，组成完整小节。`);
    }
  }
  if (errors.length) return { text, options, canImport: false, lineStats: data.lineStats, warnings, errors: [...new Set(errors)] };
  const paddedSource = source(paddedText, draft);
  const insertions = new Map<number, number>();
  let clock = 0; let nextBoundary = groupLength;
  const addSlash = (at: number, count = 1): void => { insertions.set(at, (insertions.get(at) ?? 0) + count); };
  const crossedRows = new Set<number>();
  const advance = (amount: number, at: number, line: number): void => {
    const end = clock + amount;
    while (nextBoundary <= end + EPS) {
      addSlash(at);
      if (nextBoundary > clock + EPS && nextBoundary < end - EPS) crossedRows.add(line);
      nextBoundary += groupLength;
    }
    clock = end;
  };
  for (const row of paddedSource.rows.filter((candidate) => candidate.score)) {
    for (const atom of row.atoms) {
      if (options.noteDivision && atom.pitches.length) {
        const unit = 4 / options.noteDivision;
        if (atom.explicitChord || options.adjacentAsChord || atom.rest) advance(unit, atom.pitchTo, row.line);
        else for (const at of atom.pitchEnds) advance(unit, at, row.line);
      }
      atom.symbols.forEach((symbol, index) => advance(4 / options.symbolDurations[symbol], atom.symbolOffsets[index] + symbol.length, row.line));
    }
    if (!insertions.has(row.codeTo)) addSlash(row.codeTo);
  }
  let output = "";
  for (let at = 0; at <= paddedText.length; at++) {
    const count = insertions.get(at); if (count) output += "/".repeat(count);
    if (at < paddedText.length) output += paddedText[at];
  }
  const irregular = data.lineStats.filter((row, index) => !(index === 0 && padding > EPS) && Math.abs(row.quarterNotes - measureLength) > EPS);
  if (irregular.length) warnings.push(`第 ${irregular.slice(0, 8).map((row) => row.line).join("、")} 行不是恰好一小节；保留原换行与全部时值，请核对拍号或符号解释。`);
  if (crossedRows.size) warnings.push(`第 ${[...crossedRows].slice(0, 8).join("、")} 行有拍界落在单个符号的时值内；斜杠放在符号后提示，符号与实际音长均保留。`);
  const expected: Array<{ pitch: number; t0: number; t1: number }> = [];
  let elapsed = padding;
  for (const event of data.events) {
    for (const pitch of event.pitches) expected.push({ pitch, t0: elapsed, t1: elapsed + event.duration });
    elapsed += event.duration;
  }
  try {
    const parsed = parseSlashScore(output, options);
    const actual = buildTimeline(parsed.score).notes;
    if (parsed.summary.clippedGroups || parsed.summary.ignoredCharacters) errors.push("转换校验发现时值被截断或字符未识别，请调整输入。 ");
    const sortedExpected = [...expected].sort((a, b) => a.t0 - b.t0 || a.pitch - b.pitch);
    const sortedActual = [...actual].sort((a, b) => a.t0 - b.t0 || a.pitch - b.pitch);
    const mismatch = sortedActual.findIndex((note, index) => {
      const wanted = sortedExpected[index]; return !wanted || note.pitch !== wanted.pitch
        || Math.abs(note.t0 - wanted.t0) > EPS || Math.abs(note.t1 - wanted.t1) > EPS;
    });
    if (sortedActual.length !== sortedExpected.length || mismatch >= 0) {
      const at = mismatch >= 0 ? mismatch : Math.min(sortedActual.length, sortedExpected.length);
      const wanted = sortedExpected[at]; const found = sortedActual[at];
      errors.push(`转换后第 ${at + 1} 个发声音与原文不一致（应为 ${wanted ? `${wanted.pitch}@${wanted.t0}–${wanted.t1}` : "无"}，实际 ${found ? `${found.pitch}@${found.t0}–${found.t1}` : "无"}），请核对输入。`);
    }
  } catch (error) { errors.push(`转换校验失败：${error instanceof Error ? error.message : String(error)}`); }
  return { text: output, options, canImport: errors.length === 0, lineStats: data.lineStats, warnings: [...new Set(warnings)], errors: [...new Set(errors)] };
}
