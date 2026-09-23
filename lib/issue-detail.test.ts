// Run with `npm test` (node --test, type-stripping).
import assert from "node:assert/strict";
import { test } from "node:test";
import { toIssueDetail } from "./issue-detail.ts";
import type { KataLinkPeer, KataShowIssueResponse } from "./kata-types.ts";

const peer = (short: string, status = "open"): KataLinkPeer => ({
  uid: `U${short}`,
  short_id: short,
  project: "proj",
  qualified_id: `proj#${short}`,
  status,
});

const show = (overrides: Partial<KataShowIssueResponse> = {}): KataShowIssueResponse => ({
  issue: {
    id: 1,
    uid: "Uself",
    project_id: 4,
    short_id: "self",
    title: "Self",
    body: "body",
    status: "open",
    author: "me",
    revision: 1,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  comments: null,
  links: null,
  labels: null,
  ...overrides,
});

test("qualified id falls back to project#short_id", () => {
  assert.equal(toIssueDetail(show(), "proj").issue.qualified_id, "proj#self");
});

test("links fold into parent / blocks / blocked_by / related", () => {
  const detail = toIssueDetail(
    show({
      links: [
        { id: 1, type: "parent", from: peer("self"), to: peer("par") },
        { id: 2, type: "parent", from: peer("kid"), to: peer("self") },
        { id: 3, type: "blocks", from: peer("self"), to: peer("b1", "closed") },
        { id: 4, type: "blocks", from: peer("dep"), to: peer("self") },
        { id: 5, type: "related", from: peer("rel"), to: peer("self") },
      ],
      labels: [{ label: "bug" }],
    }),
    "proj",
  );
  assert.equal(detail.issue.parent?.short_id, "par");
  assert.deepEqual(detail.issue.blocks?.map((p) => p.short_id), ["b1"]);
  assert.deepEqual(detail.issue.blocked_by?.map((p) => p.short_id), ["dep"]);
  assert.deepEqual(detail.issue.related?.map((p) => p.short_id), ["rel"]);
  assert.deepEqual(detail.issue.labels, ["bug"]);
  assert.equal(detail.issue.blocked, true);
});

test("show.parent (with title) wins over the parent link", () => {
  const detail = toIssueDetail(
    show({
      parent: { ...peer("par"), title: "Parent" },
      links: [{ id: 1, type: "parent", from: peer("self"), to: peer("par") }],
    }),
    "proj",
  );
  assert.equal(detail.issue.parent?.title, "Parent");
});

test("comments are capped, newest kept", () => {
  const comments = Array.from({ length: 150 }, (_, i) => ({
    uid: `c${i}`,
    author: "me",
    body: String(i),
    created_at: "2026-01-01T00:00:00Z",
  }));
  const detail = toIssueDetail(show({ comments }), "proj");
  assert.equal(detail.comments.length, 100);
  assert.equal(detail.comments.at(-1)?.uid, "c149");
});

test("no key is undefined (bb RPC results must be strict JSON)", () => {
  const detail = toIssueDetail(show(), "proj");
  const undefinedKeys = Object.entries(detail.issue)
    .filter(([, value]) => value === undefined)
    .map(([key]) => key);
  assert.deepEqual(undefinedKeys, []);
  assert.equal("parent" in detail.issue, false);
  assert.equal("blocked" in detail.issue, false);
});
