// The `?` overlay: every binding from lib/keymap.ts.
import { BINDING_GROUPS } from "@/lib/keymap";
import { Kbd } from "@/components/issue-bits";

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-label="Keyboard shortcuts"
      onMouseDown={onClose}
      className="absolute inset-0 z-20 flex items-center justify-center bg-background/70 p-4 backdrop-blur-[1px]"
    >
      <div
        onMouseDown={(event) => event.stopPropagation()}
        className="max-h-full w-full max-w-2xl overflow-y-auto rounded-lg border border-border bg-card p-4 shadow-lg"
      >
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-foreground">Keyboard shortcuts</h2>
          <span className="text-xs text-muted-foreground">
            <Kbd>?</Kbd> or <Kbd>esc</Kbd> to close
          </span>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {BINDING_GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {group.title}
              </h3>
              <ul className="space-y-1">
                {group.bindings.map((binding) => (
                  <li key={binding.label} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-foreground">{binding.label}</span>
                    <span className="flex shrink-0 gap-0.5">
                      {binding.keys.map((key) => (
                        <Kbd key={key}>{key}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
