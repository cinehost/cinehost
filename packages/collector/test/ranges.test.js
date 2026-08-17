import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRanges, applyRanges } from '../src/ranges.js';

test('normalizeRanges merges touching and overlapping ranges', () => {
  assert.deepEqual(normalizeRanges([[0, 5], [5, 9], [3, 4]], 60), [[0, 9]]);
  assert.deepEqual(normalizeRanges([[10, 12], [0, 2]], 60), [[0, 2], [10, 12]]);
});

test('normalizeRanges clamps to the video duration and drops junk', () => {
  // [7,7] is zero-length (no second was actually watched) and [4] is malformed;
  // both are dropped rather than rounded up into phantom watch time.
  assert.deepEqual(normalizeRanges([[-5, 3], [58, 999], [7, 7], 'nope', [4]], 60), [[0, 3], [58, 60]]);
});

test('applyRanges counts each second once per flush', () => {
  const { counts, watchedSec } = applyRanges(null, [[0, 3], [1, 2]], 10);
  assert.deepEqual(counts, [1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(watchedSec, 3);
});

test('applyRanges accumulates rewatch across flushes', () => {
  const first = applyRanges(null, [[0, 3]], 10);
  const second = applyRanges(first.counts, [[0, 3]], 10);
  assert.deepEqual(second.counts.slice(0, 3), [2, 2, 2]);
  // rewatching does not inflate how much of the video was seen
  assert.equal(second.watchedSec, 3);
});

test('maxPct is how far they got, uniquePct is how much they saw', () => {
  // watched the first 2s, skipped to the last 2s of a 10s video
  const result = applyRanges(null, [[0, 2], [8, 10]], 10);
  assert.equal(result.maxPct, 100);
  assert.equal(result.uniquePct, 40);
  assert.equal(result.completed, true);
});

test('a partial watch is not a completion', () => {
  const result = applyRanges(null, [[0, 5]], 10);
  assert.equal(result.maxPct, 50);
  assert.equal(result.completed, false);
});

test('existing counts longer than the duration are truncated', () => {
  const result = applyRanges([1, 1, 1, 1, 1], [], 3);
  assert.equal(result.counts.length, 3);
  assert.equal(result.watchedSec, 3);
});

test('counts are clamped to the smallint ceiling', () => {
  const saturated = new Array(3).fill(32767);
  const result = applyRanges(saturated, [[0, 3]], 3);
  assert.deepEqual(result.counts, [32767, 32767, 32767]);
});
