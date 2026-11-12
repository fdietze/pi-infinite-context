import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, parseSettings, resolveSettings, settingsChanged } from "./settings.ts";

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
  assert.deepEqual(resolveSettings(DEFAULT_SETTINGS, [], () => 0.5), DEFAULT_SETTINGS);
});

test("a range draws one limit uniformly and the branch keeps it", () => {
  const file = { nudgeAtTokens: [100, 103] as const, nudgeAtPercent: 75 };
  const draw = (random: number) => resolveSettings(file, [], () => random).nudgeAtTokens;
  assert.deepEqual([0, 0.25, 0.5, 0.999999].map(draw), [100, 101, 102, 103]);
  const first = resolveSettings(file, [], () => 0.5);
  assert.deepEqual(first, { nudgeAtTokens: 102, nudgeAtPercent: 75, nudgeAtTokensRange: [100, 103] });
  // Reload or fork: the branch's record holds the arm, so no new draw.
  assert.deepEqual(resolveSettings(file, [first], () => 0), first);
  assert.equal(settingsChanged(first, resolveSettings(file, [first], () => 0)), false);
});

test("the latest record for the same range wins over later records for other ranges", () => {
  const file = { nudgeAtTokens: [100, 103] as const, nudgeAtPercent: 75 };
  const recorded = [
    { nudgeAtTokens: 101, nudgeAtPercent: 75, nudgeAtTokensRange: [100, 103] },
    { nudgeAtTokens: 102, nudgeAtPercent: 75, nudgeAtTokensRange: [100, 103] },
    { nudgeAtTokens: 50, nudgeAtPercent: 75 },
  ];
  assert.equal(resolveSettings(file, recorded, () => 0).nudgeAtTokens, 102);
});

test("a changed range or an implausible record draws anew", () => {
  const file = { nudgeAtTokens: [100, 103] as const, nudgeAtPercent: 75 };
  for (const recorded of [
    { nudgeAtTokens: 102, nudgeAtPercent: 75, nudgeAtTokensRange: [100, 200] },
    { nudgeAtTokens: 102, nudgeAtPercent: 75 },
    { nudgeAtTokens: 99, nudgeAtPercent: 75, nudgeAtTokensRange: [100, 103] },
    "x",
  ]) {
    const resolved = resolveSettings(file, [recorded], () => 0);
    assert.equal(resolved.nudgeAtTokens, 100, JSON.stringify(recorded));
    assert.equal(settingsChanged(recorded, resolved), true, JSON.stringify(recorded));
  }
});

test("a model override replaces each valid field on its own", () => {
  const json = JSON.stringify({
    nudgeAtTokens: [100_000, 300_000],
    nudgeAtPercent: 60,
    modelOverrides: {
      "local/small": { nudgeAtTokens: 50_000, nudgeAtPercent: 0 },
      "local/ranged": { nudgeAtTokens: [40_000, 80_000] },
    },
  });
  assert.deepEqual(parseSettings(json, "local/small"), { nudgeAtTokens: 50_000, nudgeAtPercent: 60 });
  assert.deepEqual(parseSettings(json, "local/ranged"), {
    nudgeAtTokens: [40_000, 80_000],
    nudgeAtPercent: 60,
  });
  // Keys are exact "provider/id" strings; anything else uses the top-level fields.
  for (const model of [undefined, "local", "LOCAL/small", "constructor", "toString"]) {
    assert.deepEqual(
      parseSettings(json, model),
      { nudgeAtTokens: [100_000, 300_000], nudgeAtPercent: 60 },
      String(model),
    );
  }
});

test("malformed model overrides fall back to the top-level fields", () => {
  for (const modelOverrides of [null, [], 5, "x", { "a/b": 5 }, { "a/b": [1, 2] }, { "a/b": null }]) {
    assert.deepEqual(
      parseSettings(JSON.stringify({ nudgeAtTokens: 9000, modelOverrides }), "a/b"),
      { ...DEFAULT_SETTINGS, nudgeAtTokens: 9000 },
      JSON.stringify(modelOverrides),
    );
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
