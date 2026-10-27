import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { NUDGES_BEFORE_OVERFLOW, nudgeSchedule, planNudge, reminderText } from "./nudge.ts";
import { DEFAULT_SETTINGS, type Settings } from "./settings.ts";

const settings = (nudgeAtTokens: number, nudgeAtPercent: number): Settings => ({
  ...DEFAULT_SETTINGS,
  nudgeAtTokens,
  nudgeAtPercent,
});

test("the schedule per window size with the defaults", () => {
  assert.deepEqual(nudgeSchedule(200_000, DEFAULT_SETTINGS), { threshold: 150_000, step: 15_000 });
  assert.deepEqual(nudgeSchedule(1_000_000, DEFAULT_SETTINGS), { threshold: 150_000, step: 15_000 });
  assert.deepEqual(nudgeSchedule(32_000, DEFAULT_SETTINGS), { threshold: 24_000, step: 8_000 / 3 });
});

test("a 200k window with the defaults nudges from 150k, as 75% did before", () => {
  assert.equal(planNudge(149_999, 200_000, DEFAULT_SETTINGS, 0, true).nudge, false);
  assert.deepEqual(planNudge(150_000, 200_000, DEFAULT_SETTINGS, 0, true), {
    nudge: true,
    band: 150_000,
  });
});

test("the token limit wins on a large window", () => {
  assert.equal(planNudge(150_000, 1_000_000, DEFAULT_SETTINGS, 0, true).nudge, true);
});

test("the percentage wins on a small window", () => {
  assert.equal(planNudge(59_999, 100_000, DEFAULT_SETTINGS, 0, true).nudge, false);
  assert.equal(planNudge(75_000, 100_000, DEFAULT_SETTINGS, 0, true).nudge, true);
});

test("a reminder repeats only at the next 15k step", () => {
  const first = planNudge(150_000, 200_000, DEFAULT_SETTINGS, 0, true);
  assert.equal(planNudge(164_999, 200_000, DEFAULT_SETTINGS, first.band, true).nudge, false);
  assert.deepEqual(planNudge(165_000, 200_000, DEFAULT_SETTINGS, first.band, true), {
    nudge: true,
    band: 165_000,
  });
});

test("no reminder when the agent is not continuing, and the band is kept", () => {
  assert.deepEqual(planNudge(180_000, 200_000, DEFAULT_SETTINGS, 150_000, false), {
    nudge: false,
    band: 150_000,
  });
});

test("dropping below the threshold resets the band", () => {
  assert.deepEqual(planNudge(10_000, 200_000, DEFAULT_SETTINGS, 170_000, true), {
    nudge: false,
    band: 0,
  });
});

test("unknown usage or window never nudges", () => {
  assert.equal(planNudge(NaN, 200_000, DEFAULT_SETTINGS, 0, true).nudge, false);
  assert.equal(planNudge(100_000, 0, DEFAULT_SETTINGS, 0, true).nudge, false);
});

/** Replays a context growing in 1k-token turns and counts the reminders fired before it overflows. */
function remindersUntilFull(window: number, s: Settings): number {
  let band = 0;
  let count = 0;
  for (let tokens = 0; tokens < window; tokens += 1_000) {
    const planned = planNudge(tokens, window, s, band, true);
    band = planned.band;
    if (planned.nudge) count++;
  }
  return count;
}

test("reminder counts per window size with the defaults", () => {
  const counts = new Map([
    [32_000, 3],
    [128_000, 3],
    [200_000, 4],
    [400_000, 17],
  ]);
  for (const [window, expected] of counts) {
    assert.equal(remindersUntilFull(window, DEFAULT_SETTINGS), expected, String(window));
  }
});

test("a threshold equal to the window still yields a finite, positive step", () => {
  const planned = planNudge(200_000, 200_000, settings(1_000_000, 100), 0, true);
  assert.deepEqual(planned, { nudge: true, band: 200_000 });
});

test("property: reminders never fire below the earlier limit and bands increase", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 5_000_000 }),
      fc.integer({ min: 1_000, max: 2_000_000 }),
      fc.integer({ min: 1, max: 5_000_000 }),
      fc.double({ min: 0.1, max: 100, noNaN: true }),
      fc.integer({ min: 0, max: 5_000_000 }),
      (tokens, window, limitTokens, limitPercent, lastBand) => {
        const threshold = Math.min(limitTokens, (limitPercent / 100) * window);
        const planned = planNudge(tokens, window, settings(limitTokens, limitPercent), lastBand, true);
        if (tokens < threshold) assert.equal(planned.nudge, false);
        if (planned.nudge) {
          assert.ok(planned.band > lastBand);
          assert.ok(planned.band <= tokens + 1e-6); // float slack of threshold + step * k
        }
      },
    ),
  );
});

test("property: at least NUDGES_BEFORE_OVERFLOW reminders fit between threshold and window", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 64, max: 2_000 }), // window in k tokens
      fc.integer({ min: 1, max: 5_000 }), // token limit in k
      fc.integer({ min: 1, max: 99 }), // percent limit
      (windowK, limitK, limitPercent) => {
        const window = windowK * 1_000;
        const s = settings(limitK * 1_000, limitPercent);
        const threshold = Math.min(s.nudgeAtTokens, (limitPercent / 100) * window);
        // Needs room for the reminders on the 1k replay grid.
        fc.pre(window - threshold >= NUDGES_BEFORE_OVERFLOW * 1_000);
        assert.ok(remindersUntilFull(window, s) >= NUDGES_BEFORE_OVERFLOW);
      },
    ),
  );
});

const MILLION = 1_000_000;
const opus = { provider: "anthropic", id: "claude-opus" };
const withRules = (reminders: Settings["reminders"]): Settings => ({ ...DEFAULT_SETTINGS, reminders });
const configured = withRules({
  default: {},
  overrides: {
    anthropic: { startTokens: 300_000, everyTokens: 50_000 },
    "anthropic/claude-opus": { startTokens: 400_000 },
  },
});

test("rule fields resolve on their own: exact provider/model, then provider, then default, then the limits", () => {
  assert.deepEqual(nudgeSchedule(MILLION, configured, opus), { threshold: 400_000, step: 50_000 });
  assert.deepEqual(nudgeSchedule(MILLION, configured, { provider: "anthropic", id: "claude-haiku" }), {
    threshold: 300_000,
    step: 50_000,
  });
  assert.deepEqual(nudgeSchedule(MILLION, configured, { provider: "openai", id: "gpt" }), {
    threshold: 150_000,
    step: 15_000,
  });
  assert.deepEqual(nudgeSchedule(MILLION, configured), { threshold: 150_000, step: 15_000 });
  const fallback = withRules({ default: { everyTokens: 30_000 }, overrides: { openai: { startTokens: 200_000 } } });
  assert.deepEqual(nudgeSchedule(MILLION, fallback, { provider: "openai", id: "gpt" }), {
    threshold: 200_000,
    step: 30_000,
  });
  assert.deepEqual(nudgeSchedule(MILLION, fallback, opus), { threshold: 150_000, step: 30_000 });
});

test("a rule's start replaces nudgeAtTokens, also a drawn one", () => {
  const drawn: Settings = { ...configured, nudgeAtTokens: 120_000, nudgeAtTokensRange: [100_000, 200_000] };
  assert.equal(nudgeSchedule(MILLION, drawn, opus).threshold, 400_000);
  assert.equal(nudgeSchedule(MILLION, drawn, { provider: "openai", id: "gpt" }).threshold, 120_000);
});

test("a rule keeps the safety limits: start at most nudgeAtPercent, room for the last reminders", () => {
  // 75% of 200k is 150k, below the rule's 400k start; 50k room / 3 is below the rule's 50k step.
  assert.deepEqual(nudgeSchedule(200_000, configured, opus), { threshold: 150_000, step: 50_000 / 3 });
});

test("the model decides: the same context reminds on one model and not on another", () => {
  const rule = withRules({ default: {}, overrides: { anthropic: { startTokens: 100_000 } } });
  assert.equal(planNudge(120_000, MILLION, rule, 0, true, opus).nudge, true);
  assert.equal(planNudge(120_000, MILLION, rule, 0, true, { provider: "openai", id: "gpt" }).nudge, false);
});

test("property: with per-model rules, reminders never fire below the start and enough fit before overflow", () => {
  const rule = fc.record(
    { startTokens: fc.integer({ min: 1, max: 3_000_000 }), everyTokens: fc.integer({ min: 1, max: 500_000 }) },
    { requiredKeys: [] },
  );
  fc.assert(
    fc.property(
      fc.integer({ min: 64, max: 2_000 }), // window in k tokens
      rule,
      rule,
      fc.constantFrom(opus, { provider: "anthropic", id: "other" }, { provider: "openai", id: "gpt" }, undefined),
      (windowK, provider, exact, model) => {
        const window = windowK * 1_000;
        const s = withRules({ default: {}, overrides: { anthropic: provider, "anthropic/claude-opus": exact } });
        const { threshold } = nudgeSchedule(window, s, model);
        assert.ok(threshold <= window * 0.75);
        let band = 0;
        let count = 0;
        for (let tokens = 0; tokens < window; tokens += 1_000) {
          const planned = planNudge(tokens, window, s, band, true, model);
          if (tokens < threshold) assert.equal(planned.nudge, false);
          if (planned.nudge) {
            assert.ok(planned.band > band);
            count++;
          }
          band = planned.band;
        }
        if (window - threshold >= NUDGES_BEFORE_OVERFLOW * 1_000) assert.ok(count >= NUDGES_BEFORE_OVERFLOW);
      },
    ),
    { numRuns: 200 },
  );
});

test("the reminder states absolute tokens, the window share and the schedule it follows", () => {
  assert.equal(
    reminderText(152_400, MILLION, { threshold: 150_000, step: 20_000 }),
    "Context is ~152k tokens (15% of the 1000k-token window). Reminders start at 150k tokens and repeat every 20k.",
  );
});

test("a step below 1k tokens is stated exactly, not rounded to 0k", () => {
  const text = reminderText(99_000, MILLION, { threshold: 98_000, step: 1 });
  assert.match(text, /Reminders start at 98k tokens and repeat every 1 token\./);
  assert.match(reminderText(99_000, MILLION, { threshold: 98_000, step: 420.4 }), /repeat every 420 tokens\./);
  assert.match(reminderText(99_000, MILLION, { threshold: 98_000, step: 8_000 / 3 }), /repeat every 3k\./);
});
