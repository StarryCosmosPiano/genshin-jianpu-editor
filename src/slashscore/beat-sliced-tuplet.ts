/**
 * Beat-local projection for a voice-scoped Tuplet that crosses slash-group
 * boundaries.  This module deliberately has no dependency on slashscore's
 * parser types: the caller can map the returned records onto TimedEvent.
 *
 * The source annotation remains the authority for the Tuplet's written
 * members.  A beat slice only decides which attacks are emitted in this
 * slash group; member spans are never shortened at a beat boundary.  A member
 * that began in an earlier slice is omitted; the caller sustains its previous
 * event without creating another attack.
 */

export interface BeatSlicedAtom {
  pitches: number[];
  pitchVoices?: number[];
  restVoiceIndexes?: number[];
  nominalDuration?: number;
}

export interface BeatSlicedOrdinaryTiming {
  part: number;
  offset: number;
  duration: number;
  rest: boolean;
}

export interface BeatSlicedTupletAnnotation {
  part: number;
  voice: number;
  measure: number;
  offset: number;
  end: number;
  members: number[];
  memberRests?: boolean[];
  /** Ordinary events sharing the visible bracket, in actual-score time. */
  ordinary?: BeatSlicedOrdinaryTiming[];
}

export interface BeatSlicedTimedEvent {
  start: number;
  end: number;
  pitches: number[];
  voiceIndex: number;
  rest: boolean;
  /** Stable across all beat slices belonging to one source Tuplet. */
  tripletGroup?: string;
  tripletIndex?: number;
  tripletEnd?: number;
  tripletCrossBeat?: boolean;
  /** Ordinary material is intentionally outside Tuplet semantics. */
  ordinary: boolean;
}

export interface BeatSlicedTupletInput {
  atoms: readonly BeatSlicedAtom[];
  annotations: readonly BeatSlicedTupletAnnotation[];
  groupOffset: number;
  targetDuration: number;
  measureIndex: number;
  absoluteStart: number;
  sourceGroupKey: string;
  epsilon?: number;
}

const DEFAULT_EPSILON = 1e-8;

function memberIntervals(annotation: BeatSlicedTupletAnnotation): Array<{
  start: number;
  end: number;
  index: number;
}> {
  let cursor = annotation.offset;
  return annotation.members.map((written, index) => {
    const start = cursor;
    const end = Math.min(annotation.end, start + written * 2 / 3);
    cursor = end;
    return { start, end, index };
  });
}

/**
 * Project all Tuplet and ordinary attacks belonging to one visible slash
 * group.  The returned Tuplet member keeps its full actual end even when it
 * crosses the group boundary; only attacks whose start lies in this slice are
 * emitted. The caller carries an earlier member's sustain into the current
 * group when no new attack is returned.
 */
export function sliceBeatTupletEvents(input: BeatSlicedTupletInput): BeatSlicedTimedEvent[] {
  const epsilon = input.epsilon ?? DEFAULT_EPSILON;
  const sliceStart = input.groupOffset;
  const sliceEnd = sliceStart + input.targetDuration;
  const result: BeatSlicedTimedEvent[] = [];
  const seen = new Set<string>();
  const atomsByVoice = new Map<number, BeatSlicedAtom[]>();
  for (const atom of input.atoms) {
    const voices = new Set<number>(atom.pitchVoices ?? []);
    for (const voice of atom.restVoiceIndexes ?? []) voices.add(voice);
    if (voices.size === 0) voices.add(0);
    for (const voice of voices) {
      const list = atomsByVoice.get(voice) ?? [];
      list.push(atom);
      atomsByVoice.set(voice, list);
    }
  }
  const atomIndexes = new Map<number, number>();

  const add = (event: BeatSlicedTimedEvent): void => {
    const key = `${event.voiceIndex}:${event.start}:${event.end}:${event.tripletGroup ?? "ordinary"}:${event.tripletIndex ?? -1}:${event.rest}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push(event);
  };

  type Request = {
    annotation: BeatSlicedTupletAnnotation;
    voice: number;
    offset: number;
    end: number;
    memberIndex?: number;
    ordinary?: BeatSlicedOrdinaryTiming;
  };
  const requests: Request[] = [];
  for (const annotation of input.annotations) {
    if (annotation.measure !== input.measureIndex || annotation.members.length === 0) continue;
    const intervals = memberIntervals(annotation);
    for (const member of intervals) {
      if (member.end <= sliceStart + epsilon || member.start >= sliceEnd - epsilon) continue;
      if (member.start < sliceStart - epsilon) continue;
      requests.push({ annotation, voice: annotation.part, offset: member.start, end: member.end, memberIndex: member.index });
    }
    for (const ordinary of annotation.ordinary ?? []) {
      if (ordinary.part < 0
        || ordinary.offset < sliceStart - epsilon
        || ordinary.offset >= sliceEnd - epsilon) continue;
      requests.push({ annotation, voice: ordinary.part, offset: ordinary.offset, end: ordinary.offset + ordinary.duration, ordinary });
    }
  }
  requests.sort((left, right) => left.offset - right.offset
    || Number(Boolean(left.ordinary)) - Number(Boolean(right.ordinary))
    || left.voice - right.voice
    || (left.memberIndex ?? -1) - (right.memberIndex ?? -1));
  const consumedRequests = new Set<string>();
  for (const request of requests) {
    // Overlapping tuplets can each describe the same parallel ordinary
    // attack. Deduplicate before consuming a source atom, not afterwards.
    const requestKey = `${request.voice}:${request.offset}:${request.end}:${request.memberIndex ?? "ordinary"}`;
    if (consumedRequests.has(requestKey)) continue;
    consumedRequests.add(requestKey);
    const list = atomsByVoice.get(request.voice) ?? [];
    const index = atomIndexes.get(request.voice) ?? 0;
    const atom = list[index];
    atomIndexes.set(request.voice, index + (atom ? 1 : 0));
    const pitches = atom
      ? atom.pitches.filter((_pitch, pitchIndex) => (atom.pitchVoices?.[pitchIndex] ?? request.voice) === request.voice)
      : [];
    const isRest = pitches.length === 0;
    const group = `${input.measureIndex}:beat-slices:v${request.annotation.part}:${request.annotation.offset}`;
    add({
      start: input.absoluteStart + request.offset - input.groupOffset,
      end: input.absoluteStart + request.end - input.groupOffset,
      pitches,
      voiceIndex: request.voice,
      rest: isRest,
      ...(request.memberIndex !== undefined ? {
        tripletGroup: group,
        tripletIndex: request.memberIndex,
        tripletEnd: input.absoluteStart + request.end - input.groupOffset,
        tripletCrossBeat: true,
      } : {}),
      ordinary: request.ordinary !== undefined,
    });
  }

  return result.sort((left, right) => left.start - right.start
    || Number(left.ordinary) - Number(right.ordinary)
    || left.voiceIndex - right.voiceIndex
    || (left.tripletIndex ?? -1) - (right.tripletIndex ?? -1));
}
