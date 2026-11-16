import assert from "node:assert/strict";
import {
  addClearDuration,
  averageDurationMs,
  clearRank,
  formatDuration,
  normalizedBallCount,
} from "../src/billiardsMetrics.ts";

assert.equal(normalizedBallCount(0), 15);
assert.equal(normalizedBallCount(7), 15);
assert.equal(normalizedBallCount(15), 15);
assert.equal(normalizedBallCount(60), 45);
assert.equal(clearRank(30_000), "S");
assert.equal(clearRank(90_000), "A");
assert.equal(clearRank(180_000), "B");
assert.equal(clearRank(181_000), "C");

const history = addClearDuration({ durationsMs: [10_000, 20_000] }, 30_000);
assert.deepEqual(history.durationsMs, [10_000, 20_000, 30_000]);
assert.equal(averageDurationMs(history), 20_000);
assert.equal(formatDuration(125_000), "2分05秒");
assert.equal(formatDuration(null), "—");

console.log("billiards metrics tests passed");
