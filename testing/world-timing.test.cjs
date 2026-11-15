const {test} = require('node:test');
const assert = require('node:assert/strict');
const createTimingAccumulator = require('./world-timing.cjs');

test('includes a long pause that crosses a telemetry flush', () => {
  const timing = createTimingAccumulator();
  assert.deepEqual(timing.collect(0, [1000, 1125]), [125]);
  assert.deepEqual(timing.collect(0, []), []);
  assert.deepEqual(timing.collect(0, [7485, 7610]), [6360, 125]);
});
test('planned restart does not become network latency and preserves partner continuity', () => {
  const timing = createTimingAccumulator();
  timing.collect(0, [50000]); timing.collect(1, [50000]);
  timing.reset(0);
  assert.deepEqual(timing.collect(0, [2000, 2125]), [125]);
  assert.deepEqual(timing.collect(1, [50600]), [600]);
});
test('duplicate snapshots do not count gaps twice', () => {
  const timing = createTimingAccumulator();
  timing.collect(0, [1000, 1125]);
  assert.deepEqual(timing.collect(0, [1000, 1125, 1250]), [125]);
});
