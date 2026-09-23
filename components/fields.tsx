// Text-field plumbing shared by the inline editors: the keys a field hands
// over come from lib/keymap.ts (`inputKey`), everything else is typing.
import { forwardRef, useCallback, useState } from "react";
import type { InputHTMLAttributes, KeyboardEvent, ReactNode, TextareaHTMLAttributes } from "react";
import { inputKey, type FieldKind, type InputCommand } from "@/lib/keymap";
import { cn } from "@/lib/utils";

export type FieldHandlers = Partial<Record<InputCommand, () => void>>;

/** Run the handler for a field's hand-over key; other keys pass through. */
export function fieldKeyDown(event: KeyboardEvent, kind: FieldKind, handlers: FieldHandlers) {
  if (event.nativeEvent.isComposing) return;
  const command = inputKey(event, kind);
  // Keep every key inside the field away from the panel's list keys.
  event.stopPropagation();
  if (command === null) return;
  const handler = handlers[command] ?? (command === "saveDraft" ? handlers.submit : undefined);
  if (handler === undefined) return;
  event.preventDefault();
  handler();
}

/**
 * Esc discards at once when nothing was typed; otherwise the first Esc arms
 * and a second one discards. Typing disarms.
 */
export function useDiscardGuard(onDiscard: () => void) {
  const [armed, setArmed] = useState(false);
  const cancel = useCallback(
    (dirty: boolean) => {
      if (!dirty || armed) onDiscard();
      else setArmed(true);
    },
    [armed, onDiscard],
  );
  const disarm = useCallback(() => setArmed(false), []);
  return { armed, cancel, disarm };
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          "block w-full resize-y rounded-md border border-input bg-transparent px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          className,
        )}
        {...props}
      />
    );
  },
);

/** Plain one-line input sized for list rows. */
export const LineInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function LineInput({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        autoComplete="off"
        spellCheck={false}
        className={cn(
          "h-6 min-w-0 flex-1 rounded border border-input bg-background px-1.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          className,
        )}
        {...props}
      />
    );
  },
);

export function FieldHint({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "error" }) {
  return (
    <p className={cn("text-[11px]", tone === "error" ? "text-destructive" : "text-muted-foreground")}>
      {children}
    </p>
  );
}
