import { test } from "node:test";
import assert from "node:assert/strict";
import { queryStep, rateWindow, duration, nearestPoint, formatMetric } from "./chart";
test("step matches evaluation intervals and durations use Prometheus units", () => {
  assert.deepEqual([15, 60, 360, 1440].map(minutes => queryStep(minutes)), [30, 30, 180, 720]);
  assert.deepEqual([5, 15, 30, 60, 300].map(step => queryStep(60, step as 5 | 15 | 30 | 60 | 300)), [5, 15, 30, 60, 300]);
  assert.deepEqual([30, 180, 720].map(rateWindow), [300, 720, 2880]);
  assert.deepEqual([30, 180, 720, 3600].map(duration), ["30s", "3m", "12m", "1h"]);
});
test("tooltip selects a real sample and retains precision and units", () => {
  assert.deepEqual(nearestPoint([{ time: 100, value: 1.123456 }, { time: 130, value: 2 }], 109), { time: 100, value: 1.123456 });
  assert.equal(nearestPoint([], 100), undefined);
  assert.equal(formatMetric(1.123456, "cores", true), "1.123456 cores");
  assert.equal(formatMetric(1024, "bytes/s"), "1 KiB/s");
});
