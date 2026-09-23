// Resolve refs to an issue summary through `issues.resolve`, cached across
// chips: every chip naming the same ref in the same scope shares one
// request. Entries of a project are dropped (once per signal, batched in a
// microtask) when it emits `issues.changed`, so titles and status stay live.
// "Not found" answers expire after a while; failed calls are not cached.
import { useEffect, useState, useSyncExternalStore } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { IssueSummary, KataRpcContract } from "@/lib/rpc-contract";
import { KATA_CHANNEL, type KataSignal } from "@/lib/signals";

export interface ResolveInput {
  refs: string[];
  projectId?: string | undefined;
  threadId?: string | undefined;
}

export type Resolved =
  | { state: "loading" }
  | { state: "found"; issue: IssueSummary }
  | { state: "missing"; reason: string };

interface Entry {
  promise: Promise<Resolved>;
  value: Resolved | null;
  at: number;
}

const MISSING_TTL_MS = 30_000;
const MAX_ENTRIES = 500;
const cache = new Map<string, Entry>();
let version = 0;
const listeners = new Set<() => void>();
const dirty = new Set<string>();

function invalidateSoon(projectUid: string | null) {
  if (dirty.size === 0) {
    queueMicrotask(() => {
      const all = dirty.has("*");
      for (const [key, entry] of cache) {
        const uid = entry.value?.state === "found" ? entry.value.issue.projectUid : null;
        if (all || (uid !== null && dirty.has(uid)) || entry.value?.state === "missing") cache.delete(key);
      }
      dirty.clear();
      version++;
      listeners.forEach((listener) => listener());
    });
  }
  dirty.add(projectUid ?? "*");
}

const store = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  version: () => version,
};

function resolve(rpc: ReturnType<typeof useRpc<KataRpcContract>>, key: string, input: ResolveInput): Entry {
  const hit = cache.get(key);
  if (hit && !(hit.value?.state === "missing" && Date.now() - hit.at > MISSING_TTL_MS)) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const entry: Entry = {
    at: Date.now(),
    value: null,
    promise: rpc
      .call("issues.resolve", {
        refs: input.refs,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
      })
      .then(({ issue, reason }): Resolved =>
        issue ? { state: "found", issue } : { state: "missing", reason: reason ?? "not found" },
      ),
  };
  entry.promise.then(
    (value) => {
      entry.value = value;
    },
    () => {
      if (cache.get(key) === entry) cache.delete(key);
    },
  );
  cache.set(key, entry);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  return entry;
}

function isSignal(value: unknown): value is KataSignal {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

export function useResolvedIssue(input: ResolveInput | null): Resolved {
  const rpc = useRpc<KataRpcContract>();
  const key = input === null ? null : JSON.stringify([input.refs, input.projectId ?? null, input.threadId ?? null]);
  const current = useSyncExternalStore(store.subscribe, store.version);
  const [result, setResult] = useState<Resolved>(() => (key && cache.get(key)?.value) || { state: "loading" });

  useEffect(() => {
    if (key === null || input === null) return;
    const entry = resolve(rpc, key, input);
    if (entry.value) setResult(entry.value);
    let cancelled = false;
    entry.promise.then(
      (value) => !cancelled && setResult(value),
      (error: unknown) =>
        !cancelled && setResult({ state: "missing", reason: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      cancelled = true;
    };
    // `input` is captured by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, key, current]);

  const projectUid = result.state === "found" ? result.issue.projectUid : null;
  useRealtime(KATA_CHANNEL, (payload) => {
    if (!isSignal(payload)) return;
    if (payload.type === "issues.changed" && (payload.projectUid === projectUid || result.state === "missing")) {
      invalidateSoon(payload.projectUid);
    } else if (payload.type === "daemon.status" && payload.available && result.state === "missing") {
      invalidateSoon(null);
    }
  });

  return result;
}
