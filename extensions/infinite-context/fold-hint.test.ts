import assert from "node:assert/strict";
import { test } from "node:test";
import { FOLD_TIMING_TEXT, applyFoldTiming, foldHint, payoffTurns } from "./fold-hint.ts";
import { reminderText } from "./nudge.ts";

// Per-token cache prices in any unit; (w - r) / r is 24 and 11.5.
const STEEP = { cacheWrite: 5, cacheRead: 0.2 };
const MILD = { cacheWrite: 2.5, cacheRead: 0.2 };
const MIN = 60_000;
const near = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} vs ${expected}`);

test("payoffTurns = ((w - r) / r) · K / R", () => {
  near(payoffTurns(100_000, 100_000, STEEP), 24);
  near(payoffTurns(100_000, 100_000, MILD), 11.5);
  near(payoffTurns(50_000, 200_000, STEEP), 6);
  assert.equal(payoffTurns(10_000, 0, STEEP), Infinity);
});

test("payoffTurns grows with the tokens kept after the fold point and shrinks with the tokens removed", () => {
  for (const price of [STEEP, MILD])
    for (let kept = 10_000; kept <= 400_000; kept += 30_000)
      for (let removed = 10_000; removed <= 400_000; removed += 30_000) {
        assert.ok(payoffTurns(kept + 1_000, removed, price) > payoffTurns(kept, removed, price));
        assert.ok(payoffTurns(kept, removed + 1_000, price) < payoffTurns(kept, removed, price));
      }
});

const warm = { tokens: 400_000, lastRequestAt: 1_000 * MIN, now: 1_001 * MIN, ttlMs: 5 * MIN, mode: "cache-aware" as const };

test("warm cache: the hint names the payoff of folding the oldest 75% and the general rule", () => {
  assert.equal(
    foldHint({ ...warm, price: STEEP }),
    "Fold hint: the prompt cache is warm; folding the oldest 75% pays off after ≈ 8 more turns " +
      "(in general ≈ 24 × K/R turns, K = tokens kept after the fold point, R = tokens removed).",
  );
  assert.match(foldHint({ ...warm, price: MILD })!, /after ≈ 4 more turns \(in general ≈ 11\.5 × K\/R/);
});

test("cold cache (TTL elapsed, boundary included, or no request yet): folding is free now", () => {
  const cold = "Fold hint: the prompt cache is cold, so folding is free now.";
  assert.equal(foldHint({ ...warm, price: STEEP, now: 1_005 * MIN }), cold);
  assert.equal(foldHint({ ...warm, price: undefined, now: 1_010 * MIN }), cold);
  assert.equal(foldHint({ ...warm, price: STEEP, lastRequestAt: undefined }), cold);
  assert.doesNotMatch(foldHint({ ...warm, price: STEEP, now: 1_005 * MIN - 1 })!, /cold/);
});

test("no hint when warm without a price, or in mode fixed", () => {
  assert.equal(foldHint({ ...warm, price: undefined }), undefined);
  assert.equal(foldHint({ ...warm, price: STEEP, mode: "fixed" }), undefined);
  assert.equal(foldHint({ ...warm, price: STEEP, mode: "fixed", now: 1_010 * MIN }), undefined);
});

test("the hint follows the reminder's opening sentences", () => {
  const schedule = { threshold: 150_000, step: 20_000 };
  const plain = reminderText(152_400, 1_000_000, schedule);
  assert.equal(reminderText(152_400, 1_000_000, schedule, undefined), plain);
  assert.equal(reminderText(152_400, 1_000_000, schedule, "HINT"), `${plain} HINT`);
});

test("fold timing section: pinned literal, set in cache-aware, untouched in fixed, other sections kept", () => {
  assert.equal(
    FOLD_TIMING_TEXT,
    "Fold timing: a fold re-writes the prompt cache from the fold point on. Fold a completed phase promptly, while it is still at the end of the context — that is cheap. Folding old ranges while the cache is warm is expensive; prefer it when the cache is cold or the range is large.",
  );
  const aware: Record<string, string> = { other: "x", fold_timing: "stale" };
  applyFoldTiming(aware, "cache-aware");
  assert.deepEqual(aware, { other: "x", fold_timing: FOLD_TIMING_TEXT });
  // Fixed adds nothing and leaves even a same-named section of another extension alone.
  const fixed: Record<string, string> = { other: "x", fold_timing: "theirs" };
  applyFoldTiming(fixed, "fixed");
  assert.deepEqual(fixed, { other: "x", fold_timing: "theirs" });
  const bare: Record<string, string> = { other: "x" };
  applyFoldTiming(bare, "fixed");
  assert.deepEqual(bare, { other: "x" });
});

test("a payoff that rounds to zero or one turn reads sensibly", () => {
  const nearlyFree = { cacheWrite: 1.01, cacheRead: 1 };
  assert.match(foldHint({ ...warm, price: nearlyFree })!, /pays off right away \(in general/);
  assert.doesNotMatch(foldHint({ ...warm, price: nearlyFree })!, /0 more turns/);
  // (w - r) / r = 3, K/R = 1/3: one turn.
  assert.match(foldHint({ ...warm, price: { cacheWrite: 4, cacheRead: 1 } })!, /pays off after ≈ 1 more turn \(in general ≈ 3 × K\/R/);
});
