// Native agent tools mirroring `bb kata` (same service, same project
// resolution from the calling thread), selected by `bb.agents.configure`
// only for kata-bound threads.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  boundText,
  detailJson,
  formatDetail,
  issueLine,
  KataUsageError,
  LIST_MAX_LIMIT,
  parseEvidence,
} from "./cli-core.ts";
import { CLOSE_REASONS } from "./close-rules.ts";
import { KataApiError, KataUnavailableError } from "./kata-client.ts";
import type { KataIssueDetail } from "./kata-types.ts";
import type { KataService, Scope } from "./kata-service.ts";

export const KATA_TOOL_NAMES = [
  "kata_list",
  "kata_show",
  "kata_create",
  "kata_update",
  "kata_comment",
  "kata_close",
  "kata_link_thread",
] as const;

/** Tool results stay small; the model can page with `limit` or use `bb kata`. */
const TOOL_MAX_BYTES = 64 * 1024;

const ref = z.string().min(1).max(200).describe("Issue ref: abc4, project#abc4, or the issue ULID");
const project = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe("Kata project name; default is this thread's .kata.toml binding");
const labels = z.array(z.string().trim().min(1).max(100)).max(20);
const priority = z.number().int().min(0).max(4);

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (value: string): ToolResult => ({ content: [{ type: "text", text: boundText(value, TOOL_MAX_BYTES) }] });

function failure(error: unknown): ToolResult {
  let message: string;
  if (error instanceof KataUsageError) message = error.hint ? `${error.message}. ${error.hint}` : error.message;
  else if (error instanceof KataApiError) {
    message = `kata: ${error.message}`;
    if (/close|evidence|message too short/iu.test(error.message)) {
      message += ". If the work is not verified, do not close: add the needs-review label and comment what remains.";
    }
  } else if (error instanceof KataUnavailableError) message = `${error.message}. Is the kata daemon running?`;
  else message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message.slice(0, 4000) }], isError: true };
}

const changed = (d: KataIssueDetail) => `${d.issue.qualified_id}  ${issueLine(d.issue)}`;

export function registerKataTools(bb: BbPluginApi, service: KataService) {
  const scope = (p: string | undefined, ctx: { threadId: string; projectId: string }, usage: string): Scope => ({
    project: p,
    threadId: ctx.threadId,
    projectId: ctx.projectId,
    usage,
  });
  const run = async (fn: () => Promise<string>) => {
    try {
      return text(await fn());
    } catch (error) {
      return failure(error);
    }
  };

  bb.agents.registerTool({
    name: "kata_list",
    description:
      "List kata issues for this thread's kata project (or `project`), sorted by priority then last update. One line per issue: `P2 abc4  title  [labels] @owner`. Use `ready: true` for open issues with no open blockers, or `query` to search titles, bodies and comments (open and closed).",
    presentation: { label: { pending: "Listing kata issues", completed: "Listed kata issues" } },
    parameters: z
      .object({
        project,
        status: z.enum(["open", "closed", "all"]).default("open"),
        ready: z.boolean().optional().describe("Only open issues with no open blockers"),
        query: z.string().trim().min(1).max(500).optional().describe("Search text instead of a filtered list"),
        priority: priority.optional(),
        labels: labels.optional().describe("All must match"),
        owner: z.string().min(1).max(100).optional(),
        limit: z.number().int().min(1).max(LIST_MAX_LIMIT).default(50),
      })
      .strict(),
    execute: (params, ctx) =>
      run(async () => {
        const s = scope(params.project, ctx, "kata_list");
        if (params.query) {
          const { project: p, hits } = await service.search(s, params.query, Math.min(params.limit, 100));
          if (hits.length === 0) return `${p.name}: no matches for ${JSON.stringify(params.query)}`;
          return [`${p.name} search results:`, ...hits.map((h) => issueLine(h.issue))].join("\n");
        }
        const filter = {
          labels: params.labels,
          ...(params.owner ? { owner: params.owner } : {}),
          limit: params.limit,
        };
        const result = params.ready
          ? await service.ready(s, filter)
          : await service.list(s, {
              ...filter,
              status: params.status,
              ...(params.priority === undefined ? {} : { priority: params.priority }),
            });
        if (result.issues.length === 0) return `${result.project.name}: no issues match`;
        const more = result.total - result.issues.length;
        return [
          `${result.project.name} (${result.total} ${params.ready ? "ready" : params.status}):`,
          ...result.issues.map(issueLine),
          ...(more > 0 ? [`… ${more} more (raise limit)`] : []),
        ].join("\n");
      }),
  });

  bb.agents.registerTool({
    name: "kata_show",
    description: "Show one kata issue: fields, markdown body, parent/children/blocks/blocked_by/related, and the last 20 comments.",
    presentation: { label: { pending: "Reading kata issue", completed: "Read kata issue" } },
    parameters: z.object({ ref, project, json: z.boolean().optional().describe("Return JSON instead of text") }).strict(),
    execute: (params, ctx) =>
      run(async () => {
        const d = await service.show(scope(params.project, ctx, "kata_show"), params.ref);
        return params.json ? JSON.stringify(detailJson(d)) : formatDetail(d);
      }),
  });

  bb.agents.registerTool({
    name: "kata_create",
    description:
      "Create a kata issue and return its qualified id. Search first (kata_list with `query`) so you do not file a duplicate.",
    presentation: { label: { pending: "Creating kata issue", completed: "Created kata issue" } },
    parameters: z
      .object({
        title: z.string().trim().min(1).max(500),
        body: z.string().max(65_536).optional().describe("Markdown body"),
        priority: priority.optional().describe("0-4, 0 is highest"),
        parent: ref.optional().describe("Parent issue ref (containment only)"),
        labels: labels.optional(),
        blocked_by: z.array(ref).max(20).optional().describe("Issues that must close first"),
        blocks: z.array(ref).max(20).optional(),
        related: z.array(ref).max(20).optional(),
        project,
      })
      .strict(),
    execute: (params, ctx) =>
      run(async () => {
        const d = await service.create(scope(params.project, ctx, "kata_create"), {
          title: params.title,
          ...(params.body === undefined ? {} : { body: params.body }),
          ...(params.priority === undefined ? {} : { priority: params.priority }),
          ...(params.parent === undefined ? {} : { parent: params.parent }),
          labels: params.labels,
          blockedBy: params.blocked_by,
          blocks: params.blocks,
          related: params.related,
        });
        return `created ${changed(d)}`;
      }),
  });

  bb.agents.registerTool({
    name: "kata_update",
    description:
      "Update a kata issue: priority (0-4, null clears), title, body (replaces it), add_labels / remove_labels, parent (ref, or null to detach). Pass only the fields to change.",
    presentation: { label: { pending: "Updating kata issue", completed: "Updated kata issue" } },
    parameters: z
      .object({
        ref,
        project,
        priority: priority.nullable().optional(),
        title: z.string().trim().min(1).max(500).optional(),
        body: z.string().max(65_536).optional(),
        add_labels: labels.optional(),
        remove_labels: labels.optional(),
        parent: ref.nullable().optional(),
      })
      .strict(),
    execute: (params, ctx) =>
      run(async () => {
        const d = await service.update(scope(params.project, ctx, "kata_update"), params.ref, {
          ...(params.priority === undefined ? {} : { priority: params.priority }),
          ...(params.title === undefined ? {} : { title: params.title }),
          ...(params.body === undefined ? {} : { body: params.body }),
          ...(params.add_labels ? { addLabels: params.add_labels } : {}),
          ...(params.remove_labels ? { removeLabels: params.remove_labels } : {}),
          ...(params.parent === undefined ? {} : { parent: params.parent }),
        });
        return `updated ${changed(d)}`;
      }),
  });

  bb.agents.registerTool({
    name: "kata_comment",
    description: "Add a markdown comment to a kata issue (progress notes, what remains, review findings).",
    presentation: { label: { pending: "Commenting on kata issue", completed: "Commented on kata issue" } },
    parameters: z.object({ ref, body: z.string().trim().min(1).max(65_536), project }).strict(),
    execute: (params, ctx) =>
      run(async () => {
        const d = await service.comment(scope(params.project, ctx, "kata_comment"), params.ref, params.body);
        return `commented on ${d.issue.qualified_id} (${d.comments.length} comments)`;
      }),
  });

  bb.agents.registerTool({
    name: "kata_close",
    description:
      "Close a kata issue. Only close verified work. done: message of 40+ characters and at least one evidence item (commit:<sha>, pr:<url>, test:<cmd>, reviewed-paths:<a,b>, external:<account>). wontfix: 60+ characters. duplicate / superseded: 20+ characters and `target`. If the work is not verified, do not close; add the needs-review label (kata_update) and comment what remains. `dry_run` validates without closing.",
    presentation: { label: { pending: "Closing kata issue", completed: "Closed kata issue" } },
    parameters: z
      .object({
        ref,
        reason: z.enum(CLOSE_REASONS),
        message: z.string().trim().min(1).max(8000),
        evidence: z.array(z.string().min(3).max(1000)).max(20).optional().describe("kind:value items, e.g. test:npm test"),
        target: ref.optional().describe("The other issue, for duplicate / superseded"),
        dry_run: z.boolean().optional(),
        project,
      })
      .strict(),
    execute: (params, ctx) =>
      run(async () => {
        const result = await service.close(scope(params.project, ctx, "kata_close"), params.ref, {
          reason: params.reason,
          message: params.message,
          evidence: (params.evidence ?? []).map(parseEvidence),
          ...(params.target ? { target: params.target } : {}),
          dryRun: params.dry_run ?? false,
        });
        if (result.dryRun) return `dry run ok: ${result.issue.short_id} would close as ${params.reason}`;
        return `closed ${changed(result.detail)}`;
      }),
  });

  bb.agents.registerTool({
    name: "kata_link_thread",
    description:
      "Link this thread to a kata issue (shown in the thread header; bb links it for the next session). Pass `ref: null` to unlink.",
    presentation: { label: { pending: "Linking kata issue", completed: "Linked kata issue" } },
    parameters: z.object({ ref: ref.nullable(), project }).strict(),
    execute: (params, ctx) =>
      run(async () => {
        if (params.ref === null) {
          const before = await service.unlink(ctx.threadId);
          return before ? `unlinked from ${before.qualifiedId}` : "this thread was not linked";
        }
        const { link, title } = await service.link(ctx.threadId, scope(params.project, ctx, "kata_link_thread"), params.ref);
        return `linked this thread to ${link.qualifiedId}  ${title}`;
      }),
  });
}
