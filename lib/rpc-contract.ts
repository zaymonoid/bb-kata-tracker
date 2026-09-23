// The frontend data plane. server.ts registers handlers against this
// contract; app code imports only its type.
//
// Mutations return the changed issue as `issues.get` would (list shape plus
// children and comments), so the UI can reconcile its optimistic state and
// its detail cache in one step.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { CLOSE_REASONS } from "./close-rules.ts";
import {
  issueDetailSchema,
  issueSchema,
  prioritySchema,
  projectSchema,
} from "./kata-types.ts";

const projectUid = z.string().min(1).max(64);
const ref = z.string().min(1).max(200);
const title = z.string().trim().min(1).max(500);
const body = z.string().max(65_536);
const label = z.string().trim().min(1).max(100);
const idempotencyKey = z.string().min(8).max(128);
const bbId = z.string().regex(/^[a-z]+_[a-z0-9]{1,64}$/u, "Expected a bb id");
/** Which panel's split is meant: only the nav page resizes today. */
const splitSurface = z.enum(["nav"]);

const boundProjectSchema = z.object({ id: z.number().int(), uid: z.string(), name: z.string() });
const bindingSchema = z.object({
  /** The kata project the bb project is bound to, or null. */
  kataProject: boundProjectSchema.nullable(),
  /** `[project] name` from `.kata.toml` (even when no kata project matches). */
  tomlName: z.string().nullable(),
  /** Why it is unbound (diagnostics). */
  reason: z.string().nullable(),
});
/** A thread's linked issue, hydrated from the daemon when it could be read. */
const threadLinkSchema = z.object({
  issueUid: z.string(),
  qualifiedId: z.string(),
  projectUid: z.string(),
  title: z.string().nullable(),
  status: z.string().nullable(),
  priority: prioritySchema.nullable(),
});
const threadBindingSchema = bindingSchema.extend({
  projectId: z.string(),
  link: threadLinkSchema.nullable(),
});
/** What an issue chip shows. */
const issueSummarySchema = z.object({
  uid: z.string(),
  projectUid: z.string(),
  projectName: z.string(),
  shortId: z.string(),
  qualifiedId: z.string(),
  title: z.string(),
  status: z.string(),
  priority: prioritySchema.nullable(),
  blocked: z.boolean(),
});
export type IssueSummary = z.infer<typeof issueSummarySchema>;
export type ThreadBinding = z.infer<typeof threadBindingSchema>;
export type ThreadLinkInfo = z.infer<typeof threadLinkSchema>;

export const rpcContract = defineRpcContract({
  /** Whether the event tail reaches the daemon; `available` is null before its first poll. */
  "daemon.status": {
    input: z.null(),
    output: z.object({ available: z.boolean().nullable(), message: z.string().nullable() }),
  },
  "projects.list": {
    input: z.null(),
    output: z.object({ projects: z.array(projectSchema) }),
  },
  /** Included project uids, in tab order. */
  "included.get": {
    input: z.null(),
    output: z.object({ projectUids: z.array(z.string()) }),
  },
  "included.set": {
    input: z.object({ projectUids: z.array(projectUid).max(64) }).strict(),
    output: z.object({ projectUids: z.array(z.string()) }),
  },
  /**
   * Open issues come from the server's warm cache; closed/all go to the
   * daemon.
   */
  "issues.list": {
    input: z
      .object({
        projectUid,
        status: z.enum(["open", "closed", "all"]).default("open"),
      })
      .strict(),
    output: z.object({
      issues: z.array(issueSchema),
      /** The list was cut at the server's row cap. */
      truncated: z.boolean(),
    }),
  },
  "issues.get": {
    input: z
      .object({ projectUid, ref })
      .strict(),
    output: issueDetailSchema,
  },
  /**
   * Resolve refs (short id, `project#abc4`, ULID) to a small summary; the
   * first that resolves wins. Short ids resolve against the thread's, else
   * the bb project's, kata binding. Unresolvable → `issue: null`.
   */
  "issues.resolve": {
    input: z
      .object({
        refs: z.array(ref).min(1).max(10),
        projectId: bbId.optional(),
        threadId: bbId.optional(),
      })
      .strict(),
    output: z.object({
      issue: issueSummarySchema.nullable(),
      /** Why nothing resolved (diagnostics / tooltip). */
      reason: z.string().nullable(),
    }),
  },
  // ---- kata-aware threads ----
  /** The kata project a bb project is bound to through `.kata.toml`. */
  "binding.forProject": {
    input: z.object({ projectId: bbId }).strict(),
    output: bindingSchema,
  },
  /** The thread's project binding plus its linked issue, if any. */
  "binding.forThread": {
    input: z.object({ threadId: bbId }).strict(),
    output: threadBindingSchema,
  },
  /** Link an issue to the thread (stored in this plugin's thread metadata). */
  "thread.linkIssue": {
    input: z.object({ threadId: bbId, projectUid, ref }).strict(),
    output: threadBindingSchema,
  },
  "thread.unlinkIssue": {
    input: z.object({ threadId: bbId }).strict(),
    output: threadBindingSchema,
  },

  // ---- layout ----
  /**
   * The panel's list/detail split, stored per surface in the plugin's own kv
   * so it follows the user across browser tabs and reloads. `listFraction` is
   * a fraction of the panel width (it survives a resize), null when nothing
   * has been saved yet.
   */
  "layout.get": {
    input: z.object({ surface: splitSurface }).strict(),
    output: z.object({ listFraction: z.number().nullable() }),
  },
  "layout.set": {
    input: z.object({ surface: splitSurface, listFraction: z.number().gt(0).lt(1) }).strict(),
    output: z.object({ listFraction: z.number() }),
  },

  /** Labels used in the project, for the label typeahead. */
  "labels.list": {
    input: z.object({ projectUid }).strict(),
    output: z.object({
      labels: z.array(z.object({ label: z.string(), count: z.number().int() })),
    }),
  },

  // ---- mutations ----
  "issues.create": {
    input: z
      .object({
        projectUid,
        title,
        body: body.optional(),
        /** short_id (or any kata ref) of the parent issue. */
        parentRef: ref.optional(),
        priority: prioritySchema.optional(),
        /** Makes a retried create land once. */
        idempotencyKey,
      })
      .strict(),
    output: issueDetailSchema,
  },
  "issues.setPriority": {
    input: z.object({ projectUid, ref, priority: prioritySchema.nullable() }).strict(),
    output: issueDetailSchema,
  },
  "issues.close": {
    input: z
      .object({
        projectUid,
        ref,
        reason: z.enum(CLOSE_REASONS),
        message: body.optional(),
        /** The other issue for `duplicate` / `superseded`. */
        targetRef: ref.optional(),
      })
      .strict(),
    output: issueDetailSchema,
  },
  "issues.reopen": {
    input: z.object({ projectUid, ref }).strict(),
    output: issueDetailSchema,
  },
  "issues.comment": {
    input: z
      .object({ projectUid, ref, body: body.refine((b) => b.trim() !== "", "Empty comment"), idempotencyKey: idempotencyKey.optional() })
      .strict(),
    output: issueDetailSchema,
  },
  "issues.addLabel": {
    input: z.object({ projectUid, ref, label }).strict(),
    output: issueDetailSchema,
  },
  "issues.removeLabel": {
    input: z.object({ projectUid, ref, label }).strict(),
    output: issueDetailSchema,
  },
  "issues.edit": {
    input: z
      .object({ projectUid, ref, title: title.optional(), body: body.optional() })
      .strict(),
    output: issueDetailSchema,
  },
});

export type KataRpcContract = typeof rpcContract;
