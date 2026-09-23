// Run with `npm test` (node --test, type-stripping).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampFraction,
  DEFAULT_LIST_FRACTION,
  fractionFromPointer,
  listWidthPx,
  MIN_DETAIL_PX,
  MIN_LIST_PX,
  readFraction,
  sameFraction,
} from "./split.ts";

test("a fraction inside the minima is left alone", () => {
  assert.equal(clampFraction(0.5, 1200), 0.5);
  assert.equal(clampFraction(DEFAULT_LIST_FRACTION, 1600), DEFAULT_LIST_FRACTION);
});

test("neither pane collapses", () => {
  assert.equal(listWidthPx(0.01, 1200), MIN_LIST_PX);
  assert.equal(listWidthPx(0.99, 1200), 1200 - MIN_DETAIL_PX);
  // At the narrowest wide layout (NARROW_PX) both minima still fit.
  assert.equal(listWidthPx(0, 720), MIN_LIST_PX);
  assert.equal(listWidthPx(1, 720), 720 - MIN_DETAIL_PX);
});

test("a panel too narrow for both minima splits by their ratio", () => {
  const ratio = MIN_LIST_PX / (MIN_LIST_PX + MIN_DETAIL_PX);
  assert.equal(clampFraction(0.9, 400), ratio);
  assert.equal(clampFraction(0.1, 400), ratio);
  assert.equal(clampFraction(0.5, MIN_LIST_PX + MIN_DETAIL_PX - 1), ratio);
});

test("junk falls back to the default", () => {
  assert.equal(clampFraction(Number.NaN, 1200), DEFAULT_LIST_FRACTION);
  assert.equal(clampFraction(Number.POSITIVE_INFINITY, 1200), DEFAULT_LIST_FRACTION);
  assert.equal(clampFraction(0.5, 0), 0.5);
  assert.equal(clampFraction(Number.NaN, Number.NaN), DEFAULT_LIST_FRACTION);
});

test("the fraction holds across a resize; the pixels follow", () => {
  const fraction = clampFraction(0.6, 1600);
  assert.equal(listWidthPx(fraction, 1600), 960);
  assert.equal(listWidthPx(fraction, 1000), 600);
  // Same fraction, but the minimum detail wins on a narrow panel.
  assert.equal(listWidthPx(fraction, 700), 700 - MIN_DETAIL_PX);
});

test("the pointer maps to the boundary, measured from the panel's left edge", () => {
  assert.equal(fractionFromPointer(700, 100, 1000), 0.6);
  assert.equal(fractionFromPointer(100, 100, 1000), MIN_LIST_PX / 1000);
  assert.equal(fractionFromPointer(5000, 100, 1000), 1 - MIN_DETAIL_PX / 1000);
  assert.equal(fractionFromPointer(Number.NaN, 0, 1000), DEFAULT_LIST_FRACTION);
});

test("sameFraction compares what is rendered, not the number", () => {
  assert.ok(sameFraction(0.5, 0.5001, 1000));
  assert.ok(!sameFraction(0.5, 0.52, 1000));
  // Both clamp to the same pixel.
  assert.ok(sameFraction(0.01, 0.02, 1200));
});

test("readFraction only accepts a usable fraction", () => {
  assert.equal(readFraction(0.42), 0.42);
  assert.equal(readFraction("0.42"), 0.42);
  assert.equal(readFraction(0), null);
  assert.equal(readFraction(1), null);
  assert.equal(readFraction(-0.5), null);
  assert.equal(readFraction("wide"), null);
  assert.equal(readFraction(null), null);
  assert.equal(readFraction(undefined), null);
  assert.equal(readFraction({}), null);
});
