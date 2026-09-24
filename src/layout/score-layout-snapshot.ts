import { Fraction } from "../common/fraction";
import {
  Chord, Entry, Key, Note, Score, Time, Tuplet,
} from "../score/score";

/** Stable addresses and measure signatures for reusing a previous layout. */
export interface ScoreLayoutSnapshot {
  /** Exact signature for score-wide layout inputs; compare before measureKeys. */
  globalKey: string;
  /** Indexed like score.parts[part].measures[measure]. */
  measureKeys: string[][];
  /** Resolve old PageItem.data through new.models.get(old.modelKeys.get(data)). */
  modelKeys: Map<object, string>;
  models: Map<string, object>;
}

function measureAtAddress(address: string): string | null {
  const match = /^s\/p(\d+)\/m(\d+)(?:\/|$)/.exec(address);
  return match ? `${match[1]}/${match[2]}` : null;
}

function isLink(owner: unknown, key: string): boolean {
  return (owner instanceof Entry && key === "measure")
    || (owner instanceof Note && (key === "chord" || key === "tieNext" || key === "tiePrev"))
    || (owner instanceof Chord && key === "slurEndChord")
    || (owner instanceof Tuplet && (key === "first" || key === "last"));
}

export function buildScoreLayoutSnapshot(score: Score): ScoreLayoutSnapshot {
  const modelKeys = new Map<object, string>();
  const models = new Map<string, object>();
  const register = (model: object, address: string): void => {
    if (modelKeys.has(model)) return;
    modelKeys.set(model, address);
    models.set(address, model);
  };

  // Register just the model objects that layout can retain. Fractions and
  // collection wrappers are values: a shared Fraction must not become a
  // cross-measure dependency merely because it shares an instance.
  register(score, "s");
  score.parts.forEach((part, partIndex) => {
    const partAddress = `s/p${partIndex}`;
    register(part, partAddress);
    part.measures.forEach((measure, measureIndex) => {
      const measureAddress = `${partAddress}/m${measureIndex}`;
      register(measure, measureAddress);
      register(measure.key, `${measureAddress}/key`);
      register(measure.time, `${measureAddress}/time`);
      measure.entries.forEach((entry, entryIndex) => {
        const entryAddress = `${measureAddress}/e${entryIndex}`;
        register(entry, entryAddress);
        if (!(entry instanceof Chord)) return;
        entry.ornaments.forEach((ornament, index) => register(ornament,
          `${entryAddress}/o${index}`));
        for (const [listName, notes] of [
          ["n", entry.notes], ["g", entry.graceNotes],
        ] as const) {
          notes.forEach((note, noteIndex) => {
            const noteAddress = `${entryAddress}/${listName}${noteIndex}`;
            register(note, noteAddress);
            note.lyrics.forEach((lyric, lyricIndex) => register(lyric,
              `${noteAddress}/l${lyricIndex}`));
            if (note.tuplet) register(note.tuplet, `${noteAddress}/t`);
          });
        }
      });
    });
  });
  score.tempoMarks.forEach((mark, index) => register(mark, `s/tempo${index}`));
  score.keyMarks.forEach((mark, index) => register(mark, `s/key${index}`));
  score.textMarks.forEach((mark, index) => register(mark, `s/text${index}`));
  score.crossPartArpeggios.forEach((mark, index) => register(mark, `s/arpeggio${index}`));
  score.credit.forEach((credit, index) => register(credit, `s/credit${index}`));

  const omittedScoreFields = new Set([
    "parts", "tempoMarks", "keyMarks", "textMarks", "crossPartArpeggios",
    // Timing edits are source bookkeeping; the transformed chords are above.
    "noteTimingEdits",
  ]);

  function serialize(
    root: object,
    ownerMeasure: string | null = null,
    dependencies?: Set<string>,
    omitted?: ReadonlySet<string>,
  ): string {
    const seen = new Set<object>();
    const localSeen = new Map<object, number>();
    const emittedRefs = new WeakSet<object>();
    const emitRef = (kind: "$ref" | "$localRef", target: string | number): object => {
      const ref = { [kind]: target };
      emittedRefs.add(ref);
      return ref;
    };
    return JSON.stringify(root, function (this: unknown, key, value: unknown): unknown {
      if (this === root && omitted?.has(key)) return undefined;
      if (this instanceof Chord && key === "beamGroup") return undefined;
      if (value === null || typeof value !== "object") return value;
      if (value instanceof Fraction || value instanceof Key || value instanceof Time) return value;
      if (emittedRefs.has(value)) return value;

      const address = modelKeys.get(value);
      if (address) {
        const targetMeasure = measureAtAddress(address);
        if (targetMeasure && targetMeasure !== ownerMeasure) {
          dependencies?.add(targetMeasure);
          return emitRef("$ref", address);
        }
        if (isLink(this, key) || seen.has(value)) return emitRef("$ref", address);
        seen.add(value);
        return value;
      }

      // Older edits and imports may retain a tie/slur endpoint that is no
      // longer in any Measure.entries. Preserve its full first occurrence and
      // use a local address when its Note <-> Chord back links revisit it.
      const localId = localSeen.get(value);
      if (localId !== undefined) return emitRef("$localRef", localId);
      localSeen.set(value, localSeen.size);
      if (value instanceof Set) return [...value].sort();
      if (value instanceof Map) return [...value.entries()];
      return value;
    });
  }

  const globalKey = serialize(score, null, undefined, omittedScoreFields)
    + serialize(score.tempoMarks) + serialize(score.keyMarks);
  const partSignatures = score.parts.map((part) => serialize(part, null, undefined, new Set(["measures"])));

  const textMarksByMeasure = new Map<number, Array<[number, string]>>();
  score.textMarks.forEach((mark, index) => {
    const list = textMarksByMeasure.get(mark.measure) ?? [];
    list.push([index, serialize(mark)]);
    textMarksByMeasure.set(mark.measure, list);
  });
  const arpeggiosByMeasure = new Map<number, Array<[number, string]>>();
  score.crossPartArpeggios.forEach((mark, index) => {
    const list = arpeggiosByMeasure.get(mark.measure) ?? [];
    list.push([index, serialize(mark)]);
    arpeggiosByMeasure.set(mark.measure, list);
  });

  const dependencies: Array<Array<Set<string>>> = [];
  const baseKeys = score.parts.map((part, partIndex) => part.measures.map((measure, measureIndex) => {
    const dep = new Set<string>();
    (dependencies[partIndex] ??= [])[measureIndex] = dep;
    return serialize(measure, `${partIndex}/${measureIndex}`, dep);
  }));
  const measureKeys = score.parts.map((part, partIndex) => part.measures.map((_measure, measureIndex) => {
    const related = [...dependencies[partIndex][measureIndex]].sort().map((target) => {
      const [targetPart, targetMeasure] = target.split("/").map(Number);
      return [target, baseKeys[targetPart]?.[targetMeasure] ?? "missing"];
    });
    return JSON.stringify([
      partIndex, measureIndex, partSignatures[partIndex],
      baseKeys[partIndex][measureIndex],
      textMarksByMeasure.get(measureIndex) ?? [],
      arpeggiosByMeasure.get(measureIndex) ?? [], related,
    ]);
  }));

  return { globalKey, measureKeys, modelKeys, models };
}
