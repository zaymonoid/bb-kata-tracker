// Small presentational pieces shared by the list and the detail pane.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const STATUS_GLYPH = { open: "○", blocked: "⊘", closed: "✓" } as const;

export function StatusGlyph({
  status,
  blocked,
  className,
}: {
  status: string;
  blocked?: boolean;
  className?: string;
}) {
  const kind = status === "closed" ? "closed" : blocked ? "blocked" : "open";
  return (
    <span
      aria-label={kind}
      title={kind}
      className={cn(
        "inline-block w-3 shrink-0 text-center font-mono text-xs leading-none",
        kind === "closed" && "text-muted-foreground",
        kind === "blocked" && "text-destructive",
        kind === "open" && "text-foreground",
        className,
      )}
    >
      {STATUS_GLYPH[kind]}
    </span>
  );
}

const PRIORITY_TONE = [
  "bg-destructive/15 text-destructive",
  "bg-primary/15 text-primary",
  "bg-accent text-accent-foreground",
  "bg-muted text-muted-foreground",
  "bg-muted text-muted-foreground/70",
] as const;

/** P0..P4 chip; a same-width blank when unset so columns stay aligned. */
export function PriorityChip({ priority }: { priority?: number }) {
  if (priority === undefined) {
    return <span aria-hidden className="inline-block w-6 shrink-0" />;
  }
  return (
    <span
      className={cn(
        "inline-flex h-4 w-6 shrink-0 items-center justify-center rounded font-mono text-[10px] font-semibold",
        PRIORITY_TONE[priority] ?? PRIORITY_TONE[4],
      )}
    >
      P{priority}
    </span>
  );
}

export function LabelChip({ label }: { label: string }) {
  return (
    <span className="inline-flex h-4 max-w-32 shrink-0 items-center truncate rounded border border-border px-1 text-[10px] text-muted-foreground">
      {label}
    </span>
  );
}

/** The dashed box BB's own list pages use for loading and empty states. */
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="m-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[11px] text-foreground">
      {children}
    </kbd>
  );
}
