import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boundText,
  closeBody,
  createBody,
  issueLine,
  KataUsageError,
  listFilter,
  parseEvidence,
  parsePriority,
  detailJson,
  formatDetail,
  parseRef,
  resolveProject,
  sortIssues,
  type ProjectResolverDeps,
} from "./cli-core.ts";

test("parseRef: bare, qualified, ULID", () => {
  assert.deepEqual(parseRef("abc4"), { kind: "short", ref: "abc4" });
  assert.deepEqual(parseRef(" ABC4 "), { kind: "short", ref: "abc4" });
  assert.deepEqual(parseRef("grippify#06fh"), { kind: "qualified", project: "grippify", ref: "06fh" });
  assert.deepEqual(parseRef("bb-plugin-kata-scratch#tcz4"), {
    kind: "qualified",
    project: "bb-plugin-kata-scratch",
    ref: "tcz4",
  });
  assert.deepEqual(parseRef("01m348tf0gjtpax1xgrc60tcz4"), { kind: "uid", ref: "01M348TF0GJTPAX1XGRC60TCZ4" });
  for (const bad of ["", "#abc", "grippify#", "a b", "x#y#z", "../etc", "abc4; rm", "#"]) {
    assert.throws(() => parseRef(bad), KataUsageError, bad);
  }
});

const projects = [
  { id: 5, uid: "01KGRIPPIFY000000000000000", name: "grippify" },
  { id: 12, uid: "01M3475DE16AW4481B4VA2RFHX", name: "bb-plugin-kata-scratch" },
];

function deps(bound: { thread?: string; project?: string } = {}): ProjectResolverDeps & { calls: string[] } {
  const calls: string[] = [];
  const byName = (name?: string) => projects.find((p) => p.name === name) ?? null;
  return {
    calls,
    projects: async () => projects,
    forThread: async (id) => (calls.push(`thread:${id}`), byName(bound.thread)),
    forProject: async (id) => (calls.push(`project:${id}`), byName(bound.project)),
  };
}

test("resolveProject: --project beats thread and project bindings", async () => {
  const d = deps({ thread: "grippify", project: "grippify" });
  const r = await resolveProject({ explicit: "bb-plugin-kata-scratch", threadId: "thr_a", projectId: "proj_a" }, d, "bb kata list");
  assert.equal(r.project.id, 12);
  assert.equal(r.source, "flag");
  assert.deepEqual(d.calls, []);
  // uid and numeric id work too
  assert.equal((await resolveProject({ explicit: "01M3475DE16AW4481B4VA2RFHX" }, d, "")).project.id, 12);
  assert.equal((await resolveProject({ explicit: "5" }, d, "")).project.name, "grippify");
});

test("resolveProject: thread binding, then bb project binding", async () => {
  const d = deps({ thread: "grippify", project: "bb-plugin-kata-scratch" });
  const r = await resolveProject({ threadId: "thr_a", projectId: "proj_a" }, d, "bb kata list");
  assert.equal(r.project.name, "grippify");
  assert.equal(r.source, "thread");
  const unboundThread = deps({ project: "bb-plugin-kata-scratch" });
  const r2 = await resolveProject({ threadId: "thr_a", projectId: "proj_a" }, unboundThread, "bb kata list");
  assert.equal(r2.source, "project");
  assert.deepEqual(unboundThread.calls, ["thread:thr_a", "project:proj_a"]);
});

test("resolveProject: a qualified ref overrides the context, conflicts with --project", async () => {
  const d = deps({ thread: "grippify" });
  const r = await resolveProject({ fromRef: { name: "bb-plugin-kata-scratch" }, threadId: "thr_a" }, d, "");
  assert.equal(r.project.id, 12);
  assert.equal(r.source, "ref");
  const byId = await resolveProject({ fromRef: { id: 5 }, threadId: "thr_a" }, d, "");
  assert.equal(byId.project.name, "grippify");
  await assert.rejects(
    resolveProject({ explicit: "grippify", fromRef: { name: "bb-plugin-kata-scratch" } }, d, ""),
    (e: KataUsageError) => e.code === "project_conflict",
  );
  await assert.rejects(resolveProject({ fromRef: { name: "ghost" } }, d, ""), (e: KataUsageError) => e.code === "project_not_found");
});

test("resolveProject: unresolvable → hint names the --project flag and the projects", async () => {
  await assert.rejects(resolveProject({ threadId: "thr_a", projectId: "proj_a" }, deps(), "bb kata list"), (e: KataUsageError) => {
    assert.equal(e.code, "project_required");
    assert.match(e.hint ?? "", /`bb kata list --project grippify`/);
    assert.match(e.hint ?? "", /grippify, bb-plugin-kata-scratch/);
    return true;
  });
  await assert.rejects(resolveProject({ explicit: "nope" }, deps(), ""), (e: KataUsageError) => /grippify/.test(e.hint ?? ""));
});

test("listFilter: defaults, clamps, labels", () => {
  assert.deepEqual(listFilter({}), { status: "open", limit: 50 });
  assert.deepEqual(listFilter({ status: "all", priority: 1, labels: ["a", " b ", "a", ""], owner: "z", limit: 9000 }), {
    status: "all",
    priority: 1,
    labels: ["a", "b"],
    owner: "z",
    limit: 500,
  });
  assert.deepEqual(listFilter({ unowned: true, limit: 3 }), { status: "open", unowned: true, limit: 3 });
  assert.throws(() => listFilter({ owner: "z", unowned: true }), KataUsageError);
});

test("parsePriority", () => {
  assert.equal(parsePriority("0"), 0);
  assert.equal(parsePriority("P3"), 3);
  assert.equal(parsePriority("-"), null);
  assert.equal(parsePriority("none"), null);
  assert.throws(() => parsePriority("5"), KataUsageError);
  assert.throws(() => parsePriority("high"), KataUsageError);
});

test("createBody: links, labels, trimming", () => {
  assert.deepEqual(
    createBody(
      {
        title: "  Fix it ",
        body: "details",
        priority: 2,
        parent: "abc4",
        labels: ["bug", "bug", "hw"],
        blocks: ["grippify#06fh"],
        blockedBy: ["def5"],
        related: ["01M348TF0GJTPAX1XGRC60TCZ4"],
      },
      "zaymonoid",
    ),
    {
      title: "Fix it",
      actor: "zaymonoid",
      body: "details",
      priority: 2,
      labels: ["bug", "hw"],
      links: [
        { type: "parent", to_ref: "abc4" },
        { type: "blocks", to_ref: "grippify#06fh" },
        { type: "blocks", to_ref: "def5", incoming: true },
        { type: "related", to_ref: "01M348TF0GJTPAX1XGRC60TCZ4" },
      ],
    },
  );
  assert.deepEqual(createBody({ title: "x", body: "  " }, "a"), { title: "x", actor: "a" });
  assert.throws(() => createBody({ title: "  " }, "a"), KataUsageError);
  assert.throws(() => createBody({ title: "x", parent: "not a ref" }, "a"), KataUsageError);
});

const long = (n: number) => "x".repeat(n);

test("closeBody: mirrors the daemon's agent close rules", () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
      return "ok";
    } catch (e) {
      return (e as KataUsageError).message;
    }
  };
  // done: 40+ chars and evidence
  assert.match(code(() => closeBody({ reason: "done", message: long(39), evidence: [{ type: "test", command: "t" }] }, "a")), /40\+ characters \(got 39\)/);
  assert.match(code(() => closeBody({ reason: "done", message: long(40) }, "a")), /evidence/);
  assert.deepEqual(closeBody({ reason: "done", message: `  ${long(40)} `, evidence: [{ type: "commit", sha: "abc" }], dryRun: true }, "a"), {
    actor: "a",
    reason: "done",
    message: long(40),
    evidence: [{ type: "commit", sha: "abc" }],
    dry_run: true,
  });
  // whitespace is normalized before counting, like the daemon
  assert.match(code(() => closeBody({ reason: "wontfix", message: `${long(30)}      ${long(28)}` }, "a")), /60\+ characters \(got 59\)/);
  assert.equal(code(() => closeBody({ reason: "wontfix", message: long(60) }, "a")), "ok");
  // duplicate / superseded: 20+ and a target
  assert.match(code(() => closeBody({ reason: "duplicate", message: long(25) }, "a")), /other issue/);
  assert.deepEqual(closeBody({ reason: "superseded", message: long(20), target: "abc4" }, "a").evidence, [
    { type: "superseded-by", issue_ref: "abc4" },
  ]);
  assert.match(code(() => closeBody({ reason: "duplicate", message: long(19), target: "abc4" }, "a")), /20\+/);
  // the hint points at needs-review
  try {
    closeBody({ reason: "done", message: "" }, "a");
  } catch (e) {
    assert.match((e as KataUsageError).hint ?? "", /needs-review/);
  }
});

test("parseEvidence", () => {
  assert.deepEqual(parseEvidence("commit:abc123"), { type: "commit", sha: "abc123" });
  assert.deepEqual(parseEvidence("test:npm test"), { type: "test", command: "npm test" });
  assert.deepEqual(parseEvidence("pr:https://x/y/1"), { type: "pr", url: "https://x/y/1" });
  assert.deepEqual(parseEvidence("reviewed-paths:a.ts, b.ts"), { type: "reviewed-paths", paths: ["a.ts", "b.ts"] });
  assert.deepEqual(parseEvidence("external:bob"), { type: "external", account: "bob" });
  assert.throws(() => parseEvidence("commit:"), KataUsageError);
  assert.throws(() => parseEvidence("magic:yes"), KataUsageError);
});

test("sortIssues + issueLine", () => {
  const rows = sortIssues([
    { short_id: "u1", title: "unset", status: "open", priority: undefined, updated_at: "2026-09-03", labels: [], owner: undefined },
    { short_id: "a2", title: "old p2", status: "open", priority: 2, updated_at: "2026-09-01", labels: ["x", "y"], owner: "z" },
    { short_id: "b2", title: "new p2", status: "open", priority: 2, updated_at: "2026-09-02", labels: null, owner: undefined },
    { short_id: "c0", title: "p0", status: "closed", priority: 0, updated_at: "2026-08-01", labels: [], owner: undefined },
  ]);
  assert.deepEqual(rows.map(issueLine), [
    "P0 c0  p0 (closed)",
    "P2 b2  new p2",
    "P2 a2  old p2  [x, y] @z",
    "-- u1  unset",
  ]);
});

test("boundText cuts on bytes with a note", () => {
  assert.equal(boundText("short", 100), "short");
  const cut = boundText("é".repeat(100), 60);
  assert.ok(Buffer.byteLength(cut) <= 60);
  assert.match(cut, /output truncated/);
});

test("formatDetail / detailJson carry a ready-to-paste directive", () => {
  const issue = {
    id: 1, uid: "01M348TF0GJTPAX1XGRC60TCZ4", project_id: 12, short_id: "tcz4",
    qualified_id: "bb-plugin-kata-scratch#tcz4", title: "t", body: "", status: "open",
    author: "me", revision: 1, created_at: "2026-09-22", updated_at: "2026-09-22",
  };
  const detail = { issue, children: [], comments: [] };
  assert.match(formatDetail(detail), /^mention in chat as: ::kata-issue\{ref="bb-plugin-kata-scratch#tcz4"\}$/mu);
  assert.equal(detailJson(detail).directive, '::kata-issue{ref="bb-plugin-kata-scratch#tcz4"}');
});
