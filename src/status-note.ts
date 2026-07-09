/**
 * status-note.ts — Parenthetical status note appended to agent result text.
 */

/**
 * Explicit parenthetical note for a non-normal terminal outcome, so the parent
 * agent can't mistake partial output for a completed result. Empty string for a
 * clean completion (and any unknown/non-terminal status).
 *
 * `stopped` (a human aborted it) is deliberately distinct from `aborted`
 * (the local turn limit or upstream assistant request was aborted) — the parent
 * should treat human intervention differently from an incomplete agent turn.
 */
export function getStatusNote(status: string, diagnostic?: string): string {
  switch (status) {
    case "stopped":
      return " (STOPPED BY THE USER before completion — output is partial; the task was NOT finished)";
    case "aborted":
      if (diagnostic?.trim()) return ` (aborted — ${diagnostic.trim()}; output may be incomplete)`;
      return " (aborted — hit the turn limit before completion; output may be incomplete)";
    case "steered":
      return " (wrapped up at the turn limit — output may be partial)";
    default:
      return "";
  }
}
