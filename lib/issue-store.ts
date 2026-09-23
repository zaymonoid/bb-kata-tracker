// Server-side warm cache of open issues for every included or kata-bound project, kept
// fresh by tailing the daemon's event log.
//
// The tailer polls `GET /events?after_id=` about once a second (cheap over
// the unix socket, and immune to SSE reconnect edge cases). Any event for a
// tracked project refetches that project's open list, then announces
// `issues.changed` so open panels refetch through RPC. The cursor starts at
// the log head (the UI snapshot cursor): an `after_id` past the head is not
// clamped by kata, so it must never be guessed.
import type { KataClient } from "./kata-client.ts";
import type { KataIssue, KataProject } from "./kata-types.ts";

/** Open issues kept per project; beyond this the list is flagged truncated. */
export const MAX_CACHED_ISSUES = 2000;
const POLL_INTERVAL_MS = 1000;
const EVENT_PAGE = 500;
/** Retries while the daemon is down; low so a restarted daemon is picked up within seconds. */
const MAX_BACKOFF_MS = 4_000;
const PROJECTS_TTL_MS = 30_000;

export interface ProjectIssues {
  issues: KataIssue[];
  truncated: boolean;
}

export interface IssueStoreOptions {
  client: KataClient;
  log: (level: "info" | "warn", message: string) => void;
  onIssuesChanged: (projectUid: string) => void;
  onAvailability: (available: boolean, message: string | null) => void;
  /** Poll interval; tests shorten it. */
  pollIntervalMs?: number;
}

interface Entry {
  data: ProjectIssues | null;
  /** In-flight load; a refresh requested meanwhile sets `stale`. */
  loading: Promise<ProjectIssues> | null;
  stale: boolean;
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export function createIssueStore(options: IssueStoreOptions) {
  const { client, log } = options;
  const pollInterval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const entries = new Map<string, Entry>();
  let included: string[] = [];
  /** Projects kept warm besides the included ones (kata-bound bb projects). */
  let watched = new Set<string>();
  const tracked = (uid: string) => included.includes(uid) || watched.has(uid);
  let projectsCache: { at: number; projects: KataProject[] } | null = null;
  let available: boolean | null = null;
  let availabilityMessage: string | null = null;
  /** Aborted on dispose so in-flight loads stop publishing. */
  const lifetime = new AbortController();

  function setAvailable(next: boolean, message: string | null) {
    if (available === next) return;
    available = next;
    availabilityMessage = next ? null : message;
    log(next ? "info" : "warn", next ? "kata daemon reachable" : `kata daemon unavailable: ${message}`);
    options.onAvailability(next, message);
  }

  async function projects(force = false): Promise<KataProject[]> {
    if (!force && projectsCache && Date.now() - projectsCache.at < PROJECTS_TTL_MS) {
      return projectsCache.projects;
    }
    const list = await client.projects(lifetime.signal);
    projectsCache = { at: Date.now(), projects: list };
    return list;
  }

  async function projectByUid(uid: string): Promise<KataProject> {
    let project = (await projects()).find((p) => p.uid === uid);
    if (project === undefined) project = (await projects(true)).find((p) => p.uid === uid);
    if (project === undefined) throw new Error(`No kata project with uid ${uid}`);
    return project;
  }

  async function fetchOpen(uid: string): Promise<ProjectIssues> {
    const project = await projectByUid(uid);
    const issues = await client.listIssues(
      project.id,
      { status: "open", limit: MAX_CACHED_ISSUES + 1 },
      lifetime.signal,
    );
    return {
      issues: issues.slice(0, MAX_CACHED_ISSUES),
      truncated: issues.length > MAX_CACHED_ISSUES,
    };
  }

  function entryFor(uid: string): Entry {
    let entry = entries.get(uid);
    if (entry === undefined) {
      entry = { data: null, loading: null, stale: false };
      entries.set(uid, entry);
    }
    return entry;
  }

  /** Load (or reload) one project's open issues; concurrent calls coalesce. */
  function load(uid: string): Promise<ProjectIssues> {
    const entry = entryFor(uid);
    if (entry.loading !== null) {
      entry.stale = true;
      return entry.loading;
    }
    const run = async (): Promise<ProjectIssues> => {
      try {
        let data: ProjectIssues;
        do {
          entry.stale = false;
          data = await fetchOpen(uid);
        } while (entry.stale && !lifetime.signal.aborted);
        // Only keep caches for projects still tracked.
        if (tracked(uid)) entry.data = data;
        return data;
      } finally {
        entry.loading = null;
      }
    };
    entry.loading = run();
    return entry.loading;
  }

  async function refresh(uid: string): Promise<void> {
    try {
      const data = await load(uid);
      if (!lifetime.signal.aborted) options.onIssuesChanged(uid);
    } catch (error) {
      if (!lifetime.signal.aborted) log("warn", `refresh ${uid} failed: ${String(error)}`);
    }
  }

  function refreshAll(): Promise<void> {
    return Promise.all([...new Set([...included, ...watched])].map(refresh)).then(() => undefined);
  }

  async function tail(signal: AbortSignal): Promise<void> {
    let cursor: number | null = null;
    let backoff = pollInterval;
    while (!signal.aborted) {
      let drained = true;
      try {
        if (cursor === null) {
          cursor = await client.eventCursor(signal);
          setAvailable(true, null);
          // Anything may have changed while we were not tailing.
          projectsCache = null;
          void refreshAll();
        }
        const page = await client.events({ afterId: cursor, limit: EVENT_PAGE }, signal);
        setAvailable(true, null);
        backoff = pollInterval;
        if (page.reset_required) {
          log("info", "kata event log reset; reloading all projects");
          cursor = page.reset_after_id ?? null;
          projectsCache = null;
          void refreshAll();
          continue;
        }
        const touched = new Set<string>();
        for (const event of page.events ?? []) {
          if (event.type.startsWith("project.")) projectsCache = null;
          if (tracked(event.project_uid)) touched.add(event.project_uid);
        }
        cursor = Math.max(cursor, page.next_after_id);
        for (const uid of touched) void refresh(uid);
        drained = (page.events?.length ?? 0) < EVENT_PAGE;
      } catch (error) {
        if (signal.aborted) break;
        setAvailable(false, error instanceof Error ? error.message : String(error));
        client.invalidate();
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        await sleep(backoff, signal);
        continue;
      }
      if (drained) await sleep(pollInterval, signal);
    }
  }

  return {
    projects,
    projectByUid,
    tail,
    isAvailable: () => available,
    /** Daemon reachability as last seen by the tail (null before the first poll). */
    availability: () => ({ available, message: availabilityMessage }),
    /** Reload one project's open list now (after a mutation from bb). */
    refreshProject: (uid: string): Promise<void> =>
      tracked(uid) ? refresh(uid) : Promise.resolve(),
    /** Replace the included set; warms new projects, drops removed caches. */
    setIncluded(uids: readonly string[]) {
      const next = [...uids];
      const added = next.filter((uid) => !tracked(uid));
      const previous = included;
      included = next;
      for (const uid of previous) if (!tracked(uid)) entries.delete(uid);
      for (const uid of added) void refresh(uid);
    },
    /** Replace the extra watched set (bound projects); same warming rules. */
    setWatched(uids: readonly string[]) {
      const next = new Set(uids);
      const added = [...next].filter((uid) => !tracked(uid));
      const previous = watched;
      watched = next;
      for (const uid of previous) if (!tracked(uid)) entries.delete(uid);
      for (const uid of added) void refresh(uid);
    },
    /** The warm open list, without loading (null when not cached). */
    peekOpen: (uid: string): ProjectIssues | null => entries.get(uid)?.data ?? null,
    /** Open issues for a project: warm cache for tracked ones. */
    async listOpen(uid: string): Promise<ProjectIssues> {
      const cached = entries.get(uid)?.data;
      if (cached) return cached;
      const data = await load(uid);
      if (!tracked(uid)) entries.delete(uid);
      return data;
    },
    dispose() {
      lifetime.abort();
      entries.clear();
    },
  };
}

export type IssueStore = ReturnType<typeof createIssueStore>;
