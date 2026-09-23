// Run with `npm test` (node --test, type-stripping).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { KataIssue } from "./kata-types.ts";
import { reconcile, type Lingering, type PendingEdit } from "./optimistic.ts";

const issue = (short: string, extra: Partial<KataIssue> = {}): KataIssue => ({
  id: 1,
  uid: `U${short}`,
  project_id: 1,
  short_id: short,
  qualified_id: `p#${short}`,
  title: short,
  body: "",
  status: "open",
  author: "me",
  revision: 1,
  created_at: "",
  updated_at: "2026-09-22T00:00:00.000Z",
  ...extra,
});

let nextId = 0;
const edit = (issueUid: string, apply: PendingEdit["apply"]): PendingEdit => ({
  id: ++nextId,
  projectUid: "P",
  issueUid,
  apply,
});
const ids = (issues: KataIssue[]) => issues.map((i) => i.short_id);

test("with nothing pending the server list passes through", () => {
  const server = [issue("a"), issue("b")];
  assert.deepEqual(reconcile(server, new Map(), []), { issues: server, settled: [], unlingered: [], lingered: new Map() });
});

test("a pending priority edit shows at once and drops away on failure", () => {
  const server = [issue("a"), issue("b")];
  const p1 = edit("Ub", (i) => i && { ...i, priority: 1 });
  assert.equal(reconcile(server, new Map(), [p1]).issues[1]?.priority, 1);
  assert.equal(reconcile(server, new Map(), []).issues[1]?.priority, undefined);
});

test("a confirmed issue beats an older server copy, then settles", () => {
  const confirmed = new Map([["Ua", issue("a", { priority: 2, revision: 2 })]]);
  const stale = reconcile([issue("a")], confirmed, []);
  assert.equal(stale.issues[0]?.priority, 2);
  assert.deepEqual(stale.settled, []);
  const fresh = reconcile([issue("a", { priority: 2, revision: 2 })], confirmed, []);
  assert.deepEqual(fresh.settled, ["Ua"]);
  // A later change by someone else wins too.
  const newer = reconcile([issue("a", { priority: 4, revision: 3 })], confirmed, []);
  assert.equal(newer.issues[0]?.priority, 4);
});

test("same revision compares updated_at", () => {
  const confirmed = new Map([["Ua", issue("a", { labels: ["x"], updated_at: "2026-09-22T00:00:05.000Z" })]]);
  assert.deepEqual(reconcile([issue("a")], confirmed, []).issues[0]?.labels, ["x"]);
  assert.deepEqual(
    reconcile([issue("a", { updated_at: "2026-09-22T00:00:05.000Z" })], confirmed, []).settled,
    ["Ua"],
  );
});

test("a pending create shows its placeholder on top until confirmed", () => {
  const placeholder = issue("…", { uid: "tmp-1", title: "new" });
  const create = edit("tmp-1", (i) => i ?? placeholder);
  assert.deepEqual(ids(reconcile([issue("a")], new Map(), [create]).issues), ["…", "a"]);
});

test("a confirmed create missing from a stale list is kept on top, then settles", () => {
  const created = issue("n1", { revision: 1 });
  const confirmed = new Map([["Un1", created]]);
  assert.deepEqual(ids(reconcile([issue("a")], confirmed, []).issues), ["n1", "a"]);
  assert.deepEqual(reconcile([issue("a"), created], confirmed, []).settled, ["Un1"]);
});

test("a pending close hides the issue; a confirmed close keeps it hidden", () => {
  const close = edit("Ua", () => null);
  assert.deepEqual(ids(reconcile([issue("a"), issue("b")], new Map(), [close]).issues), ["b"]);
  const confirmed = new Map([["Ua", issue("a", { status: "closed", revision: 2 })]]);
  const stale = reconcile([issue("a"), issue("b")], confirmed, []);
  assert.deepEqual(ids(stale.issues), ["b"]);
  assert.deepEqual(stale.settled, []);
  assert.deepEqual(reconcile([issue("b")], confirmed, []).settled, ["Ua"]);
});

test("a reopened issue appears before the server list has it", () => {
  const confirmed = new Map([["Ua", issue("a", { revision: 3 })]]);
  assert.deepEqual(ids(reconcile([issue("b")], confirmed, []).issues), ["a", "b"]);
});

test("pending edits stack in order", () => {
  const server = [issue("a")];
  const first = edit("Ua", (i) => i && { ...i, priority: 1 });
  const second = edit("Ua", (i) => i && { ...i, labels: ["x"] });
  const result = reconcile(server, new Map(), [first, second]).issues[0];
  assert.equal(result?.priority, 1);
  assert.deepEqual(result?.labels, ["x"]);
});

test("an issue closed here lingers at its row, shown closed", () => {
  const closed = issue("b", { status: "closed", revision: 2 });
  const confirmed = new Map([["Ub", closed]]);
  const lingering = new Map<string, Lingering>([["Ub", { issue: closed, index: 1 }]]);
  // Stale list still has it open; fresh list has dropped it. Same picture.
  for (const server of [[issue("a"), issue("b"), issue("c")], [issue("a"), issue("c")]]) {
    const result = reconcile(server, confirmed, [], lingering);
    assert.deepEqual(ids(result.issues), ["a", "b", "c"]);
    assert.equal(result.issues[1]?.status, "closed");
  }
});

test("a lingering issue can be reopened by a pending edit", () => {
  const closed = issue("b", { status: "closed", revision: 2 });
  const lingering = new Map<string, Lingering>([["Ub", { issue: closed, index: 0 }]]);
  const reopen = edit("Ub", (i) => i && { ...i, status: "open" });
  const result = reconcile([issue("a")], new Map(), [reopen], lingering);
  assert.deepEqual(ids(result.issues), ["b", "a"]);
  assert.equal(result.issues[0]?.status, "open");
});

test("a lingering index past the end is clamped", () => {
  const closed = issue("z", { status: "closed" });
  const lingering = new Map<string, Lingering>([["Uz", { issue: closed, index: 9 }]]);
  assert.deepEqual(ids(reconcile([issue("a")], new Map(), [], lingering).issues), ["a", "z"]);
});

test("an issue reopened here keeps its row, even once the open list has it", () => {
  const reopened = issue("b", { revision: 3 });
  const confirmed = new Map([["Ub", reopened]]);
  const lingering = new Map<string, Lingering>([["Ub", { issue: reopened, index: 1 }]]);
  const before = reconcile([issue("a"), issue("c")], confirmed, [], lingering);
  assert.deepEqual(ids(before.issues), ["a", "b", "c"]);
  assert.equal(before.issues[1]?.status, "open");
  // The refetched list has it first (newest): it still sits at its row, now seen.
  const after = reconcile([reopened, issue("a"), issue("c")], confirmed, [], lingering);
  assert.deepEqual(ids(after.issues), ["a", "b", "c"]);
  assert.equal(after.lingered.get("Ub")?.seen, true);
  assert.deepEqual(after.settled, ["Ub"]);
  // Closed elsewhere afterwards: it leaves the open list and stops lingering.
  const gone = reconcile([issue("a"), issue("c")], new Map(), [], after.lingered);
  assert.deepEqual(ids(gone.issues), ["a", "c"]);
  assert.deepEqual(gone.unlingered, ["Ub"]);
});

test("a lingering row shows the confirmed copy after it settles", () => {
  const closed = issue("b", { status: "closed", revision: 2 });
  const edited = issue("b", { status: "closed", revision: 3, priority: 1 });
  const lingering = new Map<string, Lingering>([["Ub", { issue: closed, index: 0 }]]);
  const first = reconcile([issue("a")], new Map([["Ub", edited]]), [], lingering);
  assert.equal(first.issues[0]?.priority, 1);
  assert.deepEqual(first.settled, ["Ub"]);
  // Next pass without the confirmed copy: the entry now carries it.
  assert.equal(reconcile([issue("a")], new Map(), [], first.lingered).issues[0]?.priority, 1);
});

test("a stale open copy does not end a close's lingering", () => {
  const closed = issue("b", { status: "closed", revision: 2 });
  const lingering = new Map<string, Lingering>([["Ub", { issue: closed, index: 1 }]]);
  const result = reconcile([issue("a"), issue("b"), issue("c")], new Map([["Ub", closed]]), [], lingering);
  assert.deepEqual(result.unlingered, []);
  assert.equal(result.lingered.get("Ub")?.seen, false);
  assert.equal(result.issues[1]?.status, "closed");
});

test("closed view: a reopened issue stays at its row, shown open", () => {
  const server = [issue("a", { status: "closed" }), issue("b", { status: "closed" }), issue("c", { status: "closed" })];
  const reopened = issue("b", { revision: 3 });
  const confirmed = new Map([["Ub", reopened]]);
  const lingering = new Map<string, Lingering>([["Ub", { issue: reopened, index: 1 }]]);
  const stale = reconcile(server, confirmed, [], lingering, "closed");
  assert.deepEqual(ids(stale.issues), ["a", "b", "c"]);
  assert.equal(stale.issues[1]?.status, "open");
  // After a refetch the closed list no longer has it; it still sits at its row.
  const fresh = reconcile([server[0]!, server[2]!], confirmed, [], lingering, "closed");
  assert.deepEqual(ids(fresh.issues), ["a", "b", "c"]);
  assert.equal(fresh.issues[1]?.status, "open");
});

test("closed view: without lingering, an issue confirmed open is hidden", () => {
  const confirmed = new Map([["Ub", issue("b", { revision: 3 })]]);
  const result = reconcile([issue("a", { status: "closed" }), issue("b", { status: "closed" })], confirmed, [], new Map(), "closed");
  assert.deepEqual(ids(result.issues), ["a"]);
  assert.deepEqual(reconcile([issue("a", { status: "closed" })], confirmed, [], new Map(), "closed").settled, ["Ub"]);
});

test("all view: closing keeps the row in place, shown closed", () => {
  const closed = issue("b", { status: "closed", revision: 2 });
  const result = reconcile([issue("a"), issue("b"), issue("c")], new Map([["Ub", closed]]), [], new Map(), "all");
  assert.deepEqual(ids(result.issues), ["a", "b", "c"]);
  assert.equal(result.issues[1]?.status, "closed");
});

test("all view: a reopened row stays put when the refetch puts it first", () => {
  const closedB = issue("b", { status: "closed", revision: 2 });
  const reopened = issue("b", { revision: 3 });
  const lingering = new Map<string, Lingering>([["Ub", { issue: reopened, index: 2 }]]);
  const refetched = [reopened, issue("a"), issue("c"), closedB.uid === "Ub" ? issue("d") : issue("e")];
  const result = reconcile(refetched, new Map([["Ub", reopened]]), [], lingering, "all");
  assert.deepEqual(ids(result.issues), ["a", "c", "b", "d"]);
});
