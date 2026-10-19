import test from 'node:test';
import assert from 'node:assert/strict';
import { correction, estimateOffset, positionAt } from '../shared/timing.js';

test('positionAt advances only while playing and clamps to the duration', () => {
  const playing = { isPlaying: true, positionAsOfTimestamp: 10_000, timestamp: 1_000 };
  assert.equal(positionAt(playing, 3_500), 12_500);
  assert.equal(positionAt(playing, 1_000_000, 60_000), 60_000);
  assert.equal(positionAt({ ...playing, isPlaying: false }, 3_500), 10_000);
  assert.equal(positionAt({ ...playing, positionAsOfTimestamp: 0 }, 0), 0, 'never negative');
});

test('estimateOffset trusts the lowest round trip', () => {
  const best = estimateOffset([
    { t0: 0, t1: 300, serverNow: 5_400 }, // slow sample
    { t0: 1_000, t1: 1_040, serverNow: 6_020 }, // fast sample: offset 5_000
    { t0: 2_000, t1: 1_990, serverNow: 0 }, // clock went backwards: ignored
  ]);
  assert.deepEqual(best, { rtt: 40, offset: 5_000 });
  assert.equal(estimateOffset([]), null);
});

test('correction seeks on large drift and nudges the rate on small drift', () => {
  const audio = { hardMs: 400, softMs: 60, settleMs: 20, supportsRate: true };
  assert.equal(correction(500, audio).action, 'seek');
  assert.equal(correction(-450, audio).action, 'seek');

  const ahead = correction(100, audio);
  assert.equal(ahead.action, 'rate');
  assert.ok(ahead.rate < 1, 'ahead means slow down');
  assert.ok(correction(-100, audio).rate > 1, 'behind means speed up');

  assert.equal(correction(40, audio).action, 'none', 'below softMs is fine when not correcting');
  assert.equal(correction(40, { ...audio, correcting: true }).action, 'rate', 'hysteresis keeps nudging');
  assert.equal(correction(10, { ...audio, correcting: true }).action, 'none', 'settled');
  assert.ok(Math.abs(1 - correction(399, audio).rate) <= 0.05 + 1e-9, 'rate change is capped');
});

test('players without rate control only seek', () => {
  const yt = { hardMs: 1000, softMs: Infinity, settleMs: 0, supportsRate: false };
  assert.equal(correction(800, yt).action, 'none');
  assert.equal(correction(1200, yt).action, 'seek');
});
