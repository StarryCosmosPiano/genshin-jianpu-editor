import type { Chord, Note } from "./score";

/** Resolve each rolled subset to distinct written note occurrences. Keeping
 * groups separate prevents two disjoint braces from becoming one long wave. */
export function chordArpeggioNoteGroups(chord: Chord): Note[][] {
  if (!chord.arpeggio) return [];
  const notes = chord.notes.filter(note => !note.rest && !note.softDeleted);
  const groups = chord.arpeggioPitchGroups?.length
    ? chord.arpeggioPitchGroups
    : [chord.arpeggioPitches ?? notes.map(note => note.pitch)];
  const remaining = [...notes];
  const allowed = chord.arpeggioPitches ? [...chord.arpeggioPitches] : null;
  return groups.flatMap(group => {
    const selected: Note[] = [];
    for (const pitch of group) {
      const allowedIndex = allowed?.indexOf(pitch) ?? 0;
      if (allowedIndex < 0) continue;
      const index = remaining.findIndex(note => note.pitch === pitch);
      if (index < 0) continue;
      selected.push(remaining.splice(index, 1)[0]);
      allowed?.splice(allowedIndex, 1);
    }
    return selected.length >= 2 ? [selected] : [];
  });
}

export function chordArpeggioPitchGroups(chord: Chord): number[][] {
  return chordArpeggioNoteGroups(chord).map(group => group.map(note => note.pitch));
}

/** Keep the legacy union in sync for older callers and file readers. */
export function setChordArpeggioPitchGroups(chord: Chord, groups: readonly (readonly number[])[]): void {
  const candidates = groups.filter(group => group.length >= 2).map(group => [...group]);
  chord.arpeggio = candidates.length > 0;
  chord.arpeggioPitchGroups = candidates.length > 1 ? candidates : null;
  chord.arpeggioPitches = candidates.length > 0 ? candidates.flat() : null;
  const valid = chordArpeggioPitchGroups(chord);
  chord.arpeggio = valid.length > 0;
  chord.arpeggioPitchGroups = valid.length > 1 ? valid : null;
  chord.arpeggioPitches = valid.length > 0 ? valid.flat() : null;
}
