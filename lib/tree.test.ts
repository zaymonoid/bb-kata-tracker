// Run with `npm test` (node --test, type-stripping).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { KataIssue } from "./kata-types.ts";
import { buildRows, matchesFilter, parentUids, visibleRowFor } from "./tree.ts";

const issue = (short: string, parent?: string, extra: Partial<KataIssue> = {}): KataIssue => ({
  id: 1,
  uid: `U${short}`,
  project_id: 1,
  short_id: short,
  qualified_id: `p#${short}`,
  title: `title ${short}`,
  body: "",
  status: "open",
  author: "me",
  revision: 1,
  created_at: "",
  updated_at: "",
  ...(parent
    ? { parent: { uid: `U${parent}`, short_id: parent, qualified_id: `p#${parent}`, status: "open" } }
    : {}),
  ...extra,
});

// a
// ├─ b
// │  └─ d
// └─ c
// e (parent "zz" is not in the list: closed or elsewhere)
const issues = [issue("a"), issue("b", "a"), issue("c", "a"), issue("d", "b"), issue("e", "zz")];
const all = new Set(["Ua", "Ub"]);
const view = (rows: ReturnType<typeof buildRows>) => rows.map((r) => `${r.guide}${r.issue.short_id}`);

test("nested rows are collapsed by default", () => {
  const rows = buildRows(issues, { nested: true, expanded: new Set() });
  assert.deepEqual(view(rows), ["a", "e"]);
  assert.equal(rows[0]?.childCount, 2);
  assert.equal(rows[0]?.expanded, false);
  assert.equal(rows[1]?.childCount, 0);
});

test("expanded parents show children with box-drawing guides", () => {
  const rows = buildRows(issues, { nested: true, expanded: all });
  assert.deepEqual(view(rows), ["a", "├─ b", "│  └─ d", "└─ c", "e"]);
  assert.deepEqual(
    rows.map((r) => [r.depth, r.parentUid]),
    [[0, null], [1, "Ua"], [2, "Ub"], [1, "Ua"], [0, null]],
  );
});

test("the last child's subtree gets blank guides", () => {
  const list = [issue("a"), issue("b", "a"), issue("c", "b")];
  assert.deepEqual(view(buildRows(list, { nested: true, expanded: new Set(["Ua", "Ub"]) })), [
    "a",
    "└─ b",
    "   └─ c",
  ]);
});

test("a collapsed middle parent hides its subtree only", () => {
  const rows = buildRows(issues, { nested: true, expanded: new Set(["Ua"]) });
  assert.deepEqual(view(rows), ["a", "├─ b", "└─ c", "e"]);
  assert.equal(rows[1]?.childCount, 1);
});

test("orphans whose parent is not listed are roots; sibling order is list order", () => {
  const rows = buildRows([issue("x", "gone"), issue("y"), issue("z", "y"), issue("w", "y")], {
    nested: true,
    expanded: new Set(["Uy"]),
  });
  assert.deepEqual(view(rows), ["x", "y", "├─ z", "└─ w"]);
});

test("flat view lists every issue at depth 0 in list order", () => {
  const rows = buildRows(issues, { nested: false, expanded: new Set() });
  assert.deepEqual(view(rows), ["a", "b", "c", "d", "e"]);
});

test("the filter keeps matches and their ancestors, opened", () => {
  const rows = buildRows(issues, { nested: true, expanded: new Set(), filter: "title d" });
  assert.deepEqual(view(rows), ["a", "└─ b", "   └─ d"]);
  assert.deepEqual(rows.map((r) => r.match), [false, false, true]);
  assert.deepEqual(view(buildRows(issues, { nested: false, expanded: new Set(), filter: "d" })), ["d"]);
});

test("filter matches labels, short id and qualified id, all terms, any case", () => {
  const labelled = issue("k9", undefined, { title: "Fix Login", labels: ["ui", "needs-review"] });
  assert.ok(matchesFilter(labelled, "login"));
  assert.ok(matchesFilter(labelled, "REVIEW k9"));
  assert.ok(matchesFilter(labelled, "p#k9"));
  assert.ok(!matchesFilter(labelled, "login backend"));
  assert.ok(matchesFilter(labelled, "   "));
});

test("parentUids lists issues with listed children", () => {
  assert.deepEqual(parentUids(issues).sort(), ["Ua", "Ub"]);
});

test("a cycle does not hang and is broken into roots", () => {
  const rows = buildRows([issue("a", "b"), issue("b", "a")], { nested: true, expanded: new Set(["Ua", "Ub"]) });
  assert.ok(rows.length >= 2 && rows.length <= 3);
});

test("visibleRowFor falls back to the nearest shown ancestor", () => {
  const rows = buildRows(issues, { nested: true, expanded: new Set() });
  assert.equal(visibleRowFor("Ud", rows, issues), "Ua");
  assert.equal(visibleRowFor("Ue", rows, issues), "Ue");
  assert.equal(visibleRowFor("Unope", rows, issues), null);
});
