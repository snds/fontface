/**
 * The Axes tab's number field, one per variable axis: what typing, Return, leaving the field
 * and Esc do. Pure (no React, no DOM), so `npm run test:ui` covers it; AxesTab.tsx holds the
 * draft in React state.
 *
 * - A value in range applies as it's typed, so the previews follow along.
 * - Return or leaving the field applies what was typed, kept within the axis's range. Text that
 *   isn't a number (an empty field, say) goes back to the value from before typing.
 * - Esc throws away what was typed and goes back to the value from before typing, including
 *   any value applied along the way.
 */

export interface AxisRange {
  min: number;
  max: number;
}

/** Typing in progress: the text so far, and the axis's value from before typing started. */
export interface AxisDraft {
  text: string;
  before: number;
}

export const clampAxis = (v: number, a: AxisRange) => Math.min(a.max, Math.max(a.min, v));

/** The number typed, or null if the text isn't one. */
function parse(text: string): number | null {
  const n = Number(text);
  return text.trim() !== "" && Number.isFinite(n) ? n : null;
}

/**
 * A change in the field. `value` is the axis's current value, kept as the value to go back to
 * when this starts a new draft. `apply` is the value to show now, if the text is one in range.
 */
export function typeAxis(draft: AxisDraft | null, text: string, value: number, axis: AxisRange): { draft: AxisDraft; apply?: number } {
  const next = { text, before: draft ? draft.before : value };
  const n = parse(text);
  return n !== null && n >= axis.min && n <= axis.max ? { draft: next, apply: n } : { draft: next };
}

/** Return, or leaving the field: the value to apply (nothing if nothing was typed). */
export function commitAxis(draft: AxisDraft | null, axis: AxisRange): number | undefined {
  if (!draft) return undefined;
  const n = parse(draft.text);
  return n === null ? draft.before : clampAxis(n, axis);
}

/** Esc: the value to go back to (nothing if nothing was typed). */
export function discardAxis(draft: AxisDraft | null): number | undefined {
  return draft ? draft.before : undefined;
}
