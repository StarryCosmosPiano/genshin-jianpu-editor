import { Fraction } from "../common/fraction";
import { AccidentalStat, Chord, MusicCommon, Note, type Score } from "../score/score";
import { spellPitch } from "../score/musicxml-export";
import { chordArpeggioNoteGroups, setChordArpeggioPitchGroups } from "../score/arpeggio";
import {
  ensureInputMeasure, inputRestAtCursor, moveInputNoteToPart, replaceInputContinuationAtCursor,
  type InputNoteSpec, type NotationCursor,
} from "../score/input-edit";
import { editSameOnsetNoteTimings, noteTimingStep, type NoteTimingDivision } from "../score/note-timing";
import { inputDegreeSpec, inputKeyAt, refreshInputAccidentals, type InputCursorSnapshot } from "./input-mode";
import { insertInputNoteWithDuration } from "./input-insertion";

/** A concrete input destination, independent of the displayed selection. Ghosts
 * remember the anchor's musical register without selecting or editing it. */
export interface InputTarget extends Omit<InputCursorSnapshot, "targets" | "primaryTargetIndex"> {
  kind: "note" | "ghost";
  /** Session identity transferred explicitly across verified reparses. */
  memberId?: string;
  toneIndex: number | null;
  pitchOccurrence: number;
  anchorToneIndex: number | null;
  anchorPitch: number | null;
  anchorDegree: number;
  anchorOctave: number;
  octaveOffset: number;
}

export interface InputTargetResolution { chord: Chord | null; note: Note | null }
export interface MultiInputResult {
  changed: number;
  blocked: number;
  skipped?: number;
  /** Verify every note-member endpoint, including unselected bars, after serialization. */
  verifyTimings?: boolean;
  targets: InputTarget[];
  reason?: "missing-target" | "boundary" | "occupied-target" | "incompatible-target";
  /** Explicitly marks a pending-cursor edit that did not change the Score. */
  sessionOnly?: boolean;
}
export type InputTargetDuration = (target: InputTarget, chord: Chord | null) => Fraction;
export type InputTargetPitchSpec = InputNoteSpec & { step?: string; alter?: number; octave?: number };

const inputMemberIds = new WeakMap<Note, string>();
let nextInputMemberId = 0;

export function inputNoteMemberId(note: Note): string {
  let identity = inputMemberIds.get(note);
  if (!identity) { identity = `input-member-${++nextInputMemberId}`; inputMemberIds.set(note, identity); }
  return identity;
}

export function inputTargetCursor(target: InputTarget): NotationCursor {
  return { partIndex: target.partIndex, measureIndex: target.measureIndex,
    offset: Fraction.fromString(target.offset), division: target.division,
    lane: target.lane, verticalIndex: target.verticalIndex };
}

/** Include visible continuations at their own exact rhythmic position. */
export function inputTargetChord(score: Score, target: Pick<InputTarget, "partIndex" | "measureIndex" | "offset">): Chord | null {
  return score.parts[target.partIndex]?.measures[target.measureIndex]?.entries.find(
    (entry): entry is Chord => entry instanceof Chord && entry.position.equals(Fraction.fromString(target.offset)),
  ) ?? null;
}

export function resolveInputTarget(score: Score, target: InputTarget): InputTargetResolution {
  const chord = inputTargetChord(score, target);
  if (target.kind === "ghost" || target.toneIndex === null) return { chord, note: null };
  const identified = target.memberId ? chord?.notes.find(note => inputMemberIds.get(note) === target.memberId) : null;
  if (identified) return { chord, note: !identified.rest && identified.pitch === target.focusPitch ? identified : null };
  const note = chord?.notes[target.toneIndex];
  return { chord, note: note && !note.rest && note.pitch === target.focusPitch ? note : null };
}

function pitchOccurrence(chord: Chord, note: Note): number {
  return chord.notes.slice(0, chord.notes.indexOf(note)).filter((item) => !item.rest && item.pitch === note.pitch).length;
}

export function inputTargetFromNote(score: Score, partIndex: number, note: Note, division: NoteTimingDivision): InputTarget {
  const chord = note.chord;
  const tones = chord.notes.filter((item) => !item.rest).sort((a, b) => a.pitch - b.pitch);
  const measureIndex = score.parts[partIndex]?.measures.indexOf(chord.measure) ?? -1;
  return { partIndex, measureIndex: Math.max(0, measureIndex), offset: chord.position.toString(), division,
    lane: "rest", focusPitch: note.rest ? null : note.pitch, verticalIndex: Math.max(0, tones.indexOf(note)),
    kind: note.rest ? "ghost" : "note", memberId: note.rest ? undefined : inputNoteMemberId(note),
    toneIndex: note.rest ? null : chord.notes.indexOf(note),
    pitchOccurrence: pitchOccurrence(chord, note), anchorToneIndex: note.rest ? null : chord.notes.indexOf(note),
    anchorPitch: note.rest ? null : note.pitch, anchorDegree: Number(note.number) || 1,
    anchorOctave: note.jpOctave, octaveOffset: 0 };
}

export function inputTargetFromSnapshot(score: Score, snapshot: InputCursorSnapshot): InputTarget {
  // Strip the session envelope before either branch constructs its target.
  const { targets: _targets, primaryTargetIndex: _primary, ...clean } = snapshot;
  const chord = inputTargetChord(score, snapshot);
  const matching = chord?.notes.filter((note) => !note.rest && note.pitch === snapshot.focusPitch) ?? [];
  const note = matching[0] ?? null;
  const base = note ? inputTargetFromNote(score, snapshot.partIndex, note, snapshot.division) : {
    ...clean, kind: "ghost" as const, toneIndex: null, pitchOccurrence: 0, anchorToneIndex: null,
    anchorPitch: snapshot.focusPitch, anchorDegree: 1, anchorOctave: 0, octaveOffset: 0,
  };
  // Never carry the optional session snapshot recursively into a target.
  return { ...base, ...clean, kind: snapshot.lane === "rest" && note ? "note" : "ghost",
    toneIndex: snapshot.lane === "rest" && note ? base.toneIndex : null };
}

export function inputTargetKey(target: InputTarget): string {
  const at = `${target.partIndex}/${target.measureIndex}/${Fraction.fromString(target.offset)}`;
  return target.kind === "note" ? `${at}/note/${target.memberId ?? `${target.toneIndex}/${target.focusPitch}`}`
    : `${at}/ghost/${target.lane}/${target.anchorPitch}/${target.anchorDegree}/${target.anchorOctave}/${target.octaveOffset}`;
}

export function dedupeInputTargets(targets: readonly InputTarget[]): InputTarget[] {
  return [...new Map(targets.map((target) => [inputTargetKey(target), { ...target }])).values()];
}

/** Rebinding is explicit after serialization: exact time and exact pitch plus
 * same-pitch occurrence identify the result; no nearby pitch/position fallback. */
export function rebindInputTargets(score: Score, targets: readonly InputTarget[]): InputTarget[] {
  return dedupeInputTargets(targets.flatMap((target) => {
    if (target.kind === "ghost") return [{ ...target }];
    const chord = inputTargetChord(score, target);
    const identified = target.memberId ? chord?.notes.find(note => inputMemberIds.get(note) === target.memberId) : null;
    if (identified && (identified.rest || identified.pitch !== target.focusPitch)) return [];
    const note = identified ?? chord?.notes.filter((item) => !item.rest && item.pitch === target.focusPitch)[target.pitchOccurrence];
    if (note && target.memberId) inputMemberIds.set(note, target.memberId);
    return note ? [inputTargetFromNote(score, target.partIndex, note, target.division)] : [];
  }));
}

function ghostFromNote(target: InputTarget, note: Note, lane: "above" | "below"): InputTarget {
  return { ...target, kind: "ghost", toneIndex: null, lane,
    anchorToneIndex: note.chord.notes.indexOf(note), anchorPitch: note.pitch,
    anchorDegree: Number(note.number) || 1, anchorOctave: note.jpOctave, octaveOffset: 0,
    focusPitch: note.pitch };
}

function targetOnPart(score: Score, target: InputTarget, partIndex: number): InputTarget {
  // Explicit navigation into a new row chooses its first visible layer. It
  // is separate from restoring an edit, which must never choose a nearby note.
  const next = { ...target, partIndex, lane: "rest" as const, octaveOffset: 0, anchorToneIndex: null };
  const chord = inputTargetChord(score, next);
  const note = chord?.notes.filter((item) => !item.rest).sort((a, b) => a.pitch - b.pitch)[0];
  return note ? inputTargetFromNote(score, partIndex, note, target.division)
    : { ...next, kind: "ghost", toneIndex: null, focusPitch: null };
}

export function moveInputTargetsVertical(score: Score, targets: readonly InputTarget[], direction: -1 | 1): MultiInputResult {
  const inputs = dedupeInputTargets(targets);
  const result: InputTarget[] = [];
  let blocked = 0;
  for (const target of inputs) {
    const { chord, note } = resolveInputTarget(score, target);
    const tones = chord?.notes.filter((item) => !item.rest).sort((a, b) => a.pitch - b.pitch) ?? [];
    if (target.kind === "note" && !note) { blocked++; result.push(target); continue; }
    const index = target.kind === "ghost" && target.lane !== "rest"
      ? target.lane === "above" ? tones.length : -1 : note ? tones.indexOf(note) : 0;
    const nextIndex = index + (direction < 0 ? 1 : -1);
    if (tones.length === 0 || nextIndex > tones.length || nextIndex < -1) {
      const part = target.partIndex + direction;
      if (part < 0 || part >= score.parts.length) { blocked++; result.push(target); }
      else result.push(targetOnPart(score, target, part));
    } else if (nextIndex === tones.length || nextIndex === -1) {
      result.push(ghostFromNote(target, tones[nextIndex === -1 ? 0 : tones.length - 1], nextIndex === -1 ? "below" : "above"));
    } else result.push(inputTargetFromNote(score, target.partIndex, tones[nextIndex], target.division));
  }
  return { changed: result.filter((target, index) => inputTargetKey(target) !== inputTargetKey(inputs[index])).length,
    blocked, targets: dedupeInputTargets(result), ...(blocked ? { reason: "boundary" as const } : {}) };
}

function tieChain(note: Note): Note[] {
  const seen = new Set<Note>();
  let root = note;
  while (root.tiePrev && !seen.has(root)) { seen.add(root); root = root.tiePrev; }
  const chain: Note[] = [];
  seen.clear();
  let item: Note | null = root;
  while (item && !seen.has(item)) { seen.add(item); chain.push(item); item = item.tieNext; }
  return chain;
}

function applyPitch(score: Score, partIndex: number, note: Note, spec: InputNoteSpec): void {
  const oldPitch = note.pitch;
  const groups = chordArpeggioNoteGroups(note.chord);
  const occurrence = pitchOccurrence(note.chord, note);
  const crossMembers = score.crossPartArpeggios.flatMap(mark => {
    if (mark.measure !== note.chord.measure.index || !mark.offset.equals(note.chord.position)) return [];
    const member = mark.pitches.filter(item => item.part === partIndex && item.pitch === oldPitch)[occurrence];
    return member ? [member] : [];
  });
  note.pitch = spec.pitch;
  note.number = spec.number ?? note.number;
  note.jpOctave = spec.jpOctave ?? note.jpOctave;
  note.jpAlter = spec.jpAlter ?? note.jpAlter;
  note.octave = Math.floor(note.pitch / 12) - 1;
  if (note.displayOctave !== null) note.displayOctave = note.jpOctave;
  if (note.displayAlter !== null) note.displayAlter = note.jpAlter;
  setChordArpeggioPitchGroups(note.chord, groups.map(group => group.map(member => member.pitch)));
  for (const member of crossMembers) member.pitch = note.pitch;
  note.chord.timingOriginal = null;
  note.chord.timingSourceIndex = null;
}

/** Restore from written identities after a whole pitch batch, rather than
 * re-resolving a wave through temporary equal pitches between mutations. */
function capturePitchArpeggios(score: Score): () => boolean {
  const local = score.parts.flatMap(part => part.measures.flatMap(measure => measure.entries.flatMap(entry =>
    entry instanceof Chord && entry.arpeggio ? [{ chord: entry, groups: chordArpeggioNoteGroups(entry) }] : [])));
  const crossMembers = () => score.crossPartArpeggios.flatMap(mark => {
    const available = new Map([...new Set(mark.pitches.map(member => member.part))].map(partIndex => [partIndex,
      score.parts[partIndex]?.measures[mark.measure]?.entries.flatMap(entry =>
        entry instanceof Chord && entry.position.equals(mark.offset)
          ? entry.notes.filter(note => !note.rest && !note.softDeleted) : []) ?? []]));
    return mark.pitches.flatMap(member => {
      const notes = available.get(member.part) ?? [];
      const index = notes.findIndex(note => note.pitch === member.pitch);
      return index < 0 ? [] : [{ mark, member, note: notes.splice(index, 1)[0] }];
    });
  });
  const cross = crossMembers();
  return () => {
    for (const { chord, groups } of local) setChordArpeggioPitchGroups(chord, groups.map(group => group.map(note => note.pitch)));
    for (const { member, note } of cross) member.pitch = note.pitch;
    const restoredCross = crossMembers();
    const faithfulLocal = local.every(({ chord, groups }) => {
      const restored = chordArpeggioNoteGroups(chord);
      return restored.length === groups.length && restored.every((group, index) =>
        group.length === groups[index].length && group.every(note => groups[index].includes(note)));
    });
    return faithfulLocal && cross.length === restoredCross.length && cross.every(({ mark, note }) =>
      restoredCross.some(item => item.mark === mark && item.note === note));
  };
}

/** A tie shares a sounding pitch, while each written segment spells that
 * pitch relative to the key active at its own exact position. */
function applyTiePitch(score: Score, partIndex: number, note: Note, pitch: number): void {
  const fifths = inputKeyAt(score, partIndex, note.chord.measure.index, note.chord.position).fifths;
  const temporary = new Note(new Chord(note.chord.measure));
  temporary.pitch = pitch;
  const spelling = spellPitch(temporary, fifths);
  Object.assign(temporary, spelling);
  temporary.init(fifths, new AccidentalStat(fifths));
  applyPitch(score, partIndex, note, { pitch, number: temporary.number, jpOctave: temporary.jpOctave, jpAlter: temporary.jpAlter });
  Object.assign(note, spelling);
}

function failure(targets: readonly InputTarget[], reason: NonNullable<MultiInputResult["reason"]>, blocked = 1): MultiInputResult {
  return { changed: 0, blocked, targets: dedupeInputTargets(targets), reason };
}

function validTargetPosition(score: Score, target: InputTarget): boolean {
  const measure = score.parts[target.partIndex]?.measures[target.measureIndex];
  if (!measure) return false;
  const offset = Fraction.fromString(target.offset);
  return offset.compareTo(new Fraction(0)) >= 0
    && offset.compareTo(new Fraction(measure.time.beats * 4, measure.time.beatType)) < 0;
}

/** Mutates only the caller's disposable draft. A blocked result must be
 * discarded, never serialized/published, by the transaction owner. */
export function applyInputTargetsDegree(score: Score, targets: readonly InputTarget[], degree: 1 | 2 | 3 | 4 | 5 | 6 | 7,
  durationOf: InputTargetDuration = (target) => noteTimingStep(target.division), explicitOctave?: number): MultiInputResult {
  return applyInputTargetsPitch(score, targets, (target, note) => {
    let octave = explicitOctave ?? (target.kind === "note" ? note?.jpOctave ?? 0 : target.anchorOctave + target.octaveOffset);
    if (explicitOctave === undefined && target.kind === "ghost" && target.lane === "above" && degree <= target.anchorDegree) octave++;
    if (explicitOctave === undefined && target.kind === "ghost" && target.lane === "below" && degree >= target.anchorDegree) octave--;
    return inputDegreeSpec(score, inputTargetCursor(target), degree, octave);
  }, durationOf);
}

/** Advance each selected numbered note by one scale degree, including the
 * 7/1 octave boundary. This is independent of staff chromatic movement. */
export function applyInputTargetsDegreeStep(score: Score, targets: readonly InputTarget[], direction: -1 | 1): MultiInputResult {
  const inputs = dedupeInputTargets(targets);
  if (inputs.some(target => !validTargetPosition(score, target))) return failure(inputs, "missing-target");
  const nextSpec = (target: InputTarget, note: Note | null): InputNoteSpec => {
    const degree = Number(note?.number ?? target.anchorDegree) || 1;
    const octave = note?.jpOctave ?? target.anchorOctave + target.octaveOffset;
    const index = octave * 7 + degree - 1 + direction;
    return inputDegreeSpec(score, inputTargetCursor(target),
      (((index % 7) + 7) % 7 + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7, Math.floor(index / 7));
  };
  const real = inputs.filter(target => target.kind === "note");
  const pending = inputs.filter(target => target.kind === "ghost").map(target => ({ target, spec: nextSpec(target, null) }));
  if (pending.some(({ spec }) => spec.pitch < 0 || spec.pitch > 127)) return failure(inputs, "boundary");
  const edited = real.length ? applyInputTargetsPitch(score, real, nextSpec)
    : { changed: 0, blocked: 0, targets: [] };
  if (edited.blocked) return { ...edited, targets: inputs };
  const outputs = new Map(edited.targets.map((target, index) => [inputTargetKey(real[index]), target]));
  for (const { target, spec } of pending) outputs.set(inputTargetKey(target), {
    ...target, focusPitch: spec.pitch, anchorPitch: spec.pitch, anchorDegree: Number(spec.number),
    anchorOctave: spec.jpOctave!, octaveOffset: 0, staffStep: undefined, staffOctave: undefined,
  });
  return { changed: inputs.length, blocked: 0, verifyTimings: real.length > 0,
    ...(real.length ? {} : { sessionOnly: true }),
    targets: inputs.map(target => outputs.get(inputTargetKey(target))!) };
}

/** Exact note identities and all-or-nothing insertion are shared by numeric,
 * three-register and named-pitch input. Callers publish only a verified draft. */
export function applyInputTargetsPitch(score: Score, targets: readonly InputTarget[],
  pitchFor: (target: InputTarget, note: Note | null) => InputTargetPitchSpec,
  durationOf: InputTargetDuration = (target) => noteTimingStep(target.division)): MultiInputResult {
  const inputs = dedupeInputTargets(targets);
  if (inputs.some((target) => !validTargetPosition(score, target))) return failure(inputs, "missing-target");
  const plans = inputs.map((target) => {
    const { chord, note } = resolveInputTarget(score, target);
    return { target, chord, note, spec: pitchFor(target, note) };
  });
  if (plans.some(({ target, note }) => target.kind === "note" && !note)) return failure(inputs, "missing-target");
  if (plans.some(({ spec }) => !Number.isInteger(spec.pitch) || spec.pitch < 0 || spec.pitch > 127)) return failure(inputs, "boundary");
  const applySpelling = (note: Note, spec: InputTargetPitchSpec): void => {
    if (spec.step !== undefined && spec.octave !== undefined) {
      note.step = spec.step; note.octave = spec.octave;
      note.alter = spec.alter ?? spec.pitch - (spec.octave + 1) * 12 - MusicCommon.stepToPitch(spec.step);
    }
  };
  const ghostKeys = new Set<string>();
  for (const { target, chord, spec } of plans) {
    if (target.kind !== "ghost") continue;
    const key = `${target.partIndex}/${target.measureIndex}/${target.offset}/${spec.pitch}`;
    const projectedNote = plans.some((plan) => plan.target.kind === "note" && plan.spec.pitch === spec.pitch
      && plan.target.partIndex === target.partIndex && plan.target.measureIndex === target.measureIndex
      && Fraction.fromString(plan.target.offset).equals(Fraction.fromString(target.offset)));
    if (ghostKeys.has(key) || projectedNote || chord?.notes.some((note) => !note.rest && note.pitch === spec.pitch))
      return failure(inputs, "occupied-target");
    ghostKeys.add(key);
  }
  const restoreArpeggios = capturePitchArpeggios(score);
  const outputs: Array<{ target: InputTarget; note: Note }> = [];
  const edited = new Set<Note>();
  for (const { target, chord, note, spec } of plans) {
    if (target.kind === "note" && note) {
      // Match single-cursor input: an existing semantic tie takes precedence
      // over the continuation replacement fallback, keeping the chain linked.
      if (note.tiePrev || note.tieNext) {
        for (const member of tieChain(note)) if (!edited.has(member)) {
          applyTiePitch(score, target.partIndex, member, spec.pitch);
          applySpelling(member, spec);
          edited.add(member);
        }
        outputs.push({ target, note });
      } else if (chord?.generatedTimingContinuation || chord?.transparentContinuation) {
        const replaced = replaceInputContinuationAtCursor(score, inputTargetCursor(target), spec, note.pitch);
        if (!replaced.changed || !replaced.note) return failure(inputs, "incompatible-target");
        applySpelling(replaced.note, spec);
        outputs.push({ target, note: replaced.note });
      } else {
        for (const member of tieChain(note)) if (!edited.has(member)) {
          applyPitch(score, target.partIndex, member, spec); applySpelling(member, spec); edited.add(member);
        }
        outputs.push({ target, note });
      }
    } else {
      const inserted = insertInputNoteWithDuration(score, inputTargetCursor(target), spec, durationOf(target, chord));
      if (inserted.blocked || !inserted.changed || !inserted.note) return failure(inputs, "incompatible-target");
      applySpelling(inserted.note, spec);
      if (inserted.chord && inserted.chord.notes.filter((member) => !member.rest).length > 1) {
        // Match single-cursor chord input: these ornaments describe one
        // sounding tone and cannot remain attached to a new vertical chord.
        inserted.chord.ornaments = inserted.chord.ornaments.filter((ornament) =>
          ornament.kind !== "upper-mordent" && ornament.kind !== "lower-mordent" && ornament.kind !== "trill");
      }
      outputs.push({ target, note: inserted.note });
    }
  }
  if (!restoreArpeggios()) return failure(inputs, "incompatible-target");
  for (const partIndex of new Set(outputs.map(({ target }) => target.partIndex))) {
    const part = score.parts[partIndex];
    refreshInputAccidentals(score, partIndex, new Set(outputs.filter(({ target }) => target.partIndex === partIndex)
      .flatMap(({ note }) => tieChain(note).map(member => part.measures.indexOf(member.chord.measure)))));
  }
  return { changed: outputs.length, blocked: 0, verifyTimings: true,
    targets: dedupeInputTargets(outputs.map(({ target, note }) => inputTargetFromNote(score, target.partIndex, note, target.division))) };
}

export function applyInputTargetsOctave(score: Score, targets: readonly InputTarget[], delta: -1 | 1): MultiInputResult {
  const inputs = dedupeInputTargets(targets);
  if (inputs.some((target) => !validTargetPosition(score, target))) return failure(inputs, "missing-target");
  const plans = inputs.map((target) => ({ target, ...resolveInputTarget(score, target) }));
  if (plans.some(({ target, note }) => target.kind === "note" && !note)) return failure(inputs, "missing-target");
  for (const { target, note } of plans) {
    const pitches = note ? tieChain(note).map((member) => member.pitch + delta * 12)
      : [target.anchorPitch !== null ? target.anchorPitch + (target.octaveOffset + delta) * 12
        : inputDegreeSpec(score, inputTargetCursor(target),
          Math.max(1, Math.min(7, target.anchorDegree)) as 1 | 2 | 3 | 4 | 5 | 6 | 7,
          target.anchorOctave + target.octaveOffset + delta).pitch];
    if (pitches.some((pitch) => !Number.isInteger(pitch) || pitch < 0 || pitch > 127)) return failure(inputs, "boundary");
  }
  const restoreArpeggios = capturePitchArpeggios(score);
  const edited = new Set<Note>();
  for (const { target, note } of plans) if (note) for (const member of tieChain(note)) {
    if (edited.has(member)) continue;
    edited.add(member);
    applyPitch(score, target.partIndex, member, { pitch: member.pitch + delta * 12, jpOctave: member.jpOctave + delta });
  }
  if (!restoreArpeggios()) return failure(inputs, "incompatible-target");
  for (const partIndex of new Set(inputs.map(target => target.partIndex))) {
    const part = score.parts[partIndex];
    refreshInputAccidentals(score, partIndex, new Set([...edited].filter(note => part.measures.includes(note.chord.measure))
      .map(note => part.measures.indexOf(note.chord.measure))));
  }
  return { changed: inputs.length, blocked: 0, verifyTimings: inputs.some(target => target.kind === "note"),
    ...(inputs.every((target) => target.kind === "ghost") ? { sessionOnly: true } : {}),
    targets: dedupeInputTargets(plans.map(({ target, note }) =>
    note ? inputTargetFromNote(score, target.partIndex, note, target.division)
      : { ...target, octaveOffset: target.octaveOffset + delta,
        focusPitch: (target.focusPitch ?? (target.anchorPitch !== null ? target.anchorPitch + target.octaveOffset * 12
          : inputDegreeSpec(score, inputTargetCursor(target),
            Math.max(1, Math.min(7, target.anchorDegree)) as 1 | 2 | 3 | 4 | 5 | 6 | 7,
            target.anchorOctave + target.octaveOffset).pitch)) + delta * 12,
        ...(target.staffOctave !== undefined ? { staffOctave: target.staffOctave + delta } : {}) })) };
}

/** Delete exact, pre-resolved sounding notes. Existing empty destinations
 * remain empty: deleting a ghost must never delete its neighbouring anchor.
 * The resulting ghosts keep each deleted note's register for the next digit. */
export function deleteInputTargets(score: Score, targets: readonly InputTarget[]): MultiInputResult {
  const inputs = dedupeInputTargets(targets);
  if (inputs.some((target) => !validTargetPosition(score, target))) return failure(inputs, "missing-target");
  const plans = inputs.map((target) => ({ target, ...resolveInputTarget(score, target) }));
  if (plans.some(({ target, note }) => target.kind === "note" && !note)) return failure(inputs, "missing-target");
  // Capture the register and duration before deletion detaches ties, removes
  // chords or shifts a neighbouring tone's index in the same chord.
  const prepared = plans.map(({ target, chord, note }) => ({ target, note,
    chain: note ? tieChain(note) : [], duration: chord?.duration ?? noteTimingStep(target.division),
    output: note ? { ...target, kind: "ghost" as const, toneIndex: null, lane: "rest" as const,
      anchorToneIndex: null, anchorPitch: note.pitch, anchorDegree: Number(note.number) || 1,
      anchorOctave: note.jpOctave, octaveOffset: 0, focusPitch: null, pitchOccurrence: 0, verticalIndex: 0 }
      : { ...target },
  }));
  const deleted = new Set<Note>();
  let changed = 0;
  for (const { target, note, chain, duration } of prepared) {
    if (!note) continue;
    changed++;
    if (deleted.has(note)) continue;
    const result = inputRestAtCursor(score, inputTargetCursor(target), duration, note);
    if (!result.changed) return failure(inputs, "incompatible-target");
    for (const member of chain) deleted.add(member);
  }
  return { changed, blocked: 0, targets: dedupeInputTargets(prepared.map(({ output }) => output)) };
}

export function applyInputTargetsToPart(score: Score, targets: readonly InputTarget[], direction: -1 | 1): MultiInputResult {
  const inputs = dedupeInputTargets(targets);
  if (inputs.some((target) => !validTargetPosition(score, target))) return failure(inputs, "missing-target");
  const plans = inputs.map((target) => ({ target, ...resolveInputTarget(score, target) }));
  if (plans.some(({ target }) => target.partIndex + direction < 0 || target.partIndex + direction >= score.parts.length))
    return failure(inputs, "boundary");
  if (plans.some(({ target, note }) => target.kind === "note" && !note)) return failure(inputs, "missing-target");
  const leavingNotes = new Set(plans.flatMap(({ note }) => note ? [note] : []));
  for (const { target, note } of plans) if (note) {
    const destination = inputTargetChord(score, { ...target, partIndex: target.partIndex + direction });
    if (destination?.notes.some((other) => !other.rest && other.pitch === note.pitch && !leavingNotes.has(other)))
      return failure(inputs, "occupied-target");
  }
  const outputs: InputTarget[] = [];
  // Resolve every note before changing chords: removing an earlier tone must
  // not cause a later tone's ordinal to resolve to an unrelated neighbour.
  const movedNotes: Array<{ target: InputTarget; note: Note; partIndex: number }> = [];
  // Vacate the furthest destination first when adjacent selected rows move
  // together, allowing a selected equal-pitch note to move out of the way.
  const moveOrder = [...plans].sort((a, b) => direction * (b.target.partIndex - a.target.partIndex));
  for (const { target, chord, note } of moveOrder) {
    const partIndex = target.partIndex + direction;
    if (target.kind === "ghost") {
      const destination = score.parts[partIndex]?.measures[target.measureIndex];
      if (!destination || !validTargetPosition(score, { ...target, partIndex })) return failure(inputs, "incompatible-target");
      outputs.push({ ...target, partIndex, anchorToneIndex: null });
    } else if (note && chord) {
      const destination = inputTargetChord(score, { ...target, partIndex });
      if (destination?.notes.some((other) => !other.rest && other.pitch === note.pitch)) return failure(inputs, "occupied-target");
      const moved = moveInputNoteToPart(score, target.partIndex, chord, note, partIndex);
      if (!moved.changed || !moved.note) return failure(inputs, "incompatible-target");
      movedNotes.push({ target, note: moved.note, partIndex });
    }
  }
  // Preserve caller ordering, including ghosts interspersed with real notes.
  const byOriginal = new Map(movedNotes.map(({ target, note, partIndex }) =>
    [inputTargetKey(target), inputTargetFromNote(score, partIndex, note, target.division)]));
  const ghostByOriginal = new Map(outputs.map((target) => [inputTargetKey({ ...target, partIndex: target.partIndex - direction }), target]));
  return { changed: inputs.length, blocked: 0, ...(inputs.every((target) => target.kind === "ghost") ? { sessionOnly: true } : {}),
    targets: dedupeInputTargets(inputs.map((target) =>
    byOriginal.get(inputTargetKey(target)) ?? ghostByOriginal.get(inputTargetKey(target))!)) };
}


/** A batch timing gesture is meaningful only for real notes whose logical
 * attacks share one exact position, even when they belong to different parts. */
export function inputTargetsShareOnset(score: Score, targets: readonly InputTarget[]): boolean {
  const inputs = dedupeInputTargets(targets);
  if (inputs.length < 2) return false;
  const roots = inputs.map(target => {
    const note = resolveInputTarget(score, target).note;
    return note ? tieChain(note)[0] : null;
  });
  return roots.every(root => root !== null && root.absoluteTick.equals(roots[0]!.absoluteTick));
}

export function editInputTargetsTiming(score: Score, targets: readonly InputTarget[],
  operation: "resize" | "move", delta: Fraction, writtenDurationFor?: (note: Note) => Fraction): MultiInputResult {
  const inputs = dedupeInputTargets(targets);
  if (!inputTargetsShareOnset(score, inputs)) return failure(inputs, "incompatible-target");
  const plans = inputs.map(target => ({ target, note: tieChain(resolveInputTarget(score, target).note!)[0] }));
  if (operation === "move" && delta.compareTo(new Fraction(0)) > 0) {
    // Match the single-cursor command: rightward movement may append a real
    // trailing bar, but it never changes an existing bar's fixed duration.
    for (const { target, note } of plans) {
      const chain = tieChain(note);
      const tail = chain[chain.length - 1];
      const step = note.tuplet ? note.tuplet.actualMemberDuration(note.tuplet.writtenUnit ?? delta) : delta;
      const end = tail.absoluteTick.plus(tail.chord.duration ?? new Fraction(0)).plus(step);
      const part = score.parts[target.partIndex];
      for (let guard = 0; guard < 4; guard++) {
        const last = part.measures[part.measures.length - 1];
        if (!last || last.position.plus(last.duration).compareTo(end) >= 0) break;
        ensureInputMeasure(score, target.partIndex, part.measures.length);
      }
    }
  }
  const result = editSameOnsetNoteTimings(score, plans.map(({ target, note }) => ({
    partIndex: target.partIndex, note, grace: false,
  })), operation, delta, writtenDurationFor);
  return { ...result, verifyTimings: result.changed > 0,
    targets: dedupeInputTargets(plans.map(({ target, note }) =>
      inputTargetFromNote(score, target.partIndex, note, target.division))) };
}


/** Per-note duration, independent of the other members sharing any tied
 * segment. Used by the shared notation/staff duration menu and dot toggle. */
export function inputNoteWrittenDuration(note: Note): Fraction {
  return tieChain(note).reduce((duration, member) => duration.plus(member.tuplet
    ? member.tuplet.writtenMemberDuration(member.chord.duration ?? new Fraction(0))
    : member.chord.duration ?? new Fraction(0)), new Fraction(0));
}

export function setInputTargetsWrittenDuration(score: Score, targets: readonly InputTarget[],
  durationFor: (note: Note) => Fraction): MultiInputResult {
  return editInputTargetsTiming(score, targets, "resize", new Fraction(0), durationFor);
}
