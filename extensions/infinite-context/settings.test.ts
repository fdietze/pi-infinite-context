import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SETTINGS,
  modelEntries,
  parseSettings,
  resolvePrice,
  resolveSettings,
  settingsChanged,
} from "./settings.ts";

test("an empty or unreadable file yields the defaults", () => {
  for (const input of ["", "not json", "null", "[]", "42", "{}"]) {
    assert.deepEqual(parseSettings(input), DEFAULT_SETTINGS, input);
  }
});

test("each field is read on its own", () => {
  assert.deepEqual(parseSettings(JSON.stringify({ nudgeAtTokens: 100_000 })), {
    ...DEFAULT_SETTINGS,
    nudgeAtTokens: 100_000,
  });
  assert.deepEqual(parseSettings(JSON.stringify({ nudgeAtPercent: 50.5 })), {
    ...DEFAULT_SETTINGS,
    nudgeAtPercent: 50.5,
  });
  assert.equal(parseSettings(JSON.stringify({ nudgeAtPercent: 100 })).nudgeAtPercent, 100);
});

test("an invalid field falls back without disturbing the valid one", () => {
  for (const bad of [0, -1, 1.5, "1000", null, NaN]) {
    assert.deepEqual(
      parseSettings(JSON.stringify({ nudgeAtTokens: bad, nudgeAtPercent: 60 })),
      { ...DEFAULT_SETTINGS, nudgeAtPercent: 60 },
      String(bad),
    );
  }
  for (const bad of [0, -5, 100.1, "50", null]) {
    assert.deepEqual(
      parseSettings(JSON.stringify({ nudgeAtTokens: 9000, nudgeAtPercent: bad })),
      { ...DEFAULT_SETTINGS, nudgeAtTokens: 9000 },
      String(bad),
    );
  }
});

test("nudgeAtTokens accepts a range of two increasing token counts", () => {
  assert.deepEqual(parseSettings(JSON.stringify({ nudgeAtTokens: [100_000, 250_000] })), {
    ...DEFAULT_SETTINGS,
    nudgeAtTokens: [100_000, 250_000],
  });
  for (const bad of [[], [1], [5, 5], [6, 5], [0, 5], [1.5, 5], [1, 2, 3], ["1", 5]]) {
    assert.deepEqual(
      parseSettings(JSON.stringify({ nudgeAtTokens: bad })),
      DEFAULT_SETTINGS,
      JSON.stringify(bad),
    );
  }
});

test("a fixed limit resolves to itself, with no range recorded", () => {
  assert.deepEqual(resolveSettings(DEFAULT_SETTINGS, undefined, () => 0.5), DEFAULT_SETTINGS);
});

test("a range draws one limit uniformly and the branch keeps it", () => {
  const file = { ...DEFAULT_SETTINGS, nudgeAtTokens: [100, 103] as const };
  const draw = (random: number) => resolveSettings(file, undefined, () => random).nudgeAtTokens;
  assert.deepEqual([0, 0.25, 0.5, 0.999999].map(draw), [100, 101, 102, 103]);
  const first = resolveSettings(file, undefined, () => 0.5);
  assert.deepEqual(first, { ...DEFAULT_SETTINGS, nudgeAtTokens: 102, nudgeAtTokensRange: [100, 103] });
  // Reload or fork: the branch's record holds the arm, so no new draw.
  assert.deepEqual(resolveSettings(file, first, () => 0), first);
  assert.equal(settingsChanged(first, resolveSettings(file, first, () => 0)), false);
});

test("a changed range or an implausible record draws anew", () => {
  const file = { ...DEFAULT_SETTINGS, nudgeAtTokens: [100, 103] as const };
  for (const recorded of [
    { nudgeAtTokens: 102, nudgeAtPercent: 75, nudgeAtTokensRange: [100, 200] },
    { nudgeAtTokens: 102, nudgeAtPercent: 75 },
    { nudgeAtTokens: 99, nudgeAtPercent: 75, nudgeAtTokensRange: [100, 103] },
    "x",
  ]) {
    const resolved = resolveSettings(file, recorded, () => 0);
    assert.equal(resolved.nudgeAtTokens, 100, JSON.stringify(recorded));
    assert.equal(settingsChanged(recorded, resolved), true, JSON.stringify(recorded));
  }
});

test("unknown keys are ignored", () => {
  assert.deepEqual(parseSettings(JSON.stringify({ whatever: true })), DEFAULT_SETTINGS);
});

test("only a record that matches the current settings counts as unchanged", () => {
  assert.equal(settingsChanged({ ...DEFAULT_SETTINGS }, DEFAULT_SETTINGS), false);
  assert.equal(settingsChanged({ ...DEFAULT_SETTINGS, nudgeAtTokens: 1 }, DEFAULT_SETTINGS), true);
  assert.equal(settingsChanged({ ...DEFAULT_SETTINGS, nudgeAtPercent: 1 }, DEFAULT_SETTINGS), true);
  assert.equal(
    settingsChanged({ ...DEFAULT_SETTINGS, nudgeAtTokensRange: [1, 2] }, DEFAULT_SETTINGS),
    true,
  );
  for (const recorded of [undefined, null, "x", 3, {}]) {
    assert.equal(settingsChanged(recorded, DEFAULT_SETTINGS), true, String(recorded));
  }
});

test("the reminders block is read as written", () => {
  const reminders = {
    default: { everyTokens: 30_000 },
    overrides: {
      anthropic: { startTokens: 150_000, everyTokens: 20_000 },
      "anthropic/claude-opus": { startTokens: 400_000 },
    },
  };
  assert.deepEqual(parseSettings(JSON.stringify({ nudgeAtPercent: 60, reminders })), {
    ...DEFAULT_SETTINGS,
    nudgeAtPercent: 60,
    reminders,
  });
  assert.deepEqual(parseSettings(JSON.stringify({ reminders: { overrides: { openai: { everyTokens: 9 } } } })), {
    ...DEFAULT_SETTINGS,
    reminders: { default: {}, overrides: { openai: { everyTokens: 9 } } },
  });
});

test("invalid rule fields are dropped one by one, and an empty block is no block", () => {
  assert.deepEqual(
    parseSettings(
      JSON.stringify({
        nudgeAtTokens: 90_000,
        reminders: {
          default: { startTokens: 0, everyTokens: 20_000, budget: 1 },
          overrides: { a: { startTokens: 1.5 }, b: null, c: [], d: { startTokens: 7, everyTokens: "8" } },
        },
      }),
    ),
    {
      ...DEFAULT_SETTINGS,
      nudgeAtTokens: 90_000,
      reminders: { default: { everyTokens: 20_000 }, overrides: { d: { startTokens: 7 } } },
    },
  );
  for (const reminders of [null, [], 3, {}, { default: {}, overrides: {} }, { overrides: [] }, { default: { startTokens: -1 } }])
    assert.deepEqual(parseSettings(JSON.stringify({ reminders })), DEFAULT_SETTINGS, JSON.stringify(reminders));
});

test("resolved settings carry the rules, and a recorded block counts as unchanged only when equal", () => {
  const file = parseSettings(JSON.stringify({ reminders: { overrides: { anthropic: { startTokens: 9 } } } }));
  const current = resolveSettings(file, undefined, () => 0);
  assert.deepEqual(current.reminders, { default: {}, overrides: { anthropic: { startTokens: 9 } } });
  assert.equal(settingsChanged(JSON.parse(JSON.stringify(current)), current), false);
  assert.equal(settingsChanged(DEFAULT_SETTINGS, current), true);
  assert.equal(settingsChanged({ ...current, reminders: { default: {}, overrides: {} } }, current), true);
  assert.equal(settingsChanged(current, DEFAULT_SETTINGS), true);
  const range = parseSettings(JSON.stringify({ nudgeAtTokens: [100, 200], reminders: { default: { everyTokens: 5 } } }));
  assert.deepEqual(resolveSettings(range, undefined, () => 0).reminders, { default: { everyTokens: 5 }, overrides: {} });
});

test("modelEntries: exact provider/modelId first, then the provider, never inherited keys", () => {
  const table = { anthropic: 1, "anthropic/opus": 2 };
  assert.deepEqual(modelEntries(table, { provider: "anthropic", id: "opus" }), [2, 1]);
  assert.deepEqual(modelEntries(table, { provider: "anthropic", id: "haiku" }), [1]);
  assert.deepEqual(modelEntries(table, { provider: "openai", id: "opus" }), []);
  assert.deepEqual(modelEntries(table, undefined), []);
  assert.deepEqual(modelEntries(table, { provider: "toString" }), []);
});

const opus = { provider: "anthropic", id: "claude-opus" };
const STEEP = { cacheWrite: 5, cacheRead: 0.2 };
const MILD = { cacheWrite: 2.5, cacheRead: 0.2 };

test("fold-hint settings: defaults, and each field read on its own", () => {
  assert.equal(DEFAULT_SETTINGS.cacheTtlMinutes, 5);
  assert.equal(DEFAULT_SETTINGS.foldHint, "fixed");
  assert.equal(DEFAULT_SETTINGS.prices, undefined);
  assert.deepEqual(parseSettings(JSON.stringify({ cacheTtlMinutes: 60, foldHint: "cache-aware" })), {
    ...DEFAULT_SETTINGS,
    cacheTtlMinutes: 60,
    foldHint: "cache-aware",
  });
  for (const bad of [0, -1, "5", null])
    assert.equal(parseSettings(JSON.stringify({ cacheTtlMinutes: bad })).cacheTtlMinutes, 5, String(bad));
  for (const bad of ["always", 1, null])
    assert.equal(parseSettings(JSON.stringify({ foldHint: bad })).foldHint, "fixed", String(bad));
});

test("prices keep only usable entries", () => {
  const parsed = parseSettings(
    JSON.stringify({
      prices: {
        "anthropic/claude-opus": STEEP,
        anthropic: MILD,
        a: { cacheWrite: 5 },
        b: { cacheWrite: 5, cacheRead: 0 },
        c: { cacheWrite: 1, cacheRead: 2 },
        d: null,
      },
    }),
  );
  assert.deepEqual(parsed.prices, { "anthropic/claude-opus": STEEP, anthropic: MILD });
  for (const prices of [[], "x", {}, { a: { cacheWrite: 1, cacheRead: 2 } }])
    assert.deepEqual(parseSettings(JSON.stringify({ prices })), DEFAULT_SETTINGS, JSON.stringify(prices));
});

test("resolvePrice: exact provider/modelId, then provider, then the model's registry cost", () => {
  const settings = { ...DEFAULT_SETTINGS, prices: { "anthropic/claude-opus": STEEP, anthropic: MILD } };
  assert.deepEqual(resolvePrice(settings, opus), STEEP);
  assert.deepEqual(resolvePrice(settings, { provider: "anthropic", id: "claude-haiku" }), MILD);
  const cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  assert.deepEqual(resolvePrice(settings, { provider: "openai", id: "gpt", cost }), { cacheWrite: 3.75, cacheRead: 0.3 });
  assert.deepEqual(resolvePrice(settings, { ...opus, cost }), STEEP);
  // No write surcharge reported: rewriting the cache costs the input price.
  const noSurcharge = { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 };
  assert.deepEqual(resolvePrice(DEFAULT_SETTINGS, { provider: "openai", id: "gpt", cost: noSurcharge }), {
    cacheWrite: 1.25,
    cacheRead: 0.125,
  });
  // No price at all, or no cache-read price: no hint.
  assert.equal(resolvePrice(DEFAULT_SETTINGS, opus), undefined);
  assert.equal(resolvePrice(DEFAULT_SETTINGS, { ...opus, cost: { input: 1, cacheRead: 0, cacheWrite: 0 } }), undefined);
});

test("the fold-hint settings are part of the recorded settings", () => {
  assert.equal(settingsChanged({ ...DEFAULT_SETTINGS, foldHint: "cache-aware" }, DEFAULT_SETTINGS), true);
  assert.equal(settingsChanged({ ...DEFAULT_SETTINGS, cacheTtlMinutes: 60 }, DEFAULT_SETTINGS), true);
  const priced = resolveSettings(parseSettings(JSON.stringify({ prices: { anthropic: MILD } })), undefined, () => 0);
  assert.deepEqual(priced.prices, { anthropic: MILD });
  assert.equal(settingsChanged(JSON.parse(JSON.stringify(priced)), priced), false);
  assert.equal(settingsChanged(DEFAULT_SETTINGS, priced), true);
});
