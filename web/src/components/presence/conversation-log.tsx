"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { ConversationTurn } from "@/lib/perception/protocol";

const BOTTOM_THRESHOLD_PX = 48;

export type ConversationLogProps = {
  messages: ConversationTurn[];
  /** Live browser-STT partial while listening. */
  partial?: string;
  className?: string;
};

/**
 * Scrollable conversation transcript. Auto-scrolls to the latest turn while
 * the user is pinned to the bottom; scrolling up pauses; returning to bottom resumes.
 */
export function ConversationLog({
  messages,
  partial,
  className,
}: ConversationLogProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  useEffect(() => {
    if (!stickToBottom) return;
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, partial, stickToBottom]);

  function onScroll(): void {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance <= BOTTOM_THRESHOLD_PX;
    setStickToBottom(atBottom);
  }

  const empty = messages.length === 0 && !partial?.trim();

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Conversation</p>
        {!stickToBottom ? (
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => {
              setStickToBottom(true);
              const el = scrollerRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
          >
            Jump to latest
          </button>
        ) : null}
      </div>
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="max-h-72 min-h-40 overflow-y-auto rounded-md border bg-muted/20 p-3 text-sm"
      >
        {empty ? (
          <p className="text-muted-foreground">—</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {messages.map((m) => (
              <li key={m.id} className="space-y-0.5">
                <p className="text-xs font-medium text-muted-foreground">
                  {m.role === "user" ? "You" : "Hearsay"}
                </p>
                <p className="whitespace-pre-wrap break-words">
                  {m.text || (
                    <span className="text-muted-foreground italic">…</span>
                  )}
                </p>
              </li>
            ))}
            {partial?.trim() ? (
              <li className="space-y-0.5 opacity-70">
                <p className="text-xs font-medium text-muted-foreground">You</p>
                <p className="whitespace-pre-wrap break-words italic">
                  {partial.trim()}
                </p>
              </li>
            ) : null}
          </ul>
        )}
      </div>
    </div>
  );
}
