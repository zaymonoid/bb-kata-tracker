// bb-plugin-kata — backend entry.
//
// Bridges the local kata daemon into bb: a typed client (lib/kata-client.ts),
// a warm per-project cache of open issues tailing kata's event log
// (lib/issue-store.ts), and the RPC contract the Kata panel reads
// (lib/rpc-contract.ts). Which kata projects appear as tabs is the
// `includedProjects` setting, editable here and from the panel's picker.
//
// Kata-aware threads (T3): lib/workspace.ts binds each bb project to a kata
// project through `.kata.toml`, and this plugin's thread metadata can link a
// thread to one issue. Both feed the thread header control, the "Kata issues"
// thread panel, and `bb.agents.configure`.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createKataClient, KataApiError } from "./lib/kata-client.ts";
import { findProject } from "./lib/cli-core.ts";
import { tryParseRef } from "./lib/refs.ts";
import { toIssueDetail } from "./lib/issue-detail.ts";
import { CLOSE_RULES } from "./lib/close-rules.ts";
import { createIssueStore } from "./lib/issue-store.ts";
import { KATA_TOOL_NAMES, registerKataTools } from "./lib/agent-tools.ts";
import { buildKataCli } from "./lib/cli.ts";
import { createKataService } from "./lib/kata-service.ts";
import type { KataIssue, KataProject, KataRawIssue } from "./lib/kata-types.ts";
import { rpcContract } from "./lib/rpc-contract.ts";
import { KATA_CHANNEL, type KataSignal } from "./lib/signals.ts";
import {
  agentInstructions,
  createBindingResolver,
  LINK_KEYS,
  readThreadLink,
  type Binding,
  type ThreadLink,
} from "./lib/workspace.ts";
import type { IssueSummary, ThreadBinding, ThreadLinkInfo } from "./lib/rpc-contract.ts";

export { rpcContract } from "./lib/rpc-contract.ts";
export { createBindingResolver, readThreadLink } from "./lib/workspace.ts";

/** Project lifecycle changes that can move or rebind a project's directory. */
const REBIND_CHANGES = new Set(["project-created", "project-deleted", "project-sources-changed", "project-updated"]);

const uidList = z.array(z.string().min(1).max(64)).max(64);

/** Parse the `includedProjects` setting; invalid JSON reads as empty. */
function parseIncluded(value: string): string[] {
  try {
    const parsed = uidList.safeParse(JSON.parse(value));
    return parsed.success ? [...new Set(parsed.data)] : [];
  } catch {
    return [];
  }
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    includedProjects: {
      type: "string",
      label: "Included kata projects",
      description:
        "JSON array of kata project uids shown as tabs in the Kata panel, in order. Easier to edit with the panel's + tab.",
      experimental_multiline: true,
      experimental_schema: z.string().refine((value) => {
        try {
          return uidList.safeParse(JSON.parse(value)).success;
        } catch {
          return false;
        }
      }, "Must be a JSON array of kata project uids"),
      default: "[]",
    },
    actor: {
      type: "string",
      label: "Actor",
      description:
        "Name recorded on kata changes made from bb. Empty uses $USER.",
      default: "",
    },
  });

  const publish = (signal: KataSignal) => bb.realtime.publish(KATA_CHANNEL, signal);
  const client = createKataClient({ log: (message) => bb.log.info(message) });
  const store = createIssueStore({
    client,
    log: (level, message) => bb.log[level](message),
    onIssuesChanged: (projectUid) => publish({ type: "issues.changed", projectUid }),
    onAvailability: (available, message) =>
      publish({ type: "daemon.status", available, message }),
  });
  bb.onDispose(() => store.dispose());

  let included = parseIncluded((await settings.get()).includedProjects);
  store.setIncluded(included);
  settings.onChange((next) => {
    const uids = parseIncluded(next.includedProjects);
    if (JSON.stringify(uids) === JSON.stringify(included)) return;
    included = uids;
    store.setIncluded(uids);
    publish({ type: "included.changed", projectUids: uids });
  });

  async function resolveActor(): Promise<string> {
    const configured = (await settings.get()).actor.trim();
    return configured || process.env.KATA_AUTHOR || process.env.USER || "bb";
  }

  // ---- kata-aware threads ------------------------------------------------------

  const bindings = createBindingResolver({
    sdk: () => bb.sdk,
    kataProjects: () => store.projects(),
    log: (message) => bb.log.warn(message),
    onChange: (projectId) => {
      store.setWatched(bindings.boundKataProjects());
      publish({ type: "binding.changed", projectId });
    },
  });

  /** Titles of linked issues seen lately, so the sync configure callback can quote them. */
  const linkTitles = new Map<string, string>();
  function rememberTitle(issueUid: string, title: string) {
    linkTitles.delete(issueUid);
    linkTitles.set(issueUid, title);
    if (linkTitles.size > 200) linkTitles.delete(linkTitles.keys().next().value!);
  }

  const bindingOut = (binding: Binding) => ({
    kataProject: binding.kataProject,
    tomlName: binding.name,
    reason: binding.reason ?? null,
  });

  async function hydrate(link: ThreadLink): Promise<ThreadLinkInfo> {
    const base = { ...link, title: null, status: null, priority: null };
    try {
      const project = await store.projectByUid(link.projectUid);
      const cached = (await store.listOpen(link.projectUid)).issues.find((i) => i.uid === link.issueUid);
      const issue = cached ?? (await client.getIssue(project.id, link.issueUid)).issue;
      rememberTitle(link.issueUid, issue.title);
      return { ...base, title: issue.title, status: issue.status, priority: issue.priority ?? null };
    } catch (error) {
      bb.log.warn(`hydrating ${link.qualifiedId} failed: ${String(error)}`);
      return base;
    }
  }

  async function threadBinding(threadId: string): Promise<ThreadBinding> {
    const [{ bbProjectId, binding }, metadata] = await Promise.all([
      bindings.forThread(threadId),
      bb.sdk.threads.getPluginMetadata({ threadId }),
    ]);
    const link = readThreadLink(metadata);
    return {
      projectId: bbProjectId,
      ...bindingOut(binding),
      link: link ? await hydrate(link) : null,
    };
  }

  // ---- `bb kata` CLI and agent tools (T4) ------------------------------------

  async function setIncluded(projectUids: string[]): Promise<string[]> {
    const uids = [...new Set(projectUids)];
    // onChange applies it to the store and tells open panels.
    const effective = await settings.experimental_set({ includedProjects: JSON.stringify(uids) });
    return parseIncluded(effective.includedProjects);
  }

  const service = createKataService({
    client,
    projects: () => store.projects(),
    bindings,
    actor: resolveActor,
    bbProjects: async () => (await bb.sdk.projects.list()).map((p) => ({ id: p.id, name: p.name })),
    included: { get: () => included, set: setIncluded },
    threadLink: {
      get: (threadId) => bb.sdk.threads.getPluginMetadata({ threadId }),
      set: async (threadId, link, title) => {
        rememberTitle(link.issueUid, title);
        await bb.sdk.threads.updatePluginMetadata({ threadId, set: { ...link } });
        publish({ type: "thread.link", threadId });
      },
      remove: async (threadId) => {
        await bb.sdk.threads.updatePluginMetadata({ threadId, remove: [...LINK_KEYS] });
        publish({ type: "thread.link", threadId });
      },
    },
    afterMutation: (project) => void store.refreshProject(project.uid),
  });

  /**
   * `--body-file` names a file on the machine that ran `bb kata`: the
   * thread's environment host, else the server machine. Read through
   * bb.sdk.files, never node:fs.
   */
  async function readInvokerFile(path: string, ctx: { cwd?: string; threadId?: string }): Promise<string> {
    const absolute = path.startsWith("/") ? path : ctx.cwd ? `${ctx.cwd.replace(/\/+$/u, "")}/${path}` : null;
    if (absolute === null) throw new Error(`relative path ${JSON.stringify(path)} needs a working directory; pass an absolute path`);
    let hostId: string | undefined;
    if (ctx.threadId) {
      const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
      if (thread.environmentId) hostId = (await bb.sdk.environments.get({ environmentId: thread.environmentId })).hostId;
    }
    const file = await bb.sdk.files.read({ ...(hostId ? { hostId } : {}), path: absolute });
    const text = file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
    if (text.length > 65_536) throw new Error(`${path} is over 64 KiB`);
    return text;
  }

  bb.cli.register(buildKataCli({ service, readFile: readInvokerFile }));
  registerKataTools(bb, service);

  bb.agents.configure((context) => {
    const binding = bindings.peekThread(context.project.id, context.environment.id);
    if (!binding?.kataProject) return { tools: [], skills: [] };
    const link = readThreadLink(context.pluginMetadata);
    const instructions = agentInstructions({
      kataProject: binding.kataProject,
      link,
      linkTitle: link ? (linkTitles.get(link.issueUid) ?? null) : null,
    });
    return { tools: [...KATA_TOOL_NAMES], skills: ["kata"], instructions };
  });

  bb.background.service("bindings", {
    // Resolve every project up front so the synchronous configure callback
    // has an answer on a thread's first turn, then follow lifecycle changes.
    start: async (signal) => {
      const unsubscribe = bb.sdk.subscribe({
        event: "project:changed",
        callback: (event) => {
          if (!event.changes.some((change) => REBIND_CHANGES.has(change))) return;
          if (event.id) {
            bindings.invalidate(event.id);
            store.setWatched(bindings.boundKataProjects());
            if (!event.changes.includes("project-deleted")) void bindings.forProject(event.id).catch(() => {});
          } else {
            bindings.invalidate();
          }
        },
      });
      signal.addEventListener("abort", unsubscribe, { once: true });
      try {
        const projects = await bb.sdk.projects.list();
        await Promise.allSettled(projects.map((project) => bindings.forProject(project.id)));
      } catch (error) {
        bb.log.warn(`warming kata bindings failed: ${String(error)}`);
      }
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });

  // ---- issue links (T5) ------------------------------------------------------

  /** Daemon lookups per `issues.resolve` call (warm-cache hits are free). */
  const MAX_RESOLVE_LOOKUPS = 4;

  const summaryOf = (issue: KataIssue | KataRawIssue, project: KataProject): IssueSummary => ({
    uid: issue.uid,
    projectUid: project.uid,
    projectName: project.name,
    shortId: issue.short_id,
    qualifiedId: issue.qualified_id ?? `${project.name}#${issue.short_id}`,
    title: issue.title,
    status: issue.status,
    priority: issue.priority ?? null,
    blocked: issue.blocked ?? false,
  });

  /** The first of `refs` that names an existing issue; bare ids use the thread's/project's binding. */
  async function resolveIssue(
    refs: string[],
    scope: { projectId?: string | undefined; threadId?: string | undefined },
  ): Promise<{ issue: IssueSummary | null; reason: string | null }> {
    const projects = await store.projects();
    let bound: KataProject | null | undefined;
    const boundProject = async () => {
      if (bound === undefined) {
        try {
          if (scope.threadId) bound = (await bindings.forThread(scope.threadId)).binding.kataProject;
          else if (scope.projectId) bound = (await bindings.forProject(scope.projectId)).kataProject;
          else bound = null;
        } catch {
          bound = null;
        }
      }
      return bound;
    };
    let reason = "not found";
    let lookups = 0;
    for (const raw of refs) {
      const parsed = tryParseRef(raw);
      if (parsed === null) {
        reason = "not a kata issue ref";
        continue;
      }
      let project: KataProject | null = null;
      if (parsed.kind === "qualified") {
        project = findProject(projects, parsed.project);
        if (project === null) {
          reason = `no kata project named ${parsed.project}`;
          continue;
        }
      } else if (parsed.kind === "short") {
        project = await boundProject();
        if (project === null) {
          reason = "a bare id needs a kata-bound project; use project#id";
          continue;
        }
      }
      const warmIn = project ? [project] : projects;
      for (const p of warmIn) {
        const hit = store.peekOpen(p.uid)?.issues.find((i) => i.uid === parsed.ref || i.short_id === parsed.ref);
        if (hit && (project || hit.uid === parsed.ref)) return { issue: summaryOf(hit, p), reason: null };
      }
      if (lookups++ >= MAX_RESOLVE_LOOKUPS) continue;
      try {
        if (project) {
          const { issue } = await client.getIssue(project.id, parsed.ref);
          return { issue: summaryOf(issue, project), reason: null };
        }
        const { issue } = await client.issueByUid(parsed.ref);
        const owner = projects.find((p) => p.id === issue.project_id) ?? (await store.projects(true)).find((p) => p.id === issue.project_id);
        if (owner) return { issue: summaryOf(issue, owner), reason: null };
      } catch (error) {
        reason = error instanceof KataApiError && error.status === 404 ? "not found" : `lookup failed: ${String(error instanceof Error ? error.message : error)}`;
      }
    }
    return { issue: null, reason };
  }

  bb.rpc.register(rpcContract, {
    "daemon.status": () => store.availability(),
    "projects.list": async () => ({ projects: await store.projects(true) }),
    "included.get": () => ({ projectUids: included }),
    "included.set": async ({ projectUids }) => ({ projectUids: await setIncluded(projectUids) }),
    "issues.list": async ({ projectUid, status }) => {
      if (status === "open") return store.listOpen(projectUid);
      const project = await store.projectByUid(projectUid);
      const issues = await client.listIssues(project.id, { status, limit: 2001 });
      return { issues: issues.slice(0, 2000), truncated: issues.length > 2000 };
    },
    "issues.get": async ({ projectUid, ref }) => {
      const project = await store.projectByUid(projectUid);
      return toIssueDetail(await client.getIssue(project.id, ref), project.name);
    },
    "issues.resolve": ({ refs, projectId, threadId }) => resolveIssue(refs, { projectId, threadId }),

    "binding.forProject": async ({ projectId }) => bindingOut(await bindings.forProject(projectId)),
    "binding.forThread": ({ threadId }) => threadBinding(threadId),
    "thread.linkIssue": async ({ threadId, projectUid, ref }) => {
      await service.link(threadId, { project: projectUid, usage: "thread.linkIssue" }, ref);
      return threadBinding(threadId);
    },
    "thread.unlinkIssue": async ({ threadId }) => {
      await bb.sdk.threads.updatePluginMetadata({ threadId, remove: [...LINK_KEYS] });
      publish({ type: "thread.link", threadId });
      return threadBinding(threadId);
    },

    "labels.list": async ({ projectUid }) => {
      const project = await store.projectByUid(projectUid);
      const labels = await client.listLabels(project.id);
      return { labels: labels.slice(0, 500).map(({ label, count }) => ({ label, count })) };
    },

    "issues.create": ({ projectUid, title, body, parentRef, priority, idempotencyKey }) =>
      mutate(projectUid, async (project, actor) => {
        const { issue } = await client.createIssue(
          project.id,
          {
            title,
            actor,
            ...(body?.trim() ? { body } : {}),
            ...(priority === undefined ? {} : { priority }),
            ...(parentRef ? { links: [{ type: "parent", to_ref: parentRef }] } : {}),
          },
          idempotencyKey,
        );
        return issue.uid;
      }),
    "issues.setPriority": ({ projectUid, ref, priority }) =>
      mutate(projectUid, async (project, actor) => {
        const { issue } =
          priority === null
            ? await client.editIssue(project.id, ref, { actor, clear_priority: true })
            : await client.issueAction(project.id, ref, "priority", { actor, priority });
        return issue.uid;
      }),
    "issues.close": ({ projectUid, ref, reason, message, targetRef }) =>
      mutate(projectUid, async (project, actor) => {
        const target = CLOSE_RULES[reason].target;
        const { issue } = await client.issueAction(project.id, ref, "close", {
          actor,
          reason,
          // What `kata tui` sends: a human close needs no evidence for done.
          source: "tui",
          ...(message?.trim() ? { message: message.trim() } : {}),
          ...(target && targetRef ? { evidence: [{ type: target, issue_ref: targetRef }] } : {}),
        });
        return issue.uid;
      }),
    "issues.reopen": ({ projectUid, ref }) =>
      mutate(projectUid, async (project, actor) => {
        const { issue } = await client.issueAction(project.id, ref, "reopen", { actor, source: "tui" });
        return issue.uid;
      }),
    "issues.comment": ({ projectUid, ref, body, idempotencyKey }) =>
      mutate(projectUid, async (project, actor) => {
        const { issue } = await client.addComment(project.id, ref, { body, actor }, idempotencyKey);
        return issue.uid;
      }),
    "issues.addLabel": ({ projectUid, ref, label }) =>
      mutate(projectUid, async (project, actor) => {
        const { issue } = await client.addLabel(project.id, ref, { label, actor });
        return issue.uid;
      }),
    "issues.removeLabel": ({ projectUid, ref, label }) =>
      mutate(projectUid, async (project, actor) => {
        const { issue } = await client.removeLabel(project.id, ref, label, actor);
        return issue.uid;
      }),
    "issues.edit": ({ projectUid, ref, title, body }) =>
      mutate(projectUid, async (project, actor) => {
        const { issue } = await client.editIssue(project.id, ref, {
          actor,
          ...(title === undefined ? {} : { title }),
          ...(body === undefined ? {} : { body }),
        });
        return issue.uid;
      }),
  });

  /**
   * Run one daemon mutation, then answer with the issue as `issues.get`
   * shows it (mutation responses carry only the bare row) and refresh the
   * warm cache now rather than on the next event poll.
   */
  async function mutate(
    projectUid: string,
    change: (project: KataProject, actor: string) => Promise<string>,
  ) {
    const project = await store.projectByUid(projectUid);
    const issueUid = await change(project, await resolveActor());
    void store.refreshProject(projectUid);
    return toIssueDetail(await client.getIssue(project.id, issueUid), project.name);
  }

  bb.background.service("event-tail", {
    start: (signal) => store.tail(signal),
  });

  bb.log.info(
    `loaded; ${included.length} included project(s), actor ${await resolveActor()}`,
  );
}
