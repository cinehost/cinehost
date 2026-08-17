/**
 * The wire format for watched time is a list of [startSec, endSec) integer
 * ranges. The stored format is a per-second play-count array. These two
 * functions are the whole conversion, and they are the only place the
 * engagement numbers can go wrong, so they are unit tested.
 */

/** Clamp, drop garbage, sort, and merge touching/overlapping ranges. */
export function normalizeRanges(ranges, duration) {
  if (!Array.isArray(ranges) || duration <= 0) return [];

  const clean = [];
  for (const r of ranges) {
    if (!Array.isArray(r) || r.length < 2) continue;
    let start = Math.floor(Number(r[0]));
    let end = Math.ceil(Number(r[1]));
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    start = Math.max(0, start);
    end = Math.min(duration, end);
    if (end <= start) continue;
    clean.push([start, end]);
  }

  clean.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const merged = [];
  for (const [start, end] of clean) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

const MAX_COUNT = 32767; // smallint ceiling

/**
 * Add ranges into an existing counts array, growing/truncating it to duration.
 * Returns { counts, watchedSec, maxPct, completed }.
 *
 * Ranges arriving in one beacon are merged first, so a single flush can never
 * increment the same second twice - rewatch only accrues across flushes, which
 * is what a real second play-through looks like.
 */
export function applyRanges(existing, ranges, duration, completionPct = 95) {
  const counts = new Array(duration).fill(0);
  const prior = existing || [];
  for (let i = 0; i < Math.min(prior.length, duration); i += 1) {
    counts[i] = prior[i] || 0;
  }

  for (const [start, end] of normalizeRanges(ranges, duration)) {
    for (let i = start; i < end; i += 1) {
      counts[i] = Math.min(MAX_COUNT, counts[i] + 1);
    }
  }

  let watchedSec = 0;
  let lastWatched = -1;
  for (let i = 0; i < duration; i += 1) {
    if (counts[i] > 0) {
      watchedSec += 1;
      lastWatched = i;
    }
  }

  const uniquePct = duration ? (watchedSec / duration) * 100 : 0;
  const reachPct = duration ? ((lastWatched + 1) / duration) * 100 : 0;

  return {
    counts,
    watchedSec,
    // "how far did they get", the number a threshold webhook should fire on
    maxPct: Math.round(reachPct * 10) / 10,
    // "how much of it did they actually see"
    uniquePct: Math.round(uniquePct * 10) / 10,
    completed: reachPct >= completionPct,
  };
}
