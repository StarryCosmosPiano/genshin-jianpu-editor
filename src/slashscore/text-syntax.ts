import { slashScoreSourceRows, type SlashGroupMode, type SlashScoreOptions } from "./index";

export interface SlashTextContainer {
  from: number;
  to: number;
  bodyFrom: number;
  bodyTo: number;
  mode: SlashGroupMode;
  row: number;
  group: number;
}

/** Inspect only accepted music rows; prose, line tags and footer JSON are not
 * notation. An unfinished pair is a typing draft, never a committed rewrite. */
export function scanSlashTextSyntax(text: string, options: SlashScoreOptions): {
  complete: boolean;
  containers: SlashTextContainer[];
  rowCount: number;
} {
  const rows = slashScoreSourceRows(text, options.kind);
  const modes: Record<string, { close: string; mode: SlashGroupMode }> = {
    "(": { close: ")", mode: options.parenMode ?? "chord" },
    "[": { close: "]", mode: options.bracketMode ?? "triplet" },
    "{": { close: "}", mode: options.braceMode },
    "<": { close: ">", mode: options.angleMode ?? "grace" },
    "|": { close: "|", mode: options.barMode ?? "none" },
  };
  const containers: SlashTextContainer[] = [];
  let complete = true;
  rows.forEach((row, rowIndex) => {
    const stack: Array<{ from: number; bodyFrom: number; close: string; mode: SlashGroupMode; group: number }> = [];
    let group = 0;
    for (let index = 0; index < row.text.length;) {
      const character = row.text[index];
      const tag = /^\[(?:line|end)\s*\d+\s*\]/i.exec(row.text.slice(index));
      if (tag) { index += tag[0].length; continue; }
      if (character === ";" || character === "；"
        || row.text.startsWith("//", index) && index > 0 && /\s/.test(row.text[index - 1])) break;
      if (character === "/") {
        // The TXT grammar splits beat groups before reading containers.
        if (stack.length) complete = false;
        stack.length = 0;
        group++;
        index++;
        continue;
      }
      const token = character === "|" && row.text[index + 1] === "|" ? "||" : character;
      const top = stack[stack.length - 1];
      if (top && token === top.close) {
        stack.pop();
        containers.push({ from: row.from + top.from, to: row.from + index + token.length,
          bodyFrom: row.from + top.bodyFrom, bodyTo: row.from + index,
          mode: top.mode, row: rowIndex, group: top.group });
      } else if (modes[character] && !(character === "|" && modes[character].mode === "none")) {
        const spec = modes[character];
        stack.push({ from: index, bodyFrom: index + token.length,
          close: token === "||" ? "||" : spec.close, mode: spec.mode, group });
      } else if (")]}>".includes(character)) {
        complete = false;
      }
      index += token.length;
    }
    if (stack.length) complete = false;
  });
  return { complete, containers: containers.sort((a, b) => a.from - b.from || b.to - a.to), rowCount: rows.length };
}
