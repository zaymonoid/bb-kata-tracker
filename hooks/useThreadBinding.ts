// A thread's kata binding (bound kata project + linked issue), held in the
// calling component's state: the header mounts once per split pane, so this
// must never be a module-level singleton. Refetches on realtime
// `thread.link` / `binding.changed` signals and after a reconnect.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { KataRpcContract, ThreadBinding } from "@/lib/rpc-contract";
import { KATA_CHANNEL, type KataSignal } from "@/lib/signals";

export interface ThreadBindingState {
  binding: ThreadBinding | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  /** Adopt a result an RPC already returned (link / unlink). */
  accept: (binding: ThreadBinding) => void;
}

function isSignal(value: unknown): value is KataSignal {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

export function useThreadBinding(threadId: string): ThreadBindingState {
  const rpc = useRpc<KataRpcContract>();
  const [binding, setBinding] = useState<ThreadBinding | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const request = useRef(0);

  const reload = useCallback(() => {
    const id = ++request.current;
    setLoading(true);
    rpc.call("binding.forThread", { threadId }).then(
      (result) => {
        if (request.current !== id) return;
        setBinding(result);
        setError(null);
        setLoading(false);
      },
      (failure: unknown) => {
        if (request.current !== id) return;
        setError(failure instanceof Error ? failure.message : String(failure));
        setLoading(false);
      },
    );
  }, [rpc, threadId]);

  useEffect(() => {
    setBinding(null);
    reload();
  }, [reload]);

  const projectId = binding?.projectId;
  const linkedProject = binding?.link?.projectUid;
  useRealtime(KATA_CHANNEL, (payload) => {
    if (!isSignal(payload)) return;
    if (payload.type === "thread.link" && payload.threadId === threadId) reload();
    else if (payload.type === "binding.changed" && payload.projectId === projectId) reload();
    // Linked issue title / status / priority changed.
    else if (payload.type === "issues.changed" && payload.projectUid === linkedProject) reload();
  });

  const connection = useRealtimeConnectionState();
  const wasDisconnected = useRef(false);
  useEffect(() => {
    if (connection === "reconnecting") wasDisconnected.current = true;
    if (connection === "connected" && wasDisconnected.current) {
      wasDisconnected.current = false;
      reload();
    }
  }, [connection, reload]);

  const accept = useCallback((next: ThreadBinding) => {
    request.current++;
    setBinding(next);
    setError(null);
    setLoading(false);
  }, []);

  return { binding, error, loading, reload, accept };
}
