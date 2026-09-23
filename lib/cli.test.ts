// argv → daemon request mapping through the real defineCli parser.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildKataCli } from "./cli.ts";
import type { KataClient } from "./kata-client.ts";
import type { KataIssue, KataShowIssueResponse } from "./kata-types.ts";
import { createKataService } from "./kata-service.ts";
import type { Binding } from "./workspace.ts";

const scratch = { id: 12, uid: "01M3475DE16AW4481B4VA2RFHX", name: "bb-plugin-kata-scratch" };
const grippify = { id: 5, uid: "01KGRIPPIFY000000000000000", name: "grippify" };

const issue = (short: string, over: Partial<KataIssue> = {}): KataIssue => ({
  id: 1,
  uid: `01M348TF0GJTPAX1XGRC60${short.toUpperCase().padStart(4, "0")}`,
  project_id: 12,
  short_id: short,
  qualified_id: `bb-plugin-kata-scratch#${short}`,
  title: `issue ${short}`,
  body: "",
  status: "open",
  author: "z",
  revision: 1,
  created_at: "2026-09-22T00:00:00Z",
  updated_at: "2026-09-22T00:00:00Z",
  ...over,
});

function setup(bound: Binding["kataProject"] = null) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string, result: (...args: any[]) => unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return result(...args);
    };
  const show = (uid: string): KataShowIssueResponse => ({
    issue: { ...issue("new1"), uid },
    comments: [],
    links: [],
    labels: [],
  });
  const client = {
    listIssues: record("listIssues", () => [
      issue("aaa1", { priority: 3 }),
      issue("bbb2", { priority: 1, labels: ["bug"], owner: "z" }),
    ]),
    getIssue: record("getIssue", (_p: number, ref: string) => show(ref)),
    createIssue: record("createIssue", () => ({ issue: issue("new1"), changed: true })),
    issueAction: record("issueAction", () => ({ issue: issue("aaa1"), changed: true })),
    editIssue: record("editIssue", () => ({ issue: issue("aaa1"), changed: true })),
    issueByUid: record("issueByUid", () => ({ issue: { ...issue("aaa1"), project_id: 5 } })),
  } as unknown as KataClient;
  const binding = (kataProject: Binding["kataProject"]): Binding => ({ kataProject, name: null, dir: null });
  const service = createKataService({
    client,
    projects: async () => [grippify, scratch],
    bindings: {
      forThread: async () => ({ binding: binding(bound) }),
      forProject: async () => binding(bound),
    },
    actor: async () => "tester",
    bbProjects: async () => [],
    included: { get: () => [], set: async (u) => u },
    threadLink: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  });
  const cli = buildKataCli({ service, readFile: async (path) => `file:${path}` });
  const run = (argv: string[], ctx = { threadId: "thr_test", projectId: "proj_test" }) => cli.run(argv, ctx);
  return { calls, run };
}

test("list: flags map onto the daemon query; output sorted by priority", async () => {
  const { calls, run } = setup();
  const r = await run([
    "list",
    "--project",
    "bb-plugin-kata-scratch",
    "--status",
    "all",
    "--priority",
    "1",
    "--label",
    "bug",
    "--label",
    "hw,ui",
    "--owner",
    "z",
    "--limit",
    "10",
  ]);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(calls[0], {
    method: "listIssues",
    args: [12, { status: "all", priority: 1, owner: "z", labels: ["bug", "hw", "ui"], limit: 2001 }],
  });
  assert.equal(r.stdout, "P1 bbb2  issue bbb2  [bug] @z\nP3 aaa1  issue aaa1\n");
});

test("list: unbound thread → error names --project; bound thread needs no flag", async () => {
  const unbound = setup();
  const r = await unbound.run(["list", "--json"]);
  assert.equal(r.exitCode, 1);
  const envelope = JSON.parse(r.stdout ?? "");
  assert.equal(envelope.error.code, "project_required");
  assert.match(envelope.error.hint, /--project grippify/);
  const bound = setup(scratch);
  const ok = await bound.run(["list", "--limit", "1"]);
  assert.equal(ok.stdout, "P1 bbb2  issue bbb2  [bug] @z\n… 1 more (raise --limit, max 500)\n");
  // --owner and --unowned are exclusive at parse time
  assert.equal((await bound.run(["list", "--owner", "a", "--unowned"])).exitCode, 1);
});

test("create: flags map onto the create body and headers; prints the qualified id", async () => {
  const { calls, run } = setup(scratch);
  const r = await run([
    "create",
    "Fix",
    "the",
    "thing",
    "--body-file",
    "notes.md",
    "--priority",
    "2",
    "--parent",
    "abc4",
    "--label",
    "bug",
    "--blocked-by",
    "def5",
    "--blocks",
    "grippify#06fh",
    "--related",
    "zz99",
    "--idempotency-key",
    "key-12345",
  ]);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(calls[0], {
    method: "createIssue",
    args: [
      12,
      {
        title: "Fix the thing",
        actor: "tester",
        body: "file:notes.md",
        priority: 2,
        labels: ["bug"],
        links: [
          { type: "parent", to_ref: "abc4" },
          { type: "blocks", to_ref: "grippify#06fh" },
          { type: "blocks", to_ref: "def5", incoming: true },
          { type: "related", to_ref: "zz99" },
        ],
      },
      "key-12345",
    ],
  });
  assert.equal(r.stdout, "bb-plugin-kata-scratch#new1\n");
  assert.equal((await run(["create", "x", "--priority", "7"])).exitCode, 1);
});

test("close: reason flags, validation before the daemon, dry run", async () => {
  const { calls, run } = setup(scratch);
  // exactly one reason
  assert.equal((await run(["close", "aaa1", "--wontfix", "--done", "-m", "x"])).exitCode, 1);
  assert.equal((await run(["close", "aaa1", "-m", "x"])).exitCode, 1);
  // wontfix message too short: rejected locally with the rule
  const short = await run(["close", "aaa1", "--wontfix", "--message", "too short", "--json"]);
  assert.equal(short.exitCode, 1);
  const err = JSON.parse(short.stdout ?? "").error;
  assert.match(err.message, /wontfix needs a message of 60\+ characters \(got 9\)/);
  assert.match(err.hint, /needs-review/);
  // done requires --evidence (parse-time constraint)
  assert.equal((await run(["close", "aaa1", "--done", "--message", "x".repeat(45)])).exitCode, 1);
  assert.equal(calls.length, 0);
  // valid done dry run
  const dry = await run(["close", "aaa1", "--done", "-m", "x".repeat(45), "--evidence", "test:npm test", "--dry-run"]);
  assert.equal(dry.exitCode, 0, dry.stderr);
  assert.deepEqual(calls[0], {
    method: "issueAction",
    args: [12, "aaa1", "close", { actor: "tester", reason: "done", message: "x".repeat(45), evidence: [{ type: "test", command: "npm test" }], dry_run: true }],
  });
  assert.match(dry.stdout ?? "", /dry run: bb-plugin-kata-scratch#aaa1 would close as done/);
  // duplicate carries its target as evidence
  await run(["close", "aaa1", "--duplicate-of", "bbb2", "-m", "same as the other one, really"]);
  assert.deepEqual((calls.at(-2)!.args[3] as { evidence: unknown }).evidence, [{ type: "duplicate-of", issue_ref: "bbb2" }]);
});

test("refs: qualified and ULID refs pick their own project", async () => {
  const { calls, run } = setup(scratch);
  await run(["show", "grippify#06fh"]);
  assert.deepEqual(calls[0], { method: "getIssue", args: [5, "06fh"] });
  calls.length = 0;
  await run(["priority", "01m348tf0gjtpax1xgrc60aaa1", "0"]);
  assert.deepEqual(calls[0], { method: "issueByUid", args: ["01M348TF0GJTPAX1XGRC60AAA1"] });
  assert.deepEqual(calls[1], { method: "issueAction", args: [5, "01M348TF0GJTPAX1XGRC60AAA1", "priority", { actor: "tester", priority: 0 }] });
  calls.length = 0;
  await run(["priority", "aaa1", "-"]);
  assert.deepEqual(calls[0], { method: "editIssue", args: [12, "aaa1", { actor: "tester", clear_priority: true }] });
  const conflict = await run(["show", "grippify#06fh", "--project", "bb-plugin-kata-scratch"]);
  assert.equal(conflict.exitCode, 1);
  assert.match(conflict.stderr ?? "", /belongs to grippify/);
});

test("help renders at every level", async () => {
  const { run } = setup();
  const top = await run(["--help"]);
  assert.equal(top.exitCode, 0);
  assert.match(top.stdout ?? "", /bb kata close/);
  const list = await run(["list", "--help"]);
  assert.match(list.stdout ?? "", /--unowned/);
  assert.match(list.stdout ?? "", /max 500/);
});
