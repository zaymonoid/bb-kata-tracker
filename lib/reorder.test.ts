// Run with `npm test` (node --test, type-stripping).
import assert from "node:assert/strict";
import { test } from "node:test";
import { moveTo, moveToSlot, shiftBy } from "./reorder.ts";

const order = ["a", "b", "c", "d"];

test("moveTo puts the uid at that index and clamps", () => {
  assert.deepEqual(moveTo(order, "a", 2), ["b", "c", "a", "d"]);
  assert.deepEqual(moveTo(order, "d", 0), ["d", "a", "b", "c"]);
  assert.deepEqual(moveTo(order, "b", 99), ["a", "c", "d", "b"]);
  assert.deepEqual(moveTo(order, "b", -5), ["b", "a", "c", "d"]);
});

test("moveToSlot drops into the gap, counted before the move", () => {
  // Gap 4 (past the last tab) and gap 0 (before the first).
  assert.deepEqual(moveToSlot(order, "a", 4), ["b", "c", "d", "a"]);
  assert.deepEqual(moveToSlot(order, "d", 0), ["d", "a", "b", "c"]);
  // Dragging right: gap 3 sits between b and c once a is lifted out.
  assert.deepEqual(moveToSlot(order, "a", 3), ["b", "c", "a", "d"]);
  // Dragging left: gap 1 is after a.
  assert.deepEqual(moveToSlot(order, "c", 1), ["a", "c", "b", "d"]);
  assert.deepEqual(moveToSlot(order, "b", 9), ["a", "c", "d", "b"]);
});

test("the gaps either side of the dragged tab change nothing", () => {
  for (const slot of [1, 2]) assert.equal(moveToSlot(order, "b", slot), order);
  assert.equal(moveToSlot(order, "a", 0), order);
  assert.equal(moveToSlot(order, "d", 4), order);
});

test("shiftBy is the keyboard move, and stops at the ends", () => {
  assert.deepEqual(shiftBy(order, "b", -1), ["b", "a", "c", "d"]);
  assert.deepEqual(shiftBy(order, "b", 1), ["a", "c", "b", "d"]);
  assert.equal(shiftBy(order, "a", -1), order);
  assert.equal(shiftBy(order, "d", 1), order);
});

test("an unknown uid, junk and an empty list are left alone", () => {
  assert.equal(moveTo(order, "z", 0), order);
  assert.equal(moveToSlot(order, "z", 0), order);
  assert.equal(shiftBy(order, "z", 1), order);
  assert.equal(moveTo(order, "a", Number.NaN), order);
  assert.equal(moveToSlot(order, "a", Number.NaN), order);
  assert.equal(shiftBy(order, "a", Number.NaN), order);
  assert.deepEqual(moveTo([], "a", 0), []);
  assert.deepEqual(moveTo(["a"], "a", 0), ["a"]);
});
