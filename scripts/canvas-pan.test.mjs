import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observePan } from './canvas-pan.mjs';

const before = { x: 500, y: 300, width: 160, height: 80 };
function clock() { let time = 0; return { now: () => time, sleep: async ms => { time += ms; } }; }

test('waits for delayed paint and settled movement without issuing another gesture', async () => {
  let reads = 0;
  const moved = { ...before, x: 280, y: 220 };
  const result = await observePan(async () => ++reads < 4 ? before : moved, before, clock());
  assert.equal(result.moved, true);
  assert.equal(reads, 6);
  assert.equal(result.elapsedMs, 400);
});

test('an actual edge, missing shape or transient movement never passes', async () => {
  for (const read of [async () => before, async () => null]) {
    const result = await observePan(read, before, clock());
    assert.equal(result.moved, false);
    assert.equal(result.elapsedMs, 1600);
  }
  let reads = 0;
  assert.equal((await observePan(async () => ++reads === 2 ? { ...before, x: 200 } : before, before, clock())).moved, false);
});
