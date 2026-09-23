// Run with `npm test` (node --test, type-stripping).
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLabelInput } from "./labels.ts";

test("names add, -names remove, commas and spaces separate", () => {
  assert.deepEqual(parseLabelInput("bug, -old  ui,bug -"), { add: ["bug", "ui"], remove: ["old"] });
  assert.deepEqual(parseLabelInput("   "), { add: [], remove: [] });
});
