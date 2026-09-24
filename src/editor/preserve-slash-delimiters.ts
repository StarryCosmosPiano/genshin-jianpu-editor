import type { SlashScoreKind, SlashScoreOptions } from "../slashscore";

/**
 * A score edit serializes every TXT row. When two delimiters have the same
 * configured role, that conversion otherwise changes untouched groups to the
 * writer's preferred spelling. Keep a source group only when its complete
 * text matches the generated group after equivalent delimiters are mapped to
 * their shared role; rhythm, pitches, voices, and differently assigned roles
 * must still come from the edited score.
 */
export function preserveUnchangedSlashGroups(
  source: string,
  rewritten: string,
  kind: SlashScoreKind,
  options: Pick<SlashScoreOptions, "braceMode" | "bracketMode" | "barMode" | "angleMode" | "parenMode">,
): string {
  const sourceLines = source.split(/\r?\n/);
  const rewrittenLines = rewritten.split(/\r?\n/);
  const sourceRows = scoreRowIndexes(sourceLines, kind);
  const rewrittenRows = scoreRowIndexes(rewrittenLines, kind);
  // A single source row can contain several measures, while the writer emits
  // one row per measure. Without a one-to-one mapping, retain its output.
  if (sourceRows.length === 0 || sourceRows.length !== rewrittenRows.length) return rewritten;

  let changed = false;
  sourceRows.forEach((sourceIndex, row) => {
    const targetIndex = rewrittenRows[row];
    const before = sourceLines[sourceIndex].split("/");
    const after = rewrittenLines[targetIndex].split("/");
    if (before.length !== after.length) return;
    for (let group = 0; group < before.length; group++) {
      if (normalizedDelimiters(before[group], options) !== normalizedDelimiters(after[group], options)) continue;
      if (before[group] === after[group]) continue;
      after[group] = before[group];
      changed = true;
    }
    rewrittenLines[targetIndex] = after.join("/");
  });
  return changed ? rewrittenLines.join(rewritten.includes("\r\n") ? "\r\n" : "\n") : rewritten;
}

function scoreRowIndexes(lines: readonly string[], kind: SlashScoreKind): number[] {
  const result: number[] = [];
  let section: SlashScoreKind | null = null;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "键盘谱") section = "keyboard";
    else if (trimmed === "数字谱") section = "number";
    if (section !== null && section !== kind) return;
    if (!trimmed.includes("/")) return;
    if (trimmed.startsWith("//")
      && !/^\/+\s*(?:[\u2063\-+0-9A-Z#b({]).*\//.test(trimmed)) return;
    // Deliberately narrow: prose, comments, directives and line tags must
    // never be rewritten by this source-spelling preservation pass.
    if (!/^[\s\u2063A-Z0-9#b♭♯+,.\-'(){}\[\]<>|=*_~:·/]+$/.test(line)) return;
    const upper = (line.match(/[A-Z]/g) ?? []).length;
    const degrees = (line.match(/[1-7]/g) ?? []).length;
    if (upper && degrees && (kind === "keyboard" ? upper < degrees : degrees < upper)) return;
    if (kind === "keyboard" && !upper && degrees) return;
    if (kind === "number" && !degrees && upper) return;
    result.push(index);
  });
  return result;
}

function normalizedDelimiters(
  group: string,
  options: Pick<SlashScoreOptions, "braceMode" | "bracketMode" | "barMode" | "angleMode" | "parenMode">,
): string {
  const modes = {
    "{": options.braceMode, "}": options.braceMode,
    "[": options.bracketMode ?? "triplet", "]": options.bracketMode ?? "triplet",
    "<": options.angleMode ?? "grace", ">": options.angleMode ?? "grace",
    "(": options.parenMode ?? "chord", ")": options.parenMode ?? "chord",
    "|": options.barMode ?? "none",
  } as const;
  const role = (character: keyof typeof modes): string => {
    const mode = modes[character];
    // Disabled brackets are not semantically interchangeable.
    return mode === "none" ? `none:${character}` : mode;
  };
  return [...group].map((character) => {
    if (!(character in modes)) return character;
    const delimiter = character as keyof typeof modes;
    const side = delimiter === "{" || delimiter === "[" || delimiter === "<" || delimiter === "("
      ? "open" : delimiter === "|" ? "bar" : "close";
    return `\u0001${role(delimiter)}:${side}\u0002`;
  }).join("");
}
