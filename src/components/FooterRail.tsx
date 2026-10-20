import { cn } from "@/lib/utils";

/**
 * The slim line at the bottom of every list view (the library's places, the sources, tags, the
 * Google Fonts and Adobe Fonts views): the counts in full words with every digit
 * (footerCounts.ts), then any short note, then where the list comes from at the right. One line,
 * always the same height, so nothing above it moves when what it says changes.
 */
export function FooterRail({ count, note, source, className }: { count: string; note?: React.ReactNode; source?: React.ReactNode; className?: string }) {
  return (
    <footer className={cn("@container/footer flex h-7 shrink-0 items-center gap-3 border-t px-4 text-[11px] whitespace-nowrap text-muted-foreground select-none", className)}>
      <span className="shrink-0 tabular-nums">{count}</span>
      <span className="min-w-0 flex-1 truncate">{note}</span>
      {source && <span className="shrink-0 @max-[560px]/footer:hidden">{source}</span>}
    </footer>
  );
}

/**
 * A list view's body: the list, the preview bar (PreviewBar.tsx) floating over its bottom, and
 * the footer rail under both. The bar comes after the list, so Tab reaches it after the list.
 */
export function ListFrame({
  children,
  bar,
  count,
  note,
  source,
}: {
  children: React.ReactNode;
  /** The preview bar, while there's a list for it to change. */
  bar?: React.ReactNode;
  count: string;
  note?: React.ReactNode;
  source?: React.ReactNode;
}) {
  return (
    <>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {children}
        {bar}
      </div>
      <FooterRail count={count} note={note} source={source} />
    </>
  );
}
