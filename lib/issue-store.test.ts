// Run with `npm test` (node --test, type-stripping).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { KataClient } from "./kata-client.ts";
import { createIssueStore } from "./issue-store.ts";
import type { KataEvent, KataIssue, KataPollEventsResponse } from "./kata-types.ts";

const projects = [
  { id: 1, uid: "PA", name: "alpha" },
  { id: 2, uid: "PB", name: "beta" },
];

const issue = (projectId: number, short: string): KataIssue => ({
  id: 1,
  uid: `U${short}`,
  project_id: projectId,
  short_id: short,
  qualified_id: `p#${short}`,
  title: short,
  body: "",
  status: "open",
  author: "me",
  revision: 1,
  created_at: "",
  updated_at: "",
});

const event = (id: number, projectUid: string, type = "issue.created"): KataEvent => ({
  event_id: id,
  type,
  project_id: projectUid === "PA" ? 1 : 2,
  project_uid: projectUid,
  project_name: "x",
  actor: "me",
  created_at: "",
});

const unused = async (): Promise<never> => {
  throw new Error("unused");
};

function fakeClient(pages: KataPollEventsResponse[]) {
  const calls = { listIssues: [] as number[], events: [] as number[] };
  let open: Record<number, KataIssue[]> = { 1: [issue(1, "a1")], 2: [issue(2, "b1")] };
  const client: KataClient = {
    projects: async () => projects,
    listIssues: async (projectId) => {
      calls.listIssues.push(projectId);
      return open[projectId] ?? [];
    },
    getIssue: async () => {
      throw new Error("unused");
    },
    events: async ({ afterId }) => {
      calls.events.push(afterId);
      return pages.shift() ?? { events: [], next_after_id: afterId, reset_required: false };
    },
    eventCursor: async () => 100,
    listLabels: unused,
    ready: unused,
    search: unused,
    issueByUid: unused,
    createIssue: unused,
    editIssue: unused,
    issueAction: unused,
    addComment: unused,
    addLabel: unused,
    removeLabel: unused,
    invalidate: () => {},
  };
  return { client, calls, setOpen: (next: typeof open) => (open = next) };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("included projects are warmed and served from cache", async () => {
  const { client, calls } = fakeClient([]);
  const changed: string[] = [];
  const store = createIssueStore({
    client,
    log: () => {},
    onIssuesChanged: (uid) => changed.push(uid),
    onAvailability: () => {},
  });
  store.setIncluded(["PA"]);
  await tick();
  assert.deepEqual(changed, ["PA"]);
  const first = await store.listOpen("PA");
  assert.deepEqual(first.issues.map((i) => i.short_id), ["a1"]);
  assert.deepEqual(calls.listIssues, [1]); // served from cache, not refetched
  store.dispose();
});

test("the tailer starts at the log head and refreshes only touched included projects", async () => {
  const { client, calls, setOpen } = fakeClient([
    {
      events: [event(101, "PA"), event(102, "PB"), event(103, "PA")],
      next_after_id: 103,
      reset_required: false,
    },
  ]);
  const changed: string[] = [];
  const store = createIssueStore({
    client,
    log: () => {},
    onIssuesChanged: (uid) => changed.push(uid),
    onAvailability: () => {},
    pollIntervalMs: 1,
  });
  store.setIncluded(["PA"]);
  await tick();
  changed.length = 0;
  calls.listIssues.length = 0;
  setOpen({ 1: [issue(1, "a1"), issue(1, "a2")], 2: [] });

  const controller = new AbortController();
  const running = store.tail(controller.signal);
  await tick();
  await tick();
  await tick();
  controller.abort();
  await running;

  assert.equal(calls.events[0], 100, "first poll starts at the snapshot cursor");
  assert.equal(calls.events[1], 103, "cursor advances to next_after_id");
  assert.ok(changed.includes("PA"));
  assert.ok(!changed.includes("PB"), "PB is not included");
  assert.ok(!calls.listIssues.includes(2));
  assert.deepEqual((await store.listOpen("PA")).issues.map((i) => i.short_id), ["a1", "a2"]);
  store.dispose();
});

test("an unreachable daemon is reported as unavailable", async () => {
  const { client } = fakeClient([]);
  let fail = true;
  const base = client.events;
  client.events = async (options, signal) => {
    if (fail) throw Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
    return base(options, signal);
  };
  const availability: boolean[] = [];
  const store = createIssueStore({
    client,
    log: () => {},
    onIssuesChanged: () => {},
    onAvailability: (available) => availability.push(available),
  });
  const controller = new AbortController();
  const running = store.tail(controller.signal);
  await tick();
  fail = false;
  // The first backoff is 2s; abort instead of waiting it out.
  controller.abort();
  await running;
  assert.deepEqual(availability, [true, false]);
  store.dispose();
});

test("removing a project drops its cache", async () => {
  const { client, calls } = fakeClient([]);
  const store = createIssueStore({
    client,
    log: () => {},
    onIssuesChanged: () => {},
    onAvailability: () => {},
  });
  store.setIncluded(["PA"]);
  await tick();
  store.setIncluded([]);
  await store.listOpen("PA");
  assert.deepEqual(calls.listIssues, [1, 1]);
  store.dispose();
});
