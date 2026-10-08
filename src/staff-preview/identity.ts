import { Chord, type Note, type Score } from "../score/score";
import type { JpwSourceNote } from "../editor/note-selection";
import type { StaffNoteRegistry, StaffNoteTarget } from "./types";

/** A model-scoped identity map. No ids are written into score files. */
export function createStaffNoteRegistry(
  score: Score, sources: readonly JpwSourceNote[], revision: number,
): StaffNoteRegistry {
  const direct = new Map(sources.map(source => [source.note, source]));
  const byNote = new WeakMap<Note, StaffNoteTarget>();
  const byId = new Map<string, StaffNoteTarget>();
  const targets: StaffNoteTarget[] = [];
  score.parts.forEach((part, partIndex) => part.measures.forEach((measure, measureIndex) => {
    measure.entries.forEach((entry, entryIndex) => {
      if (!(entry instanceof Chord)) return;
      const add = (note: Note, noteIndex: number, grace: boolean): void => {
        if (note.softDeleted) return;
        let source = direct.get(note) ?? null;
        if (!source) {
          let root = note;
          const visited = new Set<Note>();
          while (root.tiePrev && !visited.has(root)) {
            visited.add(root);
            root = root.tiePrev;
          }
          source = direct.get(root) ?? null;
        }
        const id = `p${partIndex}m${measureIndex}e${entryIndex}${grace ? "g" : "n"}${noteIndex}`;
        const target: StaffNoteTarget = {
          ref: { revision, id }, note, source, partIndex, measureIndex, entryIndex, noteIndex, grace,
        };
        byNote.set(note, target);
        byId.set(id, target);
        targets.push(target);
      };
      entry.notes.forEach((note, index) => add(note, index, false));
      entry.graceNotes.forEach((note, index) => add(note, index, true));
    });
  }));
  return {
    targets,
    refFor: note => byNote.get(note)?.ref ?? null,
    resolve: ref => ref.revision === revision ? byId.get(ref.id) ?? null : null,
  };
}
