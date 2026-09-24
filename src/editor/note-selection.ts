import { TokenData, TokType, tokenClass } from "../jpword/tokens";
import { Chord, MusicCommon, type Note, type Score } from "../score/score";
import { slashPitchSources, type SlashPitchSource, type SlashScoreKind, type SlashScoreOptions } from "../slashscore";

export interface JpwSourceNote {
  chord: Chord;
  note: Note;
  /** Non-metrical pitch printed before the chord's main sounding notes. */
  grace: boolean;
  partIndex: number;
  /** Stable editable chord order within this source part. */
  chordIndex: number;
  tokenFrom: number;
  tokenTo: number;
  /** Exact editable pitch span, including accidental and octave markers. */
  from: number;
  to: number;
  /** Slash-score only: one-based V1..VN and its zero-width prefix range. */
  voiceIndex?: number;
  markerFrom?: number;
  markerCount?: number;
}

export type PitchEdit =
  | { kind: "number"; number: string }
  | { kind: "octave"; delta: -1 | 1 };

interface TextRange {
  from: number;
  to: number;
  text: string;
}

function isVoiceSection(name: string): boolean {
  const value = name.trim().toLowerCase();
  return value === ".voice" || value === ".voice.rh" || value === ".voice.lh"
    || value === ".voice.right" || value === ".voice.left"
    || /^\.voice\..+\.v\d+$/.test(value);
}

/** Locate source note tokens in each `.Voice...` section while retaining absolute offsets. */
interface SourceVoiceTokens {
  section: string;
  tokens: TextRange[];
}

function voiceNoteTokens(text: string): SourceVoiceTokens[] {
  const voices: SourceVoiceTokens[] = [];
  let currentVoice = -1;
  let offset = 0;
  for (const token of TokenData.parse(text).tokens) {
    const from = offset;
    const to = from + token.text.length;
    offset = to;
    if (token.type === TokType.SectionName) {
      if (isVoiceSection(token.text)) {
        currentVoice = voices.length;
        voices.push({ section: token.text.trim().toLowerCase(), tokens: [] });
      } else {
        currentVoice = -1;
      }
      continue;
    }
    if (currentVoice >= 0 && tokenClass[token.type] === "note") {
      voices[currentVoice].tokens.push({ from, to, text: token.text });
    }
  }
  return voices;
}

function normalizedPitch(text: string): string {
  return text.replace(/g/g, "'").replace(/d/g, ",");
}

function sourcePitchOf(note: Note): string {
  const accidental = note.jpAlter === "n" ? "#b" : note.jpAlter.trim();
  const octave = note.jpOctave > 0 ? "'".repeat(note.jpOctave) : ",".repeat(-note.jpOctave);
  return `${accidental}${note.number}${octave}`;
}

/** Main-pitch spans within one Note token. Control/tuplet/grace blocks are excluded. */
function pitchSpans(token: TextRange): TextRange[] {
  const bracketStart = token.text.indexOf("[");
  const bracketEnd = bracketStart >= 0 ? token.text.indexOf("]", bracketStart + 1) : -1;
  const scanFrom = bracketStart >= 0 && bracketEnd > bracketStart ? bracketStart + 1 : 0;
  const scanTo = bracketStart >= 0 && bracketEnd > bracketStart ? bracketEnd : token.text.length;
  const ignored: Array<[number, number]> = [];
  if (bracketStart < 0) {
    const block = /\{[^}]*\}/g;
    let match: RegExpExecArray | null;
    while ((match = block.exec(token.text)) !== null) ignored.push([match.index, match.index + match[0].length]);
  }

  const result: TextRange[] = [];
  const pitch = /(?:#b|#|b)?[0-7](?:[,'gd])*/g;
  pitch.lastIndex = scanFrom;
  let match: RegExpExecArray | null;
  while ((match = pitch.exec(token.text)) !== null && match.index < scanTo) {
    const end = match.index + match[0].length;
    if (end > scanTo) break;
    if (ignored.some(([from, to]) => match!.index >= from && match!.index < to)) continue;
    result.push({
      from: token.from + match.index,
      to: token.from + end,
      text: match[0],
    });
    // A non-chord Note token has exactly one sounding main pitch.
    if (bracketStart < 0) break;
  }
  return result;
}

function jpwTokenQuarterDuration(token: TextRange): number {
  const notation = token.text.replace(/\{[^}]*\}/g, "");
  const beams = notation.match(/_/g)?.length ?? 0;
  const beats = 1 + (notation.match(/-/g)?.length ?? 0);
  const dotted = notation.includes(".") ? 1.5 : 1;
  return beats * dotted / (1 << beams);
}

/** Exact pitch spans inside the JPW `{...}` grace-note block of one Note token. */
function gracePitchSpans(token: TextRange): TextRange[] {
  const block = /\{((?:(?:#b|#|b)?[0-7](?:[,'gd])*)+)\}/.exec(token.text);
  if (!block || block.index === undefined) return [];
  const contentFrom = block.index + 1;
  const result: TextRange[] = [];
  const pitch = /(?:#b|#|b)?[0-7](?:[,'gd])*/g;
  pitch.lastIndex = contentFrom;
  const contentTo = contentFrom + block[1].length;
  let match: RegExpExecArray | null;
  while ((match = pitch.exec(token.text)) !== null && match.index < contentTo) {
    const end = match.index + match[0].length;
    if (end > contentTo) break;
    result.push({
      from: token.from + match.index,
      to: token.from + end,
      text: match[0],
    });
  }
  return result;
}

/** Build live Score-note -> `.jpwabc` source ranges for picking and direct editing. */
export function buildJpwSourceNotes(text: string, score: Score): JpwSourceNote[] {
  const voiceTokens = voiceNoteTokens(text);
  const result: JpwSourceNote[] = [];
  score.parts.forEach((part, partIndex) => {
    const chords = part.measures.flatMap((measure) =>
      measure.entries.filter((entry): entry is Chord =>
        entry instanceof Chord && !entry.generatedTimingContinuation))
      .sort((left, right) =>
        (left.timingSourceIndex ?? Number.MAX_SAFE_INTEGER)
        - (right.timingSourceIndex ?? Number.MAX_SAFE_INTEGER));
    // Ensemble parts are sorted by instrument/voice index during import, but
    // users commonly write `.Voice.<instrument>.V2` before `V1`. Resolve the
    // source section by its semantic identity instead of the original array
    // order, otherwise clicking V1 edits V2's source text.
    let sourceVoice: SourceVoiceTokens | undefined;
    if (score.ensemble) {
      const instrument = part.instrumentName.trim().toLowerCase();
      sourceVoice = voiceTokens.find((voice) => {
        const match = /^\.voice\.(.+)\.v(\d+)$/.exec(voice.section);
        return match !== null
          && match[1].trim() === instrument
          && parseInt(match[2], 10) === part.voiceIndex;
      });
    } else if (score.piano && part.hand !== null) {
      sourceVoice = voiceTokens.find((voice) =>
        voice.section === (part.hand === "right" ? ".voice.rh" : ".voice.lh")
        || voice.section === (part.hand === "right" ? ".voice.right" : ".voice.left"));
    }
    const tokens = (sourceVoice ?? voiceTokens[partIndex])?.tokens ?? [];
    let chordCursor = 0;
    let tieOpen = false;
    let previous: { chord: Chord; chordIndex: number; pitches: string[] } | null = null;
    let mergedRest: {
      chord: Chord;
      chordIndex: number;
      remainingDuration: number;
    } | null = null;
    const chordPitches = (chord: Chord): string[] =>
      chord.notes.map(sourcePitchOf).map(normalizedPitch).sort();
    const samePitches = (left: readonly string[], right: readonly string[]): boolean =>
      left.length === right.length
      && left.every((pitch, index) => pitch === right[index]);
    for (const token of tokens) {
      const mainSpans = pitchSpans(token);
      const expected = mainSpans.map((span) => normalizedPitch(span.text)).sort();
      const sameTiePitch = tieOpen
        && previous !== null
        && samePitches(previous.pitches, expected);
      const restToken = expected.length === 1 && expected[0] === "0";
      const tokenDuration = restToken ? jpwTokenQuarterDuration(token) : 0;
      let chordIndex = -1;
      let chord: Chord | null = null;
      let reusedMergedRest = false;
      if (restToken
        && mergedRest
        && mergedRest.remainingDuration + 1e-8 >= tokenDuration) {
        // Several source `0__` tokens can be rendered as one legal `0_`
        // inside a beat. Keep every original zero editable by mapping its
        // range back to the same merged rest chord.
        chord = mergedRest.chord;
        chordIndex = mergedRest.chordIndex;
        reusedMergedRest = true;
        mergedRest.remainingDuration = Math.max(
          0,
          mergedRest.remainingDuration - tokenDuration,
        );
      } else if (sameTiePitch && previous) {
        const visibleContinuation = chords[chordCursor];
        if (visibleContinuation?.transparentContinuation
          && samePitches(chordPitches(visibleContinuation), expected)) {
          chord = visibleContinuation;
          chordIndex = chordCursor++;
        } else {
          // The continuation was absorbed into a legal value inside one beat.
          // Keep both editable source numbers mapped to the merged score note.
          chord = previous.chord;
          chordIndex = previous.chordIndex;
        }
      } else {
        chordIndex = chords.findIndex((candidate, index) =>
          index >= chordCursor && samePitches(chordPitches(candidate), expected));
        if (chordIndex < 0 && chordCursor < chords.length) chordIndex = chordCursor;
        if (chordIndex >= 0) {
          chord = chords[chordIndex];
          chordCursor = chordIndex + 1;
        }
      }
      if (!chord || chordIndex < 0) continue;
      const append = (notes: readonly Note[], spans: readonly TextRange[], grace: boolean): void => {
        const unused = new Set(spans.map((_span, index) => index));
        for (const note of notes) {
          const expected = sourcePitchOf(note);
          let spanIndex = spans.findIndex((span, index) =>
            unused.has(index) && normalizedPitch(span.text) === expected);
          if (spanIndex < 0) spanIndex = [...unused][0] ?? -1;
          if (spanIndex < 0) continue;
          unused.delete(spanIndex);
          const span = spans[spanIndex];
          result.push({
            chord,
            note,
            grace,
            partIndex,
            chordIndex,
            tokenFrom: token.from,
            tokenTo: token.to,
            from: span.from,
            to: span.to,
          });
        }
      };
      append(chord.graceNotes, gracePitchSpans(token), true);
      append(chord.notes, mainSpans, false);
      if (restToken && !reusedMergedRest) {
        mergedRest = {
          chord,
          chordIndex,
          remainingDuration: Math.max(
            0,
            (chord.duration?.toFloat() ?? tokenDuration) - tokenDuration,
          ),
        };
      } else if (!restToken) {
        mergedRest = null;
      }
      previous = { chord, chordIndex, pitches: expected };
      const notation = token.text.replace(/\{[^}]*\}/g, "");
      const opens = notation.includes("(");
      const closes = notation.includes(")");
      if (closes) tieOpen = opens;
      else if (opens) tieOpen = true;
    }
  });
  return result.sort((a, b) => a.from - b.from || a.to - b.to);
}

function containsPitchMultiplicity(actual: readonly number[], expected: readonly number[]): boolean {
  const remaining = [...actual];
  for (const pitch of expected) {
    const index = remaining.indexOf(pitch);
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return true;
}

/** Build Score-note -> editable TXT ranges for keyboard/number slash scores. */
export function buildSlashSourceNotes(
  text: string,
  options: SlashScoreOptions,
  score: Score,
  scannedSources?: readonly SlashPitchSource[],
): JpwSourceNote[] {
  const sources = scannedSources ?? slashPitchSources(text, options);
  const events = new Map<string, SlashPitchSource[]>();
  for (const source of sources) {
    const key = `${source.eventIndex}:${source.voiceIndex}`;
    const group = events.get(key) ?? [];
    group.push(source);
    events.set(key, group);
  }

  // A local key mark applies at its exact measure/offset.  Candidate order is
  // source order rather than time order, so resolve each chord independently.
  const sortedKeyMarks = [...score.keyMarks].sort((left, right) =>
    left.measure - right.measure || left.offset.compareTo(right.offset));
  const tonicAt = (fifths: number): number => {
    const index = Math.max(0, Math.min(MusicCommon.keys.length - 1, Math.round(fifths) + 7));
    return MusicCommon.getBasePitch(MusicCommon.keys[index]);
  };
  const openingTonic = tonicAt(options.fifths);
  const pitchDeltaAt = (chord: Chord): number => {
    let low = 0;
    let high = sortedKeyMarks.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const mark = sortedKeyMarks[middle];
      const beforeChord = mark.measure < chord.measure.index
        || (mark.measure === chord.measure.index
          && mark.offset.compareTo(chord.position) <= 0);
      if (beforeChord) low = middle + 1;
      else high = middle;
    }
    return tonicAt(low === 0 ? options.fifths : sortedKeyMarks[low - 1].fifths) - openingTonic;
  };
  const candidates = score.parts.flatMap((part, partIndex) => {
    let chordIndex = 0;
    return part.measures.flatMap((measure) =>
      measure.entries
      .filter((entry): entry is Chord =>
        entry instanceof Chord
        && !entry.generatedTimingContinuation
        && !entry.rest)
      .map((chord) => {
        const fallbackIndex = chordIndex++;
        const pitchDelta = pitchDeltaAt(chord);
        return {
          chord,
          partIndex,
          chordIndex: chord.timingSourceIndex ?? fallbackIndex,
          time: measure.position.plus(chord.position).toFloat(),
          pitchDelta,
          // Compare in the written key; the final note association still uses
          // sounding pitch below.
          pitches: chord.notes.filter((note) => !note.rest)
            .map((note) => note.pitch - pitchDelta).sort((a, b) => a - b),
        };
      }),
    );
  }).sort((a, b) =>
    a.partIndex - b.partIndex || a.chordIndex - b.chordIndex || a.time - b.time);

  type CandidateBucket = { indices: number[]; next?: number[] };
  const exactByPart = new Map<number, Map<string, CandidateBucket>>();
  const continuationByPart = new Map<number, Map<string, CandidateBucket>>();
  const pitchByPart = new Map<number, Map<number, number[]>>();
  const arpeggioPitchByPart = new Map<number, Map<number, number[]>>();
  const allByPart = new Map<number, number[]>();
  const arpeggioByPart = new Map<number, number[]>();
  const pitchKey = (pitches: readonly number[]): string => pitches.join(",");
  const appendBucket = (index: Map<number, Map<string, CandidateBucket>>,
    part: number, key: string, candidateIndex: number): void => {
    let byPitch = index.get(part);
    if (!byPitch) { byPitch = new Map(); index.set(part, byPitch); }
    let bucket = byPitch.get(key);
    if (!bucket) { bucket = { indices: [] }; byPitch.set(key, bucket); }
    bucket.indices.push(candidateIndex);
  };
  const appendPitch = (index: Map<number, Map<number, number[]>>,
    part: number, pitch: number, candidateIndex: number): void => {
    let byPitch = index.get(part);
    if (!byPitch) { byPitch = new Map(); index.set(part, byPitch); }
    let entries = byPitch.get(pitch);
    if (!entries) { entries = []; byPitch.set(pitch, entries); }
    entries.push(candidateIndex);
  };
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const part = candidate.partIndex;
    let all = allByPart.get(part);
    if (!all) { all = []; allByPart.set(part, all); }
    all.push(index);
    const key = pitchKey(candidate.pitches);
    appendBucket(exactByPart, part, key, index);
    if (candidate.chord.transparentContinuation) {
      appendBucket(continuationByPart, part, key, index);
    }
    if (candidate.chord.arpeggio) {
      let arpeggios = arpeggioByPart.get(part);
      if (!arpeggios) { arpeggios = []; arpeggioByPart.set(part, arpeggios); }
      arpeggios.push(index);
    }
    for (let p = 0; p < candidate.pitches.length; p++) {
      if (p > 0 && candidate.pitches[p] === candidate.pitches[p - 1]) continue;
      appendPitch(pitchByPart, part, candidate.pitches[p], index);
      if (candidate.chord.arpeggio) {
        appendPitch(arpeggioPitchByPart, part, candidate.pitches[p], index);
      }
    }
  }

  const result: JpwSourceNote[] = [];
  const usedCandidates = new Set<number>();
  // A bucket keeps its original candidate order.  Its successor links skip
  // consumed entries even when source events request an earlier chord index.
  const firstAvailable = (bucket: CandidateBucket | undefined, minimumSourceIndex: number): number => {
    if (!bucket || bucket.indices.length === 0) return -1;
    const { indices } = bucket;
    let low = 0;
    let high = indices.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (candidates[indices[middle]].chordIndex < minimumSourceIndex) low = middle + 1;
      else high = middle;
    }
    const next = bucket.next ??= Array.from({ length: indices.length + 1 }, (_, index) => index);
    const successor = (start: number): number => {
      let end = start;
      while (next[end] !== end) end = next[end];
      while (start !== end) {
        const following = next[start];
        next[start] = end;
        start = following;
      }
      return end;
    };
    let position = successor(low);
    while (position < indices.length && usedCandidates.has(indices[position])) {
      next[position] = successor(position + 1);
      position = next[position];
    }
    return position < indices.length ? indices[position] : -1;
  };
  const subsetBuckets = new Map<string, CandidateBucket>();
  const containsBucket = (part: number, pitches: readonly number[], arpeggio: boolean): CandidateBucket => {
    const key = `${part}:${arpeggio ? 1 : 0}:${pitchKey(pitches)}`;
    let bucket = subsetBuckets.get(key);
    if (bucket) return bucket;
    const byPitch = (arpeggio ? arpeggioPitchByPart : pitchByPart).get(part);
    // Every containing chord has every required pitch.  Use the rarest
    // posting, then check multiplicity once when building this source shape.
    let posting = arpeggio ? arpeggioByPart.get(part) : allByPart.get(part);
    for (let p = 0; p < pitches.length; p++) {
      if (p > 0 && pitches[p] === pitches[p - 1]) continue;
      const possible = byPitch?.get(pitches[p]) ?? [];
      if (!posting || possible.length < posting.length) posting = possible;
    }
    bucket = { indices: (posting ?? []).filter((index) =>
      containsPitchMultiplicity(candidates[index].pitches, pitches)) };
    subsetBuckets.set(key, bucket);
    return bucket;
  };
  const lastSourceIndexByPart = new Map<number, number>();
  const lastMappedByPart = new Map<number, {
    groupKey: string;
    pitches: number[];
    candidateIndex: number;
  }>();
  const sourceGroupKeys = new Map<number, string>();
  const sourceOffsets = [...new Set(sources.map((source) => source.from))].sort((a, b) => a - b);
  let scanned = 0;
  let lineStart = 0;
  let slashCount = 0;
  for (const offset of sourceOffsets) {
    while (scanned < offset) {
      const char = text[scanned++];
      if (char === "\n" || char === "\r") {
        lineStart = scanned;
        slashCount = 0;
      } else if (char === "/") slashCount++;
    }
    // Preserve lastIndexOf's offset-zero behavior for an unusual source
    // token beginning at the very first character.
    if (offset === 0 && (text[0] === "\n" || text[0] === "\r")) {
      sourceGroupKeys.set(offset, "1:0");
    } else {
      sourceGroupKeys.set(offset, `${lineStart}:${slashCount}`);
    }
  }
  for (const event of events.values()) {
    const mainEvent = event.filter((source) => !source.grace);
    const graceEvent = event.filter((source) => source.grace);
    if (mainEvent.length === 0) continue;
    const expected = mainEvent.map((source) => source.pitch).sort((a, b) => a - b);
    const preferredPart = Math.max(0, (mainEvent[0]?.voiceIndex ?? 1) - 1);
    const minimumSourceIndex = lastSourceIndexByPart.get(preferredPart) ?? -1;
    const groupKey = sourceGroupKeys.get(mainEvent[0].from)!;
    const lastMapped = lastMappedByPart.get(preferredPart);
    const sameSustainedSource = lastMapped
      && lastMapped.groupKey === groupKey
      && lastMapped.pitches.length === expected.length
      && lastMapped.pitches.every((pitch, pitchIndex) => pitch === expected[pitchIndex]);
    // Equal source pitches inside one slash group may be either a new attack
    // or duration spelling absorbed by rhythmic normalization.  A visible
    // gray continuation is the most specific match; other attacks are tried
    // below before falling back to the already mapped merged note.
    const expectedKey = pitchKey(expected);
    let candidateIndex = sameSustainedSource
      ? firstAvailable(continuationByPart.get(preferredPart)?.get(expectedKey), minimumSourceIndex)
      : -1;
    let reusedCandidate = false;
    if (candidateIndex < 0) {
      candidateIndex = firstAvailable(exactByPart.get(preferredPart)?.get(expectedKey), minimumSourceIndex);
    }
    if (candidateIndex < 0) {
      candidateIndex = firstAvailable(containsBucket(preferredPart, expected, false), minimumSourceIndex);
    }
    if (candidateIndex < 0 && sameSustainedSource) {
      // Equal pitches later in the same slash group can be either a genuine
      // repeated MIDI attack or source spelling that was absorbed into the
      // preceding legal duration.  Prefer every unused rendered attack first;
      // only reuse the previous note when the timing normalizer produced no
      // separate chord at all.  Reusing too early left the real repeated chord
      // without a source range, so it appeared uncoloured and could not select
      // its text (which looked like V1 had fallen into the default V2 row).
      candidateIndex = lastMapped.candidateIndex;
      reusedCandidate = true;
    }
    // A rolled subset and a simultaneous chord can be merged into one model
    // chord by the slash parser.  In that case the next source group must be
    // allowed to map back to the same arpeggio chord instead of being lost
    // behind the monotonic candidate cursor.
    if (candidateIndex < 0) {
      candidateIndex = firstAvailable(containsBucket(preferredPart, expected, true), -Infinity);
    }
    if (candidateIndex < 0) continue;
    const candidate = candidates[candidateIndex];
    const candidatePitchDelta = candidate.pitchDelta;
    const tokenFrom = Math.min(...event.map((source) => source.from));
    const tokenTo = Math.max(...event.map((source) => source.to));
    const append = (
      sourcePitches: typeof event,
      notes: readonly Note[],
      grace: boolean,
    ): void => {
      const unused = new Set(notes.map((_note, index) => index));
      for (const source of sourcePitches) {
        let noteIndex = notes.findIndex((note, index) =>
          unused.has(index) && !note.rest && note.pitch === source.pitch + candidatePitchDelta);
        if (noteIndex < 0) noteIndex = [...unused][0] ?? -1;
        if (noteIndex < 0) continue;
        unused.delete(noteIndex);
        result.push({
          chord: candidate.chord,
          note: notes[noteIndex],
          grace,
          partIndex: candidate.partIndex,
          chordIndex: candidate.chordIndex,
          tokenFrom,
          tokenTo,
          from: source.from,
          to: source.to,
          voiceIndex: source.voiceIndex,
          markerFrom: source.markerFrom,
          markerCount: source.markerCount,
        });
      }
    };
    append(graceEvent, candidate.chord.graceNotes, true);
    append(mainEvent, candidate.chord.notes, false);
    if (!reusedCandidate) usedCandidates.add(candidateIndex);
    lastSourceIndexByPart.set(preferredPart, candidate.chordIndex);
    lastMappedByPart.set(preferredPart, {
      groupKey,
      pitches: expected,
      candidateIndex,
    });
  }
  return result.sort((a, b) => a.from - b.from || a.to - b.to);
}

/** Apply a number or octave-key edit to one exact pitch substring. */
export function editJpwPitch(source: string, edit: PitchEdit): string {
  const match = /^(#b|#|b)?([0-7])([,'gd]*)$/.exec(source);
  if (!match) return source;
  const accidental = match[1] ?? "";
  const number = edit.kind === "number" ? edit.number : match[2];
  if (edit.kind === "number") return `${accidental}${number}${match[3]}`;

  const normalized = normalizedPitch(match[3]);
  const current = (normalized.match(/'/g)?.length ?? 0) - (normalized.match(/,/g)?.length ?? 0);
  const next = current + edit.delta;
  const octave = next > 0 ? "'".repeat(next) : ",".repeat(-next);
  return `${accidental}${number}${octave}`;
}

const SLASH_KEYBOARD_ROWS = ["ZXCVBNM", "ASDFGHJ", "QWERTYU"] as const;

/** Apply the score-pane 1–7 / octave-arrow edit to one slash-score pitch. */
export function editSlashPitch(source: string, kind: SlashScoreKind, edit: PitchEdit): string {
  if (kind === "number") {
    const match = /^((?:#|♯|b|♭)*)([+-]*)([1-7])$/.exec(source);
    if (!match) return source;
    const number = edit.kind === "number" ? edit.number : match[3];
    if (edit.kind === "number") return `${match[1]}${match[2]}${number}`;
    const octave = (match[2].match(/\+/g)?.length ?? 0) - (match[2].match(/-/g)?.length ?? 0) + edit.delta;
    const markers = octave > 0 ? "+".repeat(octave) : "-".repeat(-octave);
    return `${match[1]}${markers}${number}`;
  }

  const match = /^((?:#|♯|b|♭)*)([,'‘’]*)([A-Za-z])$/.exec(source);
  if (!match) return source;
  const letter = match[3].toUpperCase();
  const row = SLASH_KEYBOARD_ROWS.findIndex((keys) => keys.includes(letter));
  if (row < 0) return source;
  const currentDegree = SLASH_KEYBOARD_ROWS[row].indexOf(letter);
  const degree = edit.kind === "number" ? parseInt(edit.number, 10) - 1 : currentDegree;
  const normalizedMarkers = match[2].replace(/[‘’]/g, "'");
  let octave = row - 1 + (normalizedMarkers.match(/'/g)?.length ?? 0) -
    (normalizedMarkers.match(/,/g)?.length ?? 0);
  if (edit.kind === "octave") octave += edit.delta;
  const targetRow = Math.max(0, Math.min(2, octave + 1));
  const extra = octave < -1 ? ",".repeat(-octave - 1) : octave > 1 ? "'".repeat(octave - 1) : "";
  return `${match[1]}${extra}${SLASH_KEYBOARD_ROWS[targetRow][degree]}`;
}
