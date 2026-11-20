import type { DropReason, SeqRange } from "./types";

/** Seqs of one source that were given up for one reason, as half-open ranges. */
export type DropGroup = { readonly source: string; readonly reason: DropReason; readonly ranges: readonly SeqRange[] };
type Group = { readonly source: string; readonly reason: DropReason; ranges: SeqRange[] };

/** The seqs this client gave up on and has not yet named in a `telemetry_dropped` record. */
export class DropList {
  #groups: Group[] = [];

  get empty(): boolean {
    return this.#groups.length === 0;
  }

  add(source: string, seq: number, reason: DropReason): void {
    this.addRange(source, { from: seq, to: seq + 1 }, reason);
  }

  addRange(source: string, range: SeqRange, reason: DropReason): void {
    if (range.to <= range.from) return;
    let group = this.#groups.find((entry) => entry.source === source && entry.reason === reason);
    if (!group) {
      group = { source, reason, ranges: [] };
      this.#groups.push(group);
    }
    const kept = group.ranges.filter((existing) => existing.to < range.from || existing.from > range.to);
    const touching = group.ranges.filter((existing) => existing.to >= range.from && existing.from <= range.to);
    const merged = { from: Math.min(range.from, ...touching.map((existing) => existing.from)), to: Math.max(range.to, ...touching.map((existing) => existing.to)) };
    group.ranges = [...kept, merged].sort((a, b) => a.from - b.from);
  }

  /** Takes the oldest group, at most `maxRanges` of its ranges: one source and one reason per drop record. */
  take(maxRanges: number): DropGroup | null {
    const group = this.#groups[0];
    if (!group) return null;
    const ranges = group.ranges.splice(0, maxRanges);
    if (group.ranges.length === 0) this.#groups.shift();
    return { source: group.source, reason: group.reason, ranges };
  }

  merge(groups: readonly DropGroup[]): void {
    for (const group of groups) for (const range of group.ranges) this.addRange(group.source, range, group.reason);
  }

  groups(): readonly DropGroup[] {
    return this.#groups.map((group) => ({ ...group, ranges: [...group.ranges] }));
  }
}

export function countOf(ranges: readonly SeqRange[]): number {
  return ranges.reduce((sum, range) => sum + (range.to - range.from), 0);
}

export function seqsOf(ranges: readonly SeqRange[]): number[] {
  return ranges.flatMap((range) => Array.from({ length: range.to - range.from }, (_, offset) => range.from + offset));
}
