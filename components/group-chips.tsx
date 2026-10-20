// One pill per project group, the active one filled; clicking a chip
// activates that group. Shared by the tab strip's segment
// (components/project-tabs.tsx) and the picker's header
// (components/project-picker.tsx). Chips never take focus, so the keyboard
// stays where it was.
import type { ReactNode } from "react";
import type { ProjectGroup } from "@/lib/groups";
import { cn } from "@/lib/utils";

/** The first letter of a group's name, upper-cased: "personal" → "P". */
export const abbreviate = (name: string): string => Array.from(name.trim())[0]?.toUpperCase() ?? "";

export interface GroupChipsProps {
  groups: readonly ProjectGroup[];
  activeGroupId: string | null;
  onActivate?: ((groupId: string) => void) | undefined;
  /** Shown in place of the active chip (the picker's rename input). */
  activeEditor?: ReactNode;
  /** Show inactive groups as their first letter (the strip); the title still has the full name. */
  abbreviateInactive?: boolean;
  className?: string;
}

export function GroupChips({
  groups,
  activeGroupId,
  onActivate,
  activeEditor,
  abbreviateInactive = false,
  className,
}: GroupChipsProps) {
  return (
    <div role="group" aria-label="Project groups" className={cn("flex shrink-0 items-stretch gap-1", className)}>
      {groups.map((group) => {
        const active = group.id === activeGroupId;
        const collapsed = !active && abbreviateInactive;
        const name = group.name.trim();
        const initial = abbreviate(name);
        const rest = name.slice((Array.from(name)[0] ?? "").length);
        if (active && activeEditor !== undefined && activeEditor !== null) {
          return (
            <span key={group.id} className="flex shrink-0 items-center px-1">
              {activeEditor}
            </span>
          );
        }
        return (
          <button
            key={group.id}
            type="button"
            aria-pressed={active}
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onActivate?.(group.id)}
            title={active ? `Group: ${group.name}` : `Switch to group ${group.name} (⌘[ / ⌘])`}
            // Pills, not underlined tabs, so a group reads as a different kind
            // of thing from the project tabs beside it.
            className={cn(
              "my-auto flex h-5 max-w-40 shrink-0 items-center rounded-full text-[11px] font-semibold leading-none",
              "transition-[padding,background-color,color] duration-100 motion-reduce:transition-none",
              active
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-muted-foreground/25 hover:text-foreground",
              collapsed ? "px-[7px]" : "px-2",
            )}
          >
            {abbreviateInactive ? (
              // The initial stays put; the rest of the name slides open beside
              // it when the group becomes active (grid 0fr → 1fr animates width
              // without measuring).
              <>
                <span>{initial}</span>
                <span
                  aria-hidden={collapsed}
                  className="grid transition-[grid-template-columns] duration-100 motion-reduce:transition-none"
                  style={{ gridTemplateColumns: collapsed ? "0fr" : "1fr" }}
                >
                  <span className="min-w-0 overflow-hidden whitespace-nowrap">{rest}</span>
                </span>
              </>
            ) : (
              <span className="truncate">{group.name}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
