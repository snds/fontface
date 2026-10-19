import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import { api, type FontSummary, type GoogleCatalog, type GoogleFamily, type GoogleInstallResult, type PreviewInfo } from "@/api";
import { faceName, remoteFace, useFontFace, useRemoteFace, type FaceState } from "@/fontLoader";
import {
  failNote,
  fileStatus,
  matchLibrary,
  onlineChoice,
  outsideAlphabet,
  rowSource,
  wantsAlphabet,
  type LibraryMatch,
} from "@/googlePreviews";
import { refreshGooglePreviews, retryGooglePreview, useGoogleOffline, useGooglePreview, type PreviewRequest } from "@/googlePreviewStore";
import { ROW_HEIGHT } from "@/previewFit";
import { isSampleKind, usePreviewProfile, useProfileWait } from "@/previewProfiles";
import { applyCase } from "@/previewStyle";
import { MissingHint, SampleBadge } from "./FacePreview";
import { usePreviewStyle } from "./PreviewStyle";
import { PreviewText } from "./PreviewText";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ChoiceGroup } from "./ChoiceGroup";
import { IS_MAC, PageHeader, type PageBack } from "./TitleBar";

interface Props {
  /** The whole library: a family that's downloaded, or already in your library elsewhere,
   *  previews from those files. */
  fonts: FontSummary[];
  previewText: string;
  /** Settings › General › "Show previews of Google Fonts you haven't downloaded". */
  onlinePreviews: boolean;
  /** Opens Settings at that switch (the page's note links to it). */
  onOpenSettings?: () => void;
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
  /** Opened with Browse from the Google Fonts list: Back and the page's heading. */
  back?: PageBack;
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

/** What icon families in the library preview with (online previews of them ask Google for the
 *  same code points): home, search, settings, favorite and star. Every
 *  Material Icons and Material Symbols font has them at these code points (the live install
 *  test checks), so they draw without relying on ligatures (icon names typed as words). The
 *  profile alone isn't enough: Material Symbols also has plain letters, so it would draw its
 *  name. */
const ICON_PREVIEW = "\uE88A \uE8B6 \uE8B8 \uE87D \uE838";

/** Preview text size in px. */
const PREVIEW_SIZE = 22;
/** Every preview, whatever draws it, is this tall (a list row's preview box), so a row never
 *  changes height when its font arrives. */
const PREVIEW_HEIGHT = ROW_HEIGHT * PREVIEW_SIZE;
/** How long an online preview stays hidden while it loads; after that the name shows meanwhile. */
const ONLINE_WAIT_MS = 1000;
/** A local font in one of these states can't be previewed (online-only, too large, broken). */
const LOCAL_FAILED = new Set<FaceState>(["error", "cloud", "too-large"]);

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;
const COMPUTER = IS_MAC ? "Mac" : "computer";

/** What a row's preview shows: the name in the interface font, or text in a page font. */
type Shown =
  | { kind: "plain"; note?: string; hidden?: boolean }
  | { kind: "font"; face: string; text: string; ready: boolean; profile?: PreviewInfo; ownText: boolean; typed: boolean; sample: boolean };

/** A ready online file whose font wouldn't load (the cache may have let it go): ask once more. */
function useRetry(request: PreviewRequest | undefined, path: string | undefined, state: FaceState) {
  useEffect(() => {
    if (request && path && state === "error") retryGooglePreview(request);
    // The path names the request's file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, state]);
}

/** The name in the interface font, the same height as a preview. `note`: why it isn't in its own
 *  font, on hover and for screen readers. `hidden`: kept invisible while a preview loads. */
function PlainName({ family, note, hidden }: { family: GoogleFamily; note?: string; hidden?: boolean }) {
  return (
    <div
      className={cn("truncate text-lg font-medium transition-opacity", hidden && "preview-loading")}
      style={{ height: PREVIEW_HEIGHT, lineHeight: `${PREVIEW_HEIGHT}px` }}
      title={note}
    >
      {family.family}
      {note && <span className="sr-only">. {note}</span>}
    </div>
  );
}

/** "Your copy": the preview is drawn from a copy of the family elsewhere in your library. */
function YourCopy({ font }: { font: FontSummary }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="shrink-0" />}>
        <Badge variant="outline" className="text-muted-foreground">
          Your copy
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        This preview uses the copy already in your library ({fileName(font.path)}). It may be a different version from
        Google's.
      </TooltipContent>
    </Tooltip>
  );
}

/** Typed characters an online preview can't show: its file holds only a fixed set of letters,
 *  so what you type never leaves your Mac. The family itself may well have them. */
function AlphabetHint({ text }: { text: string }) {
  const { options } = usePreviewStyle();
  // The text as previews draw it: in the View options' case.
  const outside = outsideAlphabet(applyCase(text, options.case));
  if (!outside.length) return null;
  const list = outside.join(" ");
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0 items-center text-muted-foreground" />}>
        <Icon name="privacy_tip" size={14} />
        <span className="sr-only">Can't preview here: {list}.</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        Can't preview {list} here. Online previews only hold basic Latin letters, so the text you type never leaves your{" "}
        {COMPUTER}. Download the family to see everything it has.
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A catalog row's preview and the line of facts under it. The preview comes from, in order:
 * the downloaded files; a copy of the family already in your library ("Your copy"); an online
 * preview file (when they're on, googlePreviews.ts); or the name in the interface font. Icon
 * families show a few of their icons. Like the library list, a local font waits for its
 * profile at most 300 ms, then draws the name.
 */
function FamilyInfo({
  family,
  match,
  text,
  online,
}: {
  family: GoogleFamily;
  match: LibraryMatch<FontSummary> | undefined;
  text: string;
  online: boolean;
}) {
  const icons = family.category === "icons";
  const font = match?.font;
  const localState = useFontFace(font);
  const { profile: localProfile, pending } = usePreviewProfile(font);
  const waited = useProfileWait(pending, font ? faceName(font) : "");
  const source = rowSource({ match, localFailed: !!font && LOCAL_FAILED.has(localState), online });

  // Online: the row's own file, and the alphabet file for typed text (icon families keep their icons).
  const rowRequest: PreviewRequest | undefined = source === "online" ? { id: family.id, token: family.lastModified, kind: "row" } : undefined;
  const alphabetRequest: PreviewRequest | undefined =
    source === "online" && wantsAlphabet(text, icons) ? { id: family.id, token: family.lastModified, kind: "alphabet" } : undefined;
  const row = useGooglePreview(rowRequest);
  const alphabet = useGooglePreview(alphabetRequest);
  const rowPath = rowRequest && row.answer?.state === "ready" ? row.answer.path : undefined;
  const alphabetPath = alphabetRequest && alphabet.answer?.state === "ready" ? alphabet.answer.path : undefined;
  const rowFace = useRemoteFace(rowPath, row.generation);
  const alphabetFace = useRemoteFace(alphabetPath, alphabet.generation);
  useRetry(rowRequest, rowPath, rowFace);
  useRetry(alphabetRequest, alphabetPath, alphabetFace);
  const choice = onlineChoice(
    fileStatus(rowRequest && row.answer, rowFace),
    alphabetRequest ? fileStatus(alphabet.answer, alphabetFace) : undefined,
  );
  const onlineWaited = useProfileWait(source === "online" && choice.draw === "loading", family.id, ONLINE_WAIT_MS);

  let shown: Shown;
  if ((source === "download" || source === "library") && font) {
    // Typed preview text wins, as everywhere; icon names typed as words draw as icons.
    shown = {
      kind: "font",
      face: faceName(font),
      text: text || (icons ? ICON_PREVIEW : localProfile?.familyText || family.family),
      ready: localState === "ready" && (icons || !pending || waited),
      profile: localProfile,
      ownText: !text && !icons && !!localProfile && font.family === family.family,
      typed: !!text,
      sample: icons || (!text && isSampleKind(localProfile)),
    };
  } else if (source === "online" && choice.draw === "alphabet" && alphabetPath) {
    shown = { kind: "font", face: remoteFace(alphabetPath)!, text, ready: true, profile: alphabet.answer?.profile, ownText: false, typed: true, sample: false };
  } else if (source === "online" && rowPath && (choice.draw === "row" || (choice.draw === "loading" && !onlineWaited))) {
    // The row's own file: the name, the icons or a sample of its script. While its font loads
    // it's hidden (and fades in), so nothing draws in the fallback font.
    const profile = row.answer?.profile;
    const drawn = row.answer?.text || family.family;
    shown = {
      kind: "font",
      face: remoteFace(rowPath)!,
      text: drawn,
      ready: choice.draw === "row",
      profile,
      ownText: !icons && !!profile && drawn === (profile.familyText ?? family.family),
      typed: false,
      sample: icons || (row.answer?.sample ?? isSampleKind(profile)),
    };
  } else if (source === "online" && choice.draw === "plain") {
    shown = { kind: "plain", note: failNote(choice.why) };
  } else if (source === "online") {
    // Waiting for an answer: hidden for a moment, then the name until the preview comes.
    shown = { kind: "plain", hidden: !onlineWaited };
  } else {
    shown = { kind: "plain" };
  }

  // Drawn in a page font (the family's own, or its icons or script): its name in plain letters
  // goes on the line below too.
  const f = shown.kind === "font" ? shown : null;
  return (
    <div className="min-w-0 flex-1">
      {f ? (
        <PreviewText
          fontFamily={`"${f.face}"`}
          face={f.face}
          text={f.text}
          size={PREVIEW_SIZE}
          ready={f.ready}
          profile={f.profile}
          ownText={f.ownText}
          typed={f.typed}
          sample={f.sample}
        />
      ) : (
        <PlainName family={family} note={shown.kind === "plain" ? shown.note : undefined} hidden={shown.kind === "plain" && shown.hidden} />
      )}
      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        {f && (
          // Screen readers already hear the name from the preview when it draws the name.
          <span className="text-foreground" aria-hidden={(!f.sample && !f.typed) || undefined}>
            {family.family}
          </span>
        )}
        {f && source === "library" && font && <YourCopy font={font} />}
        {f && f.sample && !icons && <SampleBadge profile={f.profile} row="family" />}
        {f?.typed && <MissingHint text={f.text} profile={f.profile} />}
        {f?.typed && source === "online" && <AlphabetHint text={f.text} />}
        {f && <span>·</span>}
        <span>{categoryLabel(family.category)}</span>
        <span>·</span>
        <span>
          {family.weights.length} {family.weights.length === 1 ? "weight" : "weights"}
          {family.styles.includes("italic") ? " + italics" : ""}
        </span>
        {family.variable && <Badge variant="outline">Variable</Badge>}
        <span className="font-mono text-[11px]">{family.license}</span>
      </div>
    </div>
  );
}

/** The catalog's search field: Cmd+F comes here while the catalog is open (see nav.findIntent). */
export const GOOGLE_SEARCH_ID = "google-fonts-search";

export function GoogleFontsPanel({
  fonts,
  previewText,
  onlinePreviews,
  onOpenSettings,
  busy,
  version,
  updatingAll,
  onInstall,
  onRemove,
  onUpdateAll,
  back,
}: Props) {
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

  // A preview font per family that's downloaded, or already in the library elsewhere: its most
  // regular style. No network.
  const matches = useMemo(() => matchLibrary(catalog?.families ?? [], fonts), [catalog, fonts]);

  // Switching online previews on or off asks again for every row that had no file.
  useEffect(() => refreshGooglePreviews(), [onlinePreviews]);
  const offline = useGoogleOffline() && onlinePreviews;

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
      <PageHeader icon="cloud" title="Google Fonts" back={back}>
        <Button variant="outline" size="sm" onClick={() => load(true)} disabled={loading}>
          <Icon name="refresh" size={16} className={cn(loading && "animate-spin")} />
          Refresh
        </Button>
      </PageHeader>
      <div className="flex flex-col gap-3 border-b px-4 py-3">
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">
            Free, open-licensed fonts. Fontface downloads the full desktop files from Google's official repositories into a
            folder it manages, then turns them on.
          </p>
          <p className="text-xs text-muted-foreground">
            {onlinePreviews
              ? "Previews of families you haven't downloaded come from Google. You can turn them off in "
              : "Previews of families you haven't downloaded are off. You can turn them on in "}
            {onOpenSettings ? (
              <button
                type="button"
                className="rounded-sm underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                onClick={onOpenSettings}
              >
                Settings
              </button>
            ) : (
              "Settings"
            )}
            .
            {offline && " Google couldn't be reached just now, so some families show their names; Fontface tries again in a few minutes."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-56">
            <Icon name="search" size={16} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              id={GOOGLE_SEARCH_ID}
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
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  role="listitem"
                  className="absolute top-0 left-0 flex w-full items-center gap-3 border-b px-4 py-2.5"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <FamilyInfo family={fam} match={matches.get(fam.id)} text={previewText} online={onlinePreviews} />
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
