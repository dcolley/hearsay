const THREAD_KEY = "hearsay.presence.threadId";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function loadPresenceThreadId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const id = localStorage.getItem(THREAD_KEY)?.trim() ?? "";
    return UUID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function savePresenceThreadId(threadId: string): void {
  if (typeof window === "undefined") return;
  if (!UUID_RE.test(threadId)) return;
  try {
    localStorage.setItem(THREAD_KEY, threadId);
  } catch {
    // ignore quota / private mode
  }
}

export function clearPresenceThreadId(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(THREAD_KEY);
  } catch {
    // ignore
  }
}
