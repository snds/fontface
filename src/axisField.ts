import { variationSettings } from "./previewStyle.ts";

/**
 * The Axes tab's number field, one per variable axis: what typing, Return, leaving the field
 * and Esc do; named styles; and optical size, which follows the text size unless it's set by
 * hand. Pure (no React, no DOM), so `npm run test:ui` covers it; AxesTab.tsx holds the draft in
 * React state.
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

/** The named style the axes are at now (unset axes are at their defaults), or -1 for none.
 *  Optical size that follows the text size isn't at any one place, so then only the other axes
 *  count. */
export function currentInstance(instances: readonly Instance[], axes: readonly AxisInfo[], values: Readonly<Record<string, number>>): number {
  const counted = followsSize(axes, values) ? axes.filter((a) => a.tag !== OPSZ) : axes;
  return instances.findIndex((instance) => {
    const wanted = instanceValues(instance, counted);
    return counted.every((a) => same(values[a.tag] ?? a.default, wanted[a.tag], a));
  });
}

/** Whether the font's named styles sit at different optical sizes (its maker named sizes, such
 *  as Caption and Display). Only then does picking one set the optical size. */
export function namesOpticalSizes(instances: readonly Instance[], axes: readonly AxisInfo[]): boolean {
  const axis = axes.find((a) => a.tag === OPSZ);
  if (!axis || !instances.length) return false;
  const at = instances.map((instance) => instanceValues(instance, [axis])[OPSZ]);
  return at.some((v) => !same(v, at[0], axis));
}

/**
 * The axis values after picking a named style: every axis where the style has it, except
 * optical size, which stays as it was (following the text size, or as set by hand) unless the
 * font's named styles are at different optical sizes. Fonts usually put every named style at the
 * same optical size, and following the text size draws each preview better than that one does.
 */
export function pickNamedStyle(
  instance: Instance,
  instances: readonly Instance[],
  axes: readonly AxisInfo[],
  values: Readonly<Record<string, number>>,
): Record<string, number> {
  const out = instanceValues(instance, axes);
  if (!(OPSZ in out) || namesOpticalSizes(instances, axes)) return out;
  delete out[OPSZ];
  if (OPSZ in values) out[OPSZ] = values[OPSZ];
  return out;
}

// ------------------------------------------------------------------------- optical size

/**
 * Optical size (the `opsz` axis) follows the text size unless it's set by hand: each preview
 * uses its own size, kept within the axis's range, so 12 px text gets the shapes the font's
 * maker drew for small text and 96 px text the ones for display. Sizes are CSS pixels, which
 * macOS draws as points, so this is what a Mac app does at that point size, and what the web
 * view does by itself (`font-optical-sizing: auto`) for previews that set no axes, such as the
 * library's. Set by hand means the page's axis values have an `opsz` (the Axes tab's switch, or
 * a named style at its own optical size).
 */
export const OPSZ = "opsz";

/** The optical size for text at `sizePx`: the size, kept within the axis's range. */
export const opticalSize = (axis: AxisRange, sizePx: number) => Math.round(clampAxis(sizePx, axis) * 100) / 100;

/** Whether optical size follows the text size: the style has the axis, and it isn't set by hand. */
export const followsSize = (axes: readonly { tag: string }[], values: Readonly<Record<string, number>>) =>
  !(OPSZ in values) && axes.some((a) => a.tag === OPSZ);

/** The axis values a preview at `sizePx` draws with: the ones set on the page, plus optical size
 *  at the text size while it follows. */
export function axisValuesAt(axes: readonly AxisInfo[], values: Readonly<Record<string, number>>, sizePx: number): Readonly<Record<string, number>> {
  const axis = axes.find((a) => a.tag === OPSZ);
  if (!axis || OPSZ in values || !(sizePx > 0)) return values;
  return { ...values, [OPSZ]: opticalSize(axis, sizePx) };
}

/** `font-variation-settings` for a preview at a size in px (undefined: none, the defaults). */
export type VariationAt = (sizePx: number) => string | undefined;

/** The font page's `font-variation-settings` for each preview size: the axes set on the page,
 *  and optical size at that size while it follows. */
export function variationAt(axes: readonly AxisInfo[], values: Readonly<Record<string, number>>): VariationAt {
  if (!followsSize(axes, values)) {
    const fixed = variationSettings(values);
    return () => fixed;
  }
  return (sizePx) => variationSettings(axisValuesAt(axes, values, sizePx));
}
