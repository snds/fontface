import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import { api, type FontSummary, type GoogleCatalog, type GoogleFamily, type GoogleInstallResult } from "@/api";
import { faceName, useFontFace } from "@/fontLoader";
import { isSampleKind, usePreviewProfile, useProfileWait } from "@/previewProfiles";
import { PreviewText } from "./PreviewText";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ChoiceGroup } from "./ChoiceGroup";
import { PageHeader } from "./TitleBar";

interface Props {
  /** Fonts in the Google Fonts folder, for previews of installed families. */
  fonts: FontSummary[];
  previewText: string;
  /** Families with a download or removal in progress (owned by the app, so it survives leaving this page). */
  busy: Set<string>;
  /** Changes after each download or removal; the catalog reloads. */
  version: number;
  /** "Update all" is running (owned by the app). */
  updatingAll: boolean;
  /** Downloads or updates a family. `unchanged` in the result: an update found nothing new. */
  onInstall: (id: string) => Promise<GoogleInstallResult>;
  onRemove: (id: string) => Promise<void>;
  onUpdateAll: (families: GoogleFamily[]) => Promise<void>;
}

const CATEGORIES: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "sans-serif", label: "Sans Serif" },
  { value: "serif", label: "Serif" },
  { value: "display", label: "Display" },
  { value: "handwriting", label: "Handwriting" },
  { value: "monospace", label: "Monospace" },
  { value: "icons", label: "Icons" },
];

type Show = "all" | "installed" | "updates";

const categoryLabel = (c: string) => CATEGORIES.find((x) => x.value === c)?.label ?? c;

/** What downloaded icon families preview with: home, search, settings, favorite and star. Every
 *  Material Icons and Material Symbols font has them at these code points (the live install
 *  test checks), so they draw without relying on ligatures (icon names typed as words). The
 *  profile alone isn't enough: Material Symbols also has plain letters, so it would draw its
 *  name. */
const ICON_PREVIEW = "\uE88A \uE8B6 \uE8B8 \uE87D \uE838";

/** Installed families preview in their own font (from the local files), fitted like the library
 *  list; icon families show a few of their icons. Others show their name. Like the list, a
 *  preview waits for its profile at most 300 ms, then draws the name. */
function FamilyPreview({ family, font, text }: { family: GoogleFamily; font: FontSummary | undefined; text: string }) {
  const state = useFontFace(font);
  const { profile, pending } = usePreviewProfile(font);
  const waited = useProfileWait(pending, font ? faceName(font) : "");
  // Not downloaded, or its preview can't load: show the name in the interface font.
  if (!font || state === "error" || state === "cloud" || state === "too-large") {
    return <div className="truncate text-lg font-medium">{family.family}</div>;
  }
  // Typed preview text wins, as everywhere; icon names typed as words draw as icons.
  const icons = !text && family.category === "icons";
  return (
    <PreviewText
      fontFamily={`"${faceName(font)}"`}
      face={faceName(font)}
      text={text || (icons ? ICON_PREVIEW : profile?.familyText || family.family)}
      size={22}
      ready={state === "ready" && (icons || !pending || waited)}
      profile={profile}
      ownText={!text && !icons && !!profile && font.family === family.family}
      sample={icons || (!text && isSampleKind(profile))}
    />
  );
}

export function GoogleFontsPanel({ fonts, previewText, busy, version, updatingAll, onInstall, onRemove, onUpdateAll }: Props) {
  const [catalog, setCatalog] = useState<GoogleCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [show, setShow] = useState<Show>("all");
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      setCatalog(await api.googleCatalog(refresh));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [version]);

  // A preview font per installed family: its most regular style.
  const previewFont = useMemo(() => {
    const map = new Map<string, FontSummary>();
    const score = (f: FontSummary) => (f.italic ? 1000 : 0) + Math.abs(f.weight - 400);
    for (const fam of catalog?.families ?? []) {
      if (!fam.installed) continue;
      const prefix = fam.installed.dir.endsWith("/") ? fam.installed.dir : `${fam.installed.dir}/`;
      const best = fonts.filter((f) => f.path.startsWith(prefix)).sort((a, b) => score(a) - score(b))[0];
      if (best) map.set(fam.id, best);
    }
    return map;
  }, [catalog, fonts]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (catalog?.families ?? []).filter(
      (f) =>
        (!q || f.family.toLowerCase().includes(q)) &&
        (!category || f.category === category) &&
        (show === "all" || (show === "installed" ? !!f.installed : f.updateAvailable)),
    );
  }, [catalog, query, category, show]);

  const installedCount = catalog?.families.filter((f) => f.installed).length ?? 0;
  const updates = catalog?.families.filter((f) => f.updateAvailable && !f.unavailable) ?? [];

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    getItemKey: (i) => visible[i].id,
    overscan: 8,
  });

  // New filters or search start at the top.
  useLayoutEffect(() => {
    virtualizer.scrollToOffset(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, category, show]);

  /** Runs an action on a family and shows the message it resolves with, or its error. */
  const run = async (fam: GoogleFamily, action: () => Promise<string>) => {
    try {
      toast.success(await action());
    } catch (e) {
      toast.error(fam.family, { description: e instanceof Error ? e.message : String(e) });
    } finally {
      // The row's button changes or disappears; keep keyboard focus in the list.
      if (scrollRef.current?.contains(document.activeElement) || document.activeElement === document.body) {
        scrollRef.current?.focus();
      }
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader icon="cloud" title="Google Fonts">
        <Button variant="outline" size="sm" onClick={() => load(true)} disabled={loading}>
          <Icon name="refresh" size={16} className={cn(loading && "animate-spin")} />
          Refresh
        </Button>
      </PageHeader>
      <div className="flex flex-col gap-3 border-b px-4 py-3">
        <p className="text-xs text-muted-foreground">
          Free, open-licensed fonts. Fontface downloads the full desktop files from Google's official repositories into a
          folder it manages, then turns them on.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-56">
            <Icon name="search" size={16} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search Google Fonts"
              aria-label="Search Google Fonts"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-8"
            />
          </div>
          <ChoiceGroup look="chips" label="Category" value={category} options={CATEGORIES} onChange={setCategory} />
          <span className="mx-1 h-5 w-px bg-border" />
          <ChoiceGroup
            look="chips"
            label="Show"
            value={show}
            onChange={setShow}
            options={[
              { value: "all", label: "Everything" },
              { value: "installed", label: `Downloaded · ${installedCount}` },
              { value: "updates", label: `Updates · ${updates.length}` },
            ]}
          />
          {updates.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => onUpdateAll(updates)} disabled={updatingAll}>
              {updatingAll ? "Updating…" : "Update all"}
            </Button>
          )}
        </div>
        {category === "icons" && (
          <p className="text-xs text-muted-foreground">
            Icon fonts draw an icon when you type its name, such as “home”, in apps that support ligatures (letters drawn
            as one shape).
          </p>
        )}
        {catalog?.stale && (
          <p className="text-xs text-muted-foreground">Couldn't reach the catalog, so this is the last saved copy.</p>
        )}
      </div>

      {error && !catalog ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <Icon name="cloud_off" size={36} weight={300} className="text-muted-foreground" />
          <p className="max-w-sm text-sm text-muted-foreground">Couldn't load the Google Fonts catalog. {error}</p>
          <Button onClick={() => load(true)}>Try again</Button>
        </div>
      ) : !catalog ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Icon name="progress_activity" size={18} className="animate-spin" />
          Loading the catalog…
        </div>
      ) : (
        <div
          ref={scrollRef}
          tabIndex={-1}
          className="min-h-0 flex-1 overflow-y-auto outline-none"
          role="list"
          aria-label="Google Fonts families"
        >
          <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const fam = visible[item.index];
              const isBusy = busy.has(fam.id);
              const italic = fam.styles.includes("italic");
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  role="listitem"
                  className="absolute top-0 left-0 flex w-full items-center gap-3 border-b px-4 py-2.5"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <div className="min-w-0 flex-1">
                    <FamilyPreview family={fam} font={previewFont.get(fam.id)} text={previewText} />
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      {fam.installed && <span className="text-foreground">{fam.family}</span>}
                      {fam.installed && <span>·</span>}
                      <span>{categoryLabel(fam.category)}</span>
                      <span>·</span>
                      <span>
                        {fam.weights.length} {fam.weights.length === 1 ? "weight" : "weights"}
                        {italic ? " + italics" : ""}
                      </span>
                      {fam.variable && <Badge variant="outline">Variable</Badge>}
                      <span className="font-mono text-[11px]">{fam.license}</span>
                    </div>
                  </div>
                  {isBusy ? (
                    <Button size="sm" variant="outline" disabled focusableWhenDisabled aria-label={`Working on ${fam.family}`}>
                      <Icon name="progress_activity" size={16} className="animate-spin" />
                      Working…
                    </Button>
                  ) : fam.unavailable ? (
                    <span className="text-xs text-muted-foreground" title={fam.unavailable}>
                      Not downloadable here<span className="sr-only">. {fam.unavailable}</span>
                    </span>
                  ) : fam.updateAvailable ? (
                    <Button
                      size="sm"
                      aria-label={`Update ${fam.family}`}
                      onClick={() =>
                        run(fam, async () =>
                          (await onInstall(fam.id)).unchanged ? `${fam.family} is already up to date` : `${fam.family} updated`,
                        )
                      }
                    >
                      <Icon name="update" size={16} />
                      Update
                    </Button>
                  ) : fam.installed ? (
                    <div className="flex items-center gap-1">
                      <Badge variant="secondary" className="gap-1">
                        <Icon name="check" size={12} />
                        Downloaded
                      </Badge>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Remove ${fam.family}`}
                        title="Remove (turns it off and deletes the downloaded files)"
                        onClick={() => run(fam, () => onRemove(fam.id).then(() => `${fam.family} removed`))}
                      >
                        <Icon name="delete" size={16} />
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Get ${fam.family}`}
                      onClick={() => run(fam, () => onInstall(fam.id).then(() => `${fam.family} downloaded and turned on`))}
                    >
                      <Icon name="download" size={16} />
                      Get
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
          {visible.length === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground">No families match these filters.</div>
          )}
        </div>
      )}
      <footer className="border-t px-4 py-1.5 text-[11px] text-muted-foreground">
        Catalog by Fontsource · files from github.com/google/fonts and github.com/google/material-design-icons ·{" "}
        {catalog ? `${catalog.families.length.toLocaleString()} families` : ""}
      </footer>
    </div>
  );
}
