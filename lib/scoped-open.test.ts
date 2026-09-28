// Run with `npm test` (node --test, type-stripping).
import assert from "node:assert/strict";
import { test } from "node:test";
import { scopedOpenPane } from "./scoped-open.ts";
import type { IssueTarget } from "./refs.ts";

const PROJECT = "01J0000000000000000000PRJ";
const OTHER_PROJECT = "01J0000000000000000000OTH";
const ISSUE = "01J00000000000000000000AAA";
const OTHER_ISSUE = "01J00000000000000000000BBB";

const target = (projectUid: string, issueUid: string): IssueTarget => ({
  projectUid,
  issueUid,
  qualifiedId: null,
});

test("an open with no issue lands on the list", () => {
  assert.equal(scopedOpenPane({ target: null }, { projectUid: PROJECT, target: null }), "list");
  assert.equal(
    scopedOpenPane({ target: null }, { projectUid: PROJECT, target: target(PROJECT, ISSUE) }),
    "list",
  );
});

test("an issue opens its detail in the panel holding it", () => {
  const wanted = target(PROJECT, ISSUE);
  assert.equal(scopedOpenPane({ target: wanted }, { projectUid: PROJECT, target: wanted }), "detail");
  // The same issue again (the chip clicked twice): still the detail.
  assert.equal(
    scopedOpenPane({ target: { ...wanted } }, { projectUid: PROJECT, target: { ...wanted } }),
    "detail",
  );
  // A panel with no params of its own (a plain "Kata issues" tab) takes it.
  assert.equal(scopedOpenPane({ target: wanted }, { projectUid: PROJECT, target: null }), "detail");
});

test("a panel for another issue or project leaves the request alone", () => {
  const wanted = target(PROJECT, ISSUE);
  assert.equal(
    scopedOpenPane({ target: wanted }, { projectUid: PROJECT, target: target(PROJECT, OTHER_ISSUE) }),
    null,
  );
  assert.equal(scopedOpenPane({ target: wanted }, { projectUid: OTHER_PROJECT, target: null }), null);
  assert.equal(scopedOpenPane({ target: wanted }, { projectUid: null, target: null }), null);
});
