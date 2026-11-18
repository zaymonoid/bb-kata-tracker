import { useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { KataRpcContract, ThreadBinding } from "@/lib/rpc-contract";
import { KATA_CHANNEL } from "@/lib/signals";

/** Header actions share one hook across the visible thread panes. */
export function useHeaderBindings(threadIds: readonly string[]) {
  const rpc = useRpc<KataRpcContract>();
  const [bindings, setBindings] = useState<ReadonlyMap<string, ThreadBinding>>(new Map());
  const cache = useRef(new Map<string, ThreadBinding>());
  const [revision, refresh] = useState(0);
  const connection = useRealtimeConnectionState();
  const idsKey = JSON.stringify(threadIds);

  useRealtime(KATA_CHANNEL, () => {
    cache.current.clear();
    refresh((value) => value + 1);
  });

  useEffect(() => {
    cache.current.clear();
    refresh((value) => value + 1);
  }, [connection]);

  useEffect(() => {
    let cancelled = false;
    const ids = JSON.parse(idsKey) as string[];
    const visible = new Set(ids);
    for (const id of cache.current.keys()) {
      if (!visible.has(id)) cache.current.delete(id);
    }
    const missing = ids.filter((id) => !cache.current.has(id));
    void (async () => {
      // The RPC bounds each batch; normally only one or two headers are visible.
      for (let start = 0; start < missing.length; start += 100) {
        const results = await rpc.call("binding.forThreads", { threadIds: missing.slice(start, start + 100) });
        if (cancelled) return;
        for (const { threadId, binding } of results) {
          if (binding) cache.current.set(threadId, binding);
        }
      }
      if (!cancelled) setBindings(new Map(cache.current));
    })().catch(() => {
      // A realtime update or reconnect retries unavailable bindings.
      if (!cancelled) setBindings(new Map(cache.current));
    });
    return () => { cancelled = true; };
  }, [idsKey, revision, rpc]);

  return bindings;
}
