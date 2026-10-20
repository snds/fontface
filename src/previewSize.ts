import { SIZE_STEPS } from "./viewOptions.ts";

/**
 * The preview bar's size field (components/PreviewBar.tsx): a select of common sizes, and
 * "Custom…", which turns the same field into a number field with up and down steppers. Pure (no
 * React, no DOM), so `npm run test:ui` covers it; the field keeps its draft in React state.
 *
 * - The select lists the sizes Cmd+= and Cmd+- step through, and the size now when it's another
 *   one (a custom size, or the default from Settings), so it always shows what's in use.
 * - In the number field, Up and Down change the size by 1 (with Shift, by 10), Page Up and Page
 *   Down by 10, Home and End go to the smallest and largest. Each step applies at once.
 * - A size in range applies as it's typed, so the previews follow along.
 * - Return or leaving the field applies what was typed, kept within the range. Text that isn't
 *   a number (an empty field, say) goes back to the size from before typing.
 * - Esc throws away what was typed and goes back to the size from before the field opened,
 *   including any size applied along the way.
 */

/** The smallest and largest preview size. Must match PREVIEW_SIZE in src-tauri/src/settings.rs. */
export const MIN_SIZE = 10;
export const MAX_SIZE = 128;

/** A whole size within the range. */
export const clampSize = (n: number) => Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(n)));

/** The sizes the select lists, smallest first: the common ones, and `size` if it's another. */
export function sizeOptions(size: number): number[] {
  const out: number[] = [...SIZE_STEPS];
  if (!out.includes(size)) out.push(size);
  return out.sort((a, b) => a - b);
}

/** "32 px": how the field and its list show a size. */
export const sizeLabel = (size: number) => `${size} px`;

/** The parts of a key press the number field looks at. */
export interface FieldKey {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

/** A key in the number field: the size it sets from `size`, or null for keys it leaves to the
 *  field (typing, moving the caret, Cmd+= and Cmd+-, which step through the common sizes). */
export function keyStep(size: number, e: FieldKey): number | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  switch (e.key) {
    case "ArrowUp":
      return clampSize(size + (e.shiftKey ? 10 : 1));
    case "ArrowDown":
      return clampSize(size - (e.shiftKey ? 10 : 1));
    case "PageUp":
      return clampSize(size + 10);
    case "PageDown":
      return clampSize(size - 10);
    case "Home":
      return MIN_SIZE;
    case "End":
      return MAX_SIZE;
    default:
      return null;
  }
}

/** A stepper button: one up or down from `size`. */
export const buttonStep = (size: number, direction: 1 | -1) => clampSize(size + direction);

/** The number field while it's open: the text in it, and the size from before it opened. */
export interface SizeDraft {
  text: string;
  before: number;
}

/** The field opens on the size in use. */
export const openDraft = (size: number): SizeDraft => ({ text: String(size), before: size });

/** The number typed, or null if the text isn't one. */
function parse(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d*)?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** Typing: the new draft, and the size to apply now if the text is a whole size in range. */
export function typeSize(draft: SizeDraft, text: string): { draft: SizeDraft; apply?: number } {
  const next = { ...draft, text };
  const n = parse(text);
  return n !== null && Number.isInteger(n) && n >= MIN_SIZE && n <= MAX_SIZE ? { draft: next, apply: n } : { draft: next };
}

/** The size the steppers and arrow keys start from: what's typed (kept within the range), or the
 *  size from before if it isn't a number. */
export function draftSize(draft: SizeDraft): number {
  const n = parse(draft.text);
  return n === null ? draft.before : clampSize(n);
}

/** Return, or leaving the field: the size to keep. */
export const commitSize = (draft: SizeDraft): number => draftSize(draft);

/** Esc: the size to go back to. */
export const discardSize = (draft: SizeDraft): number => draft.before;
