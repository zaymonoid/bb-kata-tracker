// Shapes of the kata daemon's HTTP API (`kata openapi`, contract v0.16.0).
//
// The zod schemas double as the plugin's RPC output contract, so they list
// only the fields the plugin reads; unknown daemon fields are stripped at the
// RPC boundary. Raw daemon envelopes that never cross the RPC boundary are
// plain interfaces.
import { z } from "zod";

/** 0 is the highest priority; absent means unset. */
export const prioritySchema = z.number().int().min(0).max(4);

export const projectSchema = z.object({
  id: z.number().int(),
  uid: z.string(),
  name: z.string(),
});
export type KataProject = z.infer<typeof projectSchema>;

/** One end of a link (`LinkPeer`); `title` is filled in when kata sends it. */
export const linkPeerSchema = z.object({
  uid: z.string(),
  short_id: z.string(),
  project: z.string().optional(),
  qualified_id: z.string(),
  status: z.string(),
  title: z.string().optional(),
});
export type KataLinkPeer = z.infer<typeof linkPeerSchema>;

const peers = z.array(linkPeerSchema).nullable().optional();

/** `IssueOut`: what list endpoints return, relations included. */
export const issueSchema = z.object({
  id: z.number().int(),
  uid: z.string(),
  project_id: z.number().int(),
  project_uid: z.string().optional(),
  short_id: z.string(),
  qualified_id: z.string(),
  title: z.string(),
  body: z.string(),
  status: z.string(),
  priority: prioritySchema.optional(),
  author: z.string(),
  owner: z.string().optional(),
  labels: z.array(z.string()).nullable().optional(),
  parent: linkPeerSchema.optional(),
  blocks: peers,
  blocked_by: peers,
  related: peers,
  blocked: z.boolean().optional(),
  child_counts: z
    .object({ open: z.number().int(), total: z.number().int() })
    .optional(),
  revision: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().optional(),
  closed_reason: z.string().optional(),
});
export type KataIssue = z.infer<typeof issueSchema>;

export const commentSchema = z.object({
  uid: z.string(),
  author: z.string(),
  body: z.string(),
  created_at: z.string(),
});
export type KataComment = z.infer<typeof commentSchema>;

/** A single issue with everything the detail pane shows. */
export const issueDetailSchema = z.object({
  issue: issueSchema,
  children: z.array(linkPeerSchema),
  comments: z.array(commentSchema),
});
export type KataIssueDetail = z.infer<typeof issueDetailSchema>;

// ---- raw daemon envelopes --------------------------------------------------

/** `Issue`: the bare row `showIssue` returns (no relations or labels). */
export type KataRawIssue = Omit<
  KataIssue,
  "qualified_id" | "labels" | "parent" | "blocks" | "blocked_by" | "related"
> & { qualified_id?: string };

export interface KataLink {
  id: number;
  type: string;
  from: KataLinkPeer;
  to: KataLinkPeer;
}

export interface KataShowIssueResponse {
  issue: KataRawIssue;
  comments: KataComment[] | null;
  links: KataLink[] | null;
  labels: { label: string }[] | null;
  parent?: KataLinkPeer;
  children?: KataIssue[] | null;
}

/** `EventEnvelope`. Only the routing fields; payloads vary by type. */
export interface KataEvent {
  event_id: number;
  type: string;
  project_id: number;
  project_uid: string;
  project_name: string;
  issue_uid?: string;
  issue_short_id?: string;
  actor: string;
  created_at: string;
}

export interface KataPollEventsResponse {
  events: KataEvent[] | null;
  next_after_id: number;
  reset_required: boolean;
  reset_after_id?: number;
}

/** `MutationResponseBody` and friends: the bare issue row after a change. */
export interface KataMutationResponse {
  issue: KataRawIssue;
  changed: boolean;
}

export interface KataLabelCount {
  label: string;
  count: number;
}

export interface KataCreateIssueBody {
  title: string;
  actor: string;
  body?: string;
  priority?: number;
  labels?: string[];
  /** `incoming: true` reverses the link (for `blocked_by`: the peer blocks the new issue). */
  links?: { type: "parent" | "blocks" | "related"; to_ref: string; incoming?: boolean }[];
}

export interface KataLinksDelta {
  set_parent?: string;
  remove_parent?: string;
  add_blocks?: string[];
  add_blocked_by?: string[];
  add_related?: string[];
}

export interface KataEditIssueBody {
  actor: string;
  title?: string;
  body?: string;
  set_priority?: number;
  clear_priority?: boolean;
  links_delta?: KataLinksDelta;
}

/** One `GET .../search` result; `issue` is the bare row. */
export interface KataSearchHit {
  issue: KataRawIssue;
  score: number;
  matched_in: string[] | null;
}

/** Close evidence (`Evidence`); which fields are set depends on `type`. */
export interface KataEvidence {
  type: string;
  sha?: string;
  url?: string;
  command?: string;
  paths?: string[];
  account?: string;
  issue_ref?: string;
}

export type IssueStatusFilter = "open" | "closed" | "all";
