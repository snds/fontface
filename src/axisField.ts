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

// ------------------------------------------------------------------------- named styles

/** An axis with its tag and default, as the Axes tab lists it. */
export interface AxisInfo extends AxisRange {
  tag: string;
  default: number;
}

/** A variable font's named style: its name and where it sits on each axis ([tag, value]). */
export interface Instance {
  name: string;
  values: readonly (readonly [string, number])[];
}

/** The axis values a named style sets: each of the given axes, kept within its range (an axis
 *  the style doesn't mention goes to its default). */
export function instanceValues(instance: Instance, axes: readonly AxisInfo[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of axes) {
    const v = instance.values.find(([tag]) => tag === a.tag)?.[1];
    out[a.tag] = clampAxis(v ?? a.default, a);
  }
  return out;
}

/** Close enough to count as the same place on an axis. */
const same = (a: number, b: number, axis: AxisRange) => Math.abs(a - b) <= 1e-3 + (axis.max - axis.min) * 1e-4;

/** The named style the axes are at now (unset axes are at their defaults), or -1 for none. */
export function currentInstance(instances: readonly Instance[], axes: readonly AxisInfo[], values: Readonly<Record<string, number>>): number {
  return instances.findIndex((instance) => {
    const wanted = instanceValues(instance, axes);
    return axes.every((a) => same(values[a.tag] ?? a.default, wanted[a.tag], a));
  });
}
