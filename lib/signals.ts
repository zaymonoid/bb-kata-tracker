// Realtime signals from server.ts to the panel. Kept apart from the RPC
// contract so the frontend bundle does not pull in zod.
import type { ProjectGroup } from "./groups";

/** Realtime channel for cache invalidations; payload is a `KataSignal`. */
export const KATA_CHANNEL = "kata";

export type KataSignal =
  | { type: "issues.changed"; projectUid: string }
  /** The active group's projects changed (sent alongside `groups.changed`). */
  | { type: "included.changed"; projectUids: string[] }
  | { type: "groups.changed"; groups: ProjectGroup[]; activeGroupId: string }
  | { type: "daemon.status"; available: boolean; message: string | null }
  /** A thread's linked issue changed (link, unlink). */
  | { type: "thread.link"; threadId: string }
  /** A bb project's `.kata.toml` binding was (re)resolved to a different result. */
  | { type: "binding.changed"; projectId: string };
