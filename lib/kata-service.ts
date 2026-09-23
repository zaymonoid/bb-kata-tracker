// The operations behind `bb kata` and the kata agent tools. Both front ends
// call these; neither shells out to `kata` or goes through RPC. Every
// project-scoped call resolves its kata project with `resolveProject`
// (lib/cli-core.ts) and every mutation records the configured actor.
import {
  closeBody,
  createBody,
  KataUsageError,
  listFilter,
  parseRef,
  resolveProject,
  sortIssues,
  type CloseOptions,
  type CreateOptions,
  type ListOptions,
  type ProjectInputs,
} from "./cli-core.ts";
import { toIssueDetail } from "./issue-detail.ts";
import type { KataClient } from "./kata-client.ts";
import type { KataEditIssueBody, KataIssue, KataIssueDetail, KataProject } from "./kata-types.ts";
import { readThreadLink, type Binding, type ThreadLink } from "./workspace.ts";

/** Where a call comes from: `--project`, plus the invoking thread / bb project. */
export interface Scope {
  project?: string | undefined;
  threadId?: string | undefined;
  projectId?: string | undefined;
  /** Command line shown in the "add --project" hint, e.g. `bb kata list`. */
  usage: string;
}

export interface KataServiceDeps {
  client: KataClient;
  projects(): Promise<KataProject[]>;
  bindings: {
    forThread(threadId: string): Promise<{ binding: Binding }>;
    forProject(projectId: string): Promise<Binding>;
  };
  actor(): Promise<string>;
  bbProjects(): Promise<{ id: string; name: string }[]>;
  included: { get(): string[]; set(uids: string[]): Promise<string[]> };
  threadLink: {
    get(threadId: string): Promise<unknown>;
    set(threadId: string, link: ThreadLink, title: string): Promise<void>;
    remove(threadId: string): Promise<void>;
  };
  /** A mutation landed (refresh warm caches). */
  afterMutation?(project: KataProject): void;
}

/** Rows fetched before sorting and cutting to the requested limit. */
const LIST_FETCH_CAP = 2000;

export function createKataService(deps: KataServiceDeps) {
  const { client } = deps;

  const resolverDeps = {
    projects: deps.projects,
    forThread: async (threadId: string) => (await deps.bindings.forThread(threadId)).binding.kataProject,
    forProject: async (projectId: string) => (await deps.bindings.forProject(projectId)).kataProject,
  };

  function inputs(scope: Scope, fromRef?: ProjectInputs["fromRef"]): ProjectInputs {
    return { explicit: scope.project, fromRef, threadId: scope.threadId, projectId: scope.projectId };
  }

  async function project(scope: Scope): Promise<KataProject> {
    return (await resolveProject(inputs(scope), resolverDeps, scope.usage)).project;
  }

  /** The project and the ref to send the daemon (short id or ULID). */
  async function target(scope: Scope, raw: string): Promise<{ project: KataProject; ref: string }> {
    const parsed = parseRef(raw);
    let fromRef: ProjectInputs["fromRef"];
    if (parsed.kind === "qualified") fromRef = { name: parsed.project };
    else if (parsed.kind === "uid" && !scope.project) {
      fromRef = { id: (await client.issueByUid(parsed.ref)).issue.project_id };
    }
    const resolved = await resolveProject(inputs(scope, fromRef), resolverDeps, scope.usage);
    return { project: resolved.project, ref: parsed.ref };
  }

  async function detail(p: KataProject, ref: string): Promise<KataIssueDetail> {
    return toIssueDetail(await client.getIssue(p.id, ref), p.name);
  }

  async function mutate(scope: Scope, raw: string, change: (p: KataProject, ref: string, actor: string) => Promise<{ issue: { uid: string } }>) {
    const { project: p, ref } = await target(scope, raw);
    const { issue } = await change(p, ref, await deps.actor());
    deps.afterMutation?.(p);
    return detail(p, issue.uid);
  }

  return {
    project,
    target,

    async projects() {
      const [projects, bbProjects] = await Promise.all([deps.projects(), deps.bbProjects().catch(() => [])]);
      const included = deps.included.get();
      const bindings = await Promise.allSettled(bbProjects.map((bp) => deps.bindings.forProject(bp.id)));
      return projects.map((p) => ({
        id: p.id,
        uid: p.uid,
        name: p.name,
        included: included.includes(p.uid),
        boundBy: bbProjects
          .filter((_, i) => {
            const r = bindings[i]!;
            return r.status === "fulfilled" && r.value.kataProject?.uid === p.uid;
          })
          .map((bp) => ({ id: bp.id, name: bp.name })),
      }));
    },

    async list(scope: Scope, options: ListOptions) {
      const p = await project(scope);
      const filter = listFilter(options);
      const all = await client.listIssues(p.id, { ...filter, limit: LIST_FETCH_CAP + 1 });
      const sorted = sortIssues(all.slice(0, LIST_FETCH_CAP));
      return { project: p, issues: sorted.slice(0, filter.limit), total: sorted.length, capped: all.length > LIST_FETCH_CAP };
    },

    async ready(scope: Scope, options: Pick<ListOptions, "labels" | "owner" | "unowned" | "limit">) {
      const p = await project(scope);
      const { status: _s, ...filter } = listFilter(options);
      const issues = sortIssues(await client.ready(p.id, { ...filter, limit: LIST_FETCH_CAP }));
      return { project: p, issues: issues.slice(0, filter.limit), total: issues.length, capped: false };
    },

    async search(scope: Scope, q: string, limit: number) {
      if (q.trim() === "") throw new KataUsageError("the search query is empty", "invalid_value");
      const p = await project(scope);
      const hits = await client.search(p.id, q, { limit });
      return { project: p, hits };
    },

    async show(scope: Scope, raw: string) {
      const { project: p, ref } = await target(scope, raw);
      return detail(p, ref);
    },

    async create(scope: Scope, options: CreateOptions, idempotencyKey?: string) {
      const p = await project(scope);
      const { issue } = await client.createIssue(p.id, createBody(options, await deps.actor()), idempotencyKey);
      deps.afterMutation?.(p);
      return detail(p, issue.uid);
    },

    setPriority: (scope: Scope, raw: string, priority: number | null) =>
      mutate(scope, raw, (p, ref, actor) =>
        priority === null
          ? client.editIssue(p.id, ref, { actor, clear_priority: true })
          : client.issueAction(p.id, ref, "priority", { actor, priority }),
      ),

    edit(scope: Scope, raw: string, fields: { title?: string; body?: string }) {
      if (fields.title === undefined && fields.body === undefined) {
        throw new KataUsageError("nothing to edit", "missing_required", "Pass --title and/or --body (or --body-file).");
      }
      if (fields.title !== undefined && fields.title.trim() === "") throw new KataUsageError("the title is empty", "invalid_value");
      return mutate(scope, raw, (p, ref, actor) =>
        client.editIssue(p.id, ref, {
          actor,
          ...(fields.title === undefined ? {} : { title: fields.title.trim() }),
          ...(fields.body === undefined ? {} : { body: fields.body }),
        }),
      );
    },

    /** The agent tool's combined update: priority, title, body, labels, parent. */
    async update(
      scope: Scope,
      raw: string,
      fields: {
        priority?: number | null;
        title?: string;
        body?: string;
        addLabels?: string[];
        removeLabels?: string[];
        parent?: string | null;
      },
    ) {
      const { project: p, ref } = await target(scope, raw);
      const actor = await deps.actor();
      const patch: KataEditIssueBody = { actor };
      if (fields.title !== undefined) {
        if (fields.title.trim() === "") throw new KataUsageError("the title is empty", "invalid_value");
        patch.title = fields.title.trim();
      }
      if (fields.body !== undefined) patch.body = fields.body;
      if (fields.priority === null) patch.clear_priority = true;
      else if (fields.priority !== undefined) patch.set_priority = fields.priority;
      if (fields.parent === null) {
        const current = (await detail(p, ref)).issue.parent;
        if (current) patch.links_delta = { remove_parent: current.uid };
      } else if (fields.parent !== undefined) {
        parseRef(fields.parent);
        patch.links_delta = { set_parent: fields.parent.trim() };
      }
      let uid: string | null = null;
      if (Object.keys(patch).length > 1) uid = (await client.editIssue(p.id, ref, patch)).issue.uid;
      for (const label of fields.addLabels ?? []) uid = (await client.addLabel(p.id, ref, { label, actor })).issue.uid;
      for (const label of fields.removeLabels ?? []) uid = (await client.removeLabel(p.id, ref, label, actor)).issue.uid;
      if (uid === null) throw new KataUsageError("nothing to update", "missing_required");
      deps.afterMutation?.(p);
      return detail(p, uid);
    },

    comment(scope: Scope, raw: string, body: string) {
      if (body.trim() === "") throw new KataUsageError("the comment is empty", "invalid_value");
      return mutate(scope, raw, async (p, ref, actor) => client.addComment(p.id, ref, { body, actor }));
    },

    label(scope: Scope, raw: string, op: "add" | "rm", label: string) {
      const name = label.trim();
      if (name === "") throw new KataUsageError("the label is empty", "invalid_value");
      return mutate(scope, raw, (p, ref, actor) =>
        op === "add" ? client.addLabel(p.id, ref, { label: name, actor }) : client.removeLabel(p.id, ref, name, actor),
      );
    },

    /** Close; with `dryRun` the daemon validates and nothing changes. */
    async close(scope: Scope, raw: string, options: CloseOptions) {
      const { project: p, ref } = await target(scope, raw);
      const body = closeBody(options, await deps.actor());
      const response = await client.issueAction(p.id, ref, "close", body);
      if (options.dryRun) return { dryRun: true as const, issue: response.issue, project: p };
      deps.afterMutation?.(p);
      return { dryRun: false as const, detail: await detail(p, response.issue.uid), project: p };
    },

    reopen: (scope: Scope, raw: string) =>
      mutate(scope, raw, async (p, ref, actor) => client.issueAction(p.id, ref, "reopen", { actor })),

    // ---- thread link ----
    async linked(threadId: string) {
      return readThreadLink(await deps.threadLink.get(threadId));
    },
    async link(threadId: string, scope: Scope, raw: string) {
      const { project: p, ref } = await target(scope, raw);
      const { issue } = await client.getIssue(p.id, ref);
      const link: ThreadLink = {
        issueUid: issue.uid,
        qualifiedId: issue.qualified_id ?? `${p.name}#${issue.short_id}`,
        projectUid: p.uid,
      };
      if (!readThreadLink(link)) throw new Error(`Unexpected issue ref shape: ${link.qualifiedId}`);
      await deps.threadLink.set(threadId, link, issue.title);
      return { link, title: issue.title };
    },
    async unlink(threadId: string) {
      const before = readThreadLink(await deps.threadLink.get(threadId));
      if (before) await deps.threadLink.remove(threadId);
      return before;
    },

    // ---- viewer tabs ----
    async setIncluded(key: string, include: boolean) {
      const projects = await deps.projects();
      const { project: p } = await resolveProject({ explicit: key }, { ...resolverDeps, projects: async () => projects }, "");
      const current = deps.included.get();
      const next = include ? [...current.filter((u) => u !== p.uid), p.uid] : current.filter((u) => u !== p.uid);
      const saved = include && current.includes(p.uid) ? current : await deps.included.set(next);
      return { project: p, included: saved.map((uid) => projects.find((x) => x.uid === uid)?.name ?? uid) };
    },
  };
}

export type KataService = ReturnType<typeof createKataService>;
export type ListResult = { project: KataProject; issues: KataIssue[]; total: number; capped: boolean };
