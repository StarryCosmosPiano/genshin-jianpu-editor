import { Part, Score } from "./score";

/** Base instrument name shared by score exports and per-part track labels. */
export function scorePartBaseName(score: Score, part: Part, index: number): string {
  const explicit = part.instrumentName.trim() || score.instrumentName.trim();
  if (explicit) return explicit;
  return score.piano ? "钢琴" : `声部${index + 1}`;
}

/**
 * Give every row of a multi-voice instrument a stable, application-neutral
 * name. The suffix is based on score order because legacy paired-piano Parts
 * both have voiceIndex=1.
 */
export function scorePartTrackName(score: Score, part: Part, index: number): string {
  const base = scorePartBaseName(score, part, index);
  const siblings = score.parts
    .map((candidate, candidateIndex) => ({
      part: candidate,
      index: candidateIndex,
      base: scorePartBaseName(score, candidate, candidateIndex),
    }))
    .filter((candidate) => candidate.base === base);
  if (siblings.length <= 1) return base;
  const voice = siblings.findIndex((candidate) => candidate.part === part) + 1;
  return `${base}V${Math.max(1, voice)}`;
}
