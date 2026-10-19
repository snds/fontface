/**
 * Which queued font file loads next (fontLoader.ts): the newest request first, since rows on
 * screen now beat rows scrolled past, except that a face marked urgent (a font page's chosen
 * style) goes before all of them, so the page's waterfall never waits behind its "All styles"
 * list. Pure (no DOM, no Tauri), so `npm run test:ui` covers it.
 *
 * Returns the index in `queue` (oldest first) to take, or -1 when it's empty.
 */
export function nextLoad(queue: readonly { name: string }[], urgent: { has(name: string): boolean; readonly size: number }): number {
  // Nothing urgent (the library list): no need to walk the queue. Clearing out thousands of
  // loads for rows scrolled away stays linear.
  if (urgent.size === 0) return queue.length - 1;
  for (let i = queue.length - 1; i >= 0; i--) if (urgent.has(queue[i].name)) return i;
  return queue.length - 1;
}
