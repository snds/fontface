import { useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import type { ActivationMode, FontSummary, GoogleFamily, GoogleInstallResult, PreviewInfo, PreviewOptions } from "@/api";
import { faceName, remoteFace, useFontFace, useRemoteFace, type FaceState } from "@/fontLoader";
import { LIBRARY_LIST_ATTR } from "@/focusReturn";
import type { FontTarget } from "@/fontActions";
import { summarize } from "@/fontState";
import { catalogItems } from "@/catalogOrder";
import {
  CATEGORIES,
  categoryLabel,
  hasUpdate,
  noMatchText,
  openFace,
  removalWords,
  rowLabel,
  rowPlan,
  switchFaces,
  switchIds,
  yoursFirstTip,
  type Holding,
  type RowPlan,
} from "@/googleCatalog";
import {
  describesRowFile,
  failNote,
  fileStatus,
  KEEPS_TRYING,
  matchLibrary,
  onlineChoice,
  outsideAlphabet,
  rowSource,
  wantsAlphabet,
  yourCopyNote,
  type LibraryMatch,
} from "@/googlePreviews";
import {
  listenForPreviewSetting,
  refreshGooglePreviews,
  retryGooglePreview,
  useGoogleOffline,
  useGooglePreview,
  type PreviewRequest,
} from "@/googlePreviewStore";
import type { Family } from "@/library";
import { ROW_HEIGHT } from "@/previewFit";
import { isSampleKind, usePreviewProfile, useProfileWait } from "@/previewProfiles";
import { applyCase } from "@/previewStyle";
import { listKeyCommand } from "@/selection";
import { isMenuKey, openMenuFromKeyboard } from "@/tags/menus";
import { useTagIndex } from "@/tags/model";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { StateControl } from "./ActivationSwitch";
import { ChoiceGroup } from "./ChoiceGroup";
import { MissingHint, SampleBadge } from "./FacePreview";
import { FontActionItems } from "./FontActions";
import type { GoogleView } from "./google/useGoogleView";
import { Tip } from "./Tip";
import { activeInSight, ROW_CONTROLS, type ListHandle, type OpenRequest } from "./library/LibraryPane";
import { useSelection } from "./library/useSelection";
import { PreviewOptionsSection } from "./PreviewOptions";
import { usePreviewStyle } from "./PreviewStyle";
import { PreviewText } from "./PreviewText";
import { IS_MAC } from "./TitleBar";

/*
 * The Google Fonts source's own view: the whole catalog, as the place to get Google Fonts and
 * manage them (docs/ARCHITECTURE.md, Front end). The sidebar's Google Fonts row opens it, under
 * the main toolbar, whose search, preview text, size and Variable work on it, and whose filter
 * is All / Downloaded / Active / Updates (googleCatalog.ts). Under the toolbar a slim bar has
 * the categories, "Yours first", Update all and Refresh; at the bottom, one quiet line says
 * where previews come from.
 *
 * Each family's row: its preview and facts, then what fits it (googleCatalog.rowPlan): Get;
 * for a family you have (downloaded here, or your own copy) the on/off switch, as in the
 * library (Option-click, busy marks, every state's mark); Update when there's a newer version;
 * Remove for a download (asks first, then offers Undo). Double-click or Return opens the font
 * page of a family you have, and right-click (or Shift-F10) its font menu.
 *
 * Like the library list, it's a listbox: the list keeps focus and points at the active row with
 * aria-activedescendant, arrow keys, Home/End and Page Up/Down move, and only the active row's
 * own buttons and switch are in the Tab order. One row is selected at a time.
 */

/** How tall a group's heading is in the list ("Yours first"). */
const HEADING_HEIGHT = 32;

/** What icon families in the library preview with (online previews of them ask Google for the
 *  same code points): home, search, settings, favorite and star. Every Material Icons and
 *  Material Symbols font has them at these code points (the live install test checks), so they
 *  draw without relying on ligatures (icon names typed as words). The profile alone isn't
 *  enough: Material Symbols also has plain letters, so it would draw its name. */
const ICON_PREVIEW = "    ";

/** How long an online preview stays hidden while it loads; after that the name shows meanwhile. */
const ONLINE_WAIT_MS = 1000;
/** A local font in one of these states can't be previewed (online-only, too large, broken). */
const LOCAL_FAILED = new Set<FaceState>(["error", "cloud", "too-large"]);

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;
const COMPUTER = IS_MAC ? "Mac" : "computer";
/** A family's row key: its catalog id, so the selection and Back find it whatever the order. */
const rowKeyOf = (id: string) => `g:${id}`;

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
function PlainName({ family, height, note, hidden }: { family: GoogleFamily; height: number; note?: string; hidden?: boolean }) {
  const name = (
    <div className={cn("truncate text-lg font-medium transition-opacity", hidden && "preview-loading")} style={{ height, lineHeight: `${height}px` }}>
      {family.family}
      {note && <span className="sr-only">. {note}</span>}
    </div>
  );
  return note ? (
    <Tip tip={note} describe={false} align="start" contentClassName="max-w-xs">
      {name}
    </Tip>
  ) : (
    name
  );
}

/** "Your copy": the preview is drawn from a copy of the family elsewhere in your library. The
 *  explanation is on hover, and in words for screen readers (the trigger can't take focus). */
function YourCopy({ font }: { font: FontSummary }) {
  const note = yourCopyNote(fileName(font.path));
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="shrink-0" />}>
        <Badge variant="outline" className="text-muted-foreground">
          Your copy
        </Badge>
        <span className="sr-only">. {note}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{note}</TooltipContent>
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
 * profile at most 300 ms, then draws the name. Every preview is `size` tall whatever draws it,
 * so a row never changes height when its font arrives.
 */
function FamilyInfo({
  family,
  match,
  text,
  online,
  size,
  downloaded,
  factsId,
}: {
  family: GoogleFamily;
  match: LibraryMatch<FontSummary> | undefined;
  text: string;
  online: boolean;
  size: number;
  downloaded: boolean;
  /** The facts line's id: the row's description for screen readers. */
  factsId: string;
}) {
  const icons = family.category === "icons";
  const height = ROW_HEIGHT * size;
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
  const rowStatus = fileStatus(rowRequest && row.answer, rowFace);
  const choice = onlineChoice(rowStatus, alphabetRequest ? fileStatus(alphabet.answer, alphabetFace) : undefined);
  const onlineWaited = useProfileWait(source === "online" && choice.draw === "loading", family.id, ONLINE_WAIT_MS);
  // The row's own file, drawn in its page font: the name, the icons or a sample of its script.
  const rowProfile = row.answer?.profile;
  const rowText = row.answer?.text || family.family;
  const rowShown: Shown | undefined =
    source === "online" && rowPath
      ? {
          kind: "font",
          face: remoteFace(rowPath)!,
          text: rowText,
          ready: choice.draw === "row",
          profile: rowProfile,
          ownText: !icons && !!rowProfile && rowText === (rowProfile.familyText ?? family.family),
          typed: false,
          sample: icons || (row.answer?.sample ?? isSampleKind(rowProfile)),
        }
      : undefined;

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
  } else if (rowShown && (choice.draw === "row" || (choice.draw === "loading" && !onlineWaited))) {
    // While its font loads it's hidden (and fades in), so nothing draws in the fallback font.
    shown = rowShown;
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
  // The line below describes the file the row settles on, also while its font is still loading
  // (the preview shows the name meanwhile), so it doesn't change as the font arrives.
  const facts = f ?? (rowShown && describesRowFile(rowStatus) ? rowShown : null);
  return (
    <div className="min-w-0 flex-1">
      {f ? (
        <PreviewText
          fontFamily={`"${f.face}"`}
          face={f.face}
          text={f.text}
          size={size}
          ready={f.ready}
          profile={f.profile}
          ownText={f.ownText}
          typed={f.typed}
          sample={f.sample}
        />
      ) : (
        <PlainName family={family} height={height} note={shown.kind === "plain" ? shown.note : undefined} hidden={shown.kind === "plain" && shown.hidden} />
      )}
      {/* One line, always as tall as a badge: what it holds can change (a badge arrives with a
          preview), its height can't, so the row never moves the rows below it. */}
      <div id={factsId} className="mt-0.5 flex h-5 min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden text-xs whitespace-nowrap text-muted-foreground">
        {facts && (
          // Screen readers already hear the name from the row's name. While the font loads, the
          // preview shows the name itself: this one only keeps its place (invisible, so nothing
          // below moves when the font arrives), and so does the badge, which would describe
          // characters the row isn't showing yet.
          <span className={cn("min-w-0 truncate text-foreground", !f && "invisible")} aria-hidden>
            {family.family}
          </span>
        )}
        {downloaded && (
          <Badge variant="secondary" className="gap-1">
            <Icon name="check" size={12} />
            Downloaded
          </Badge>
        )}
        {facts && source === "library" && font && <YourCopy font={font} />}
        {facts && facts.sample && !icons && (
          <span className={cn("contents", !f && "[&>*]:invisible")}>
            <SampleBadge profile={facts.profile} row="family" />
          </span>
        )}
        {facts?.typed && <MissingHint text={facts.text} profile={facts.profile} />}
        {facts?.typed && source === "online" && <AlphabetHint text={facts.text} />}
        {(facts || downloaded) && <span className={cn("shrink-0", facts && !f && !downloaded && "invisible")}>·</span>}
        <span className="shrink-0">{categoryLabel(family.category)}</span>
        <span className="shrink-0">·</span>
        <span className="shrink-0">
          {family.weights.length} {family.weights.length === 1 ? "weight" : "weights"}
          {family.styles.includes("italic") ? " + italics" : ""}
        </span>
        {family.variable && <Badge variant="outline">Variable</Badge>}
        <span className="shrink-0 font-mono text-[11px]">{family.license}</span>
      </div>
    </div>
  );
}

/** What a row's buttons do. Each runs on that row's family. */
interface RowCommands {
  get: (fam: GoogleFamily, copy: boolean) => void;
  update: (fam: GoogleFamily) => void;
  remove: (fam: GoogleFamily) => void;
  activate: (fam: GoogleFamily, on: boolean, scope: ActivationMode | null) => void;
}

/** A row's buttons and switch, after its preview: what `rowPlan` says fits. Only the active
 *  row's are in the Tab order (`tab`). */
function RowControls({
  fam,
  plan,
  holding,
  working,
  switchBusy,
  tab,
  stateId,
  commands,
}: {
  fam: GoogleFamily;
  plan: RowPlan;
  holding: Holding | undefined;
  working: boolean;
  switchBusy: boolean;
  tab: number;
  stateId: string;
  commands: RowCommands;
}) {
  const name = fam.family;
  const faces = switchFaces(holding);
  return (
    // Clicks on the controls don't select the row or open the font page.
    <div className="flex shrink-0 items-center gap-1.5" data-no-drag onDoubleClick={(e) => e.stopPropagation()}>
      {plan.extras.map((extra) => {
        switch (extra) {
          case "working":
            return (
              <span key={extra} className="flex items-center gap-1 text-xs text-muted-foreground">
                <Icon name="progress_activity" size={14} className="animate-spin" aria-hidden />
                Working…
              </span>
            );
          case "update":
            return (
              <Tip key={extra} tip={`Downloads the newest version of ${name} from Google. What's on stays on.`}>
                <Button size="sm" variant="outline" tabIndex={tab} aria-label={`Update ${name}`} onClick={() => commands.update(fam)}>
                  <Icon name="update" size={16} />
                  Update
                </Button>
              </Tip>
            );
          case "remove":
            return (
              <Tip key={extra} tip={`Turns off ${name} and deletes the files Fontface downloaded, after asking`}>
                <Button size="icon-sm" variant="ghost" tabIndex={tab} aria-label={`Remove ${name}`} onClick={() => commands.remove(fam)}>
                  <Icon name="delete" size={16} />
                </Button>
              </Tip>
            );
          case "getCopy":
            return (
              <Tip key={extra} tip={`Downloads Google's version of ${name} and turns it on. Your own copy stays as it is.`}>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  tabIndex={tab}
                  aria-label={`Get Google's ${name}`}
                  className="opacity-0 group-hover/row:opacity-100 group-aria-selected/row:opacity-100 focus-visible:opacity-100"
                  onClick={() => commands.get(fam, true)}
                >
                  <Icon name="download" size={16} />
                </Button>
              </Tip>
            );
        }
      })}
      {plan.main === "switch" && (
        <StateControl
          state={summarize(faces)}
          single={false}
          label={`Activate ${name}`}
          busy={switchBusy || working}
          tabIndex={tab}
          srId={stateId}
          onSwitch={(on, scope) => commands.activate(fam, on, scope)}
        />
      )}
      {plan.main === "get" && (
        <Tip tip={`Downloads ${name} from Google and turns it on`}>
          <Button size="sm" variant="outline" tabIndex={tab} aria-label={`Get ${name}`} onClick={() => commands.get(fam, false)}>
            <Icon name="download" size={16} />
            Get
          </Button>
        </Tip>
      )}
      {plan.main === "working" && (
        <Tip tip="" disabledReason={`Downloading ${name}. It turns on when it's in your library.`}>
          <Button size="sm" variant="outline" disabled focusableWhenDisabled tabIndex={tab} className="aria-disabled:opacity-50" aria-label={`Working on ${name}`}>
            <Icon name="progress_activity" size={16} className="animate-spin" />
            Working…
          </Button>
        </Tip>
      )}
      {plan.main === "unavailable" && (
        <Tip tip={fam.unavailable ?? ""}>
          <span tabIndex={tab} className="rounded-sm text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            Not downloadable here
          </span>
        </Tip>
      )}
    </div>
  );
}

interface Props {
  /** The catalog and its filters (useGoogleView, kept by App for the toolbar). */
  view: GoogleView;
  /** The whole library: a family that's downloaded, or already in your library elsewhere,
   *  previews from those files. */
  fonts: FontSummary[];
  /** The toolbar's preview text and size. */
  previewText: string;
  size: number;
  /** Settings › General › "Show previews of Google Fonts you haven't downloaded". */
  onlinePreviews: boolean;
  /** Opens Settings › General, which has that switch (the note at the bottom links to it). */
  onOpenSettings: () => void;
  /** "Yours first": families you have (downloaded, or already in your library) come first. */
  yoursFirst: boolean;
  onYoursFirst: (on: boolean) => void;
  /** Families with a download or removal in progress (owned by the app, so it survives leaving this view). */
  busy: Set<string>;
  /** Files with an on/off request in progress (the library's). */
  switching: Set<string>;
  /** "Update all" is running (owned by the app). */
  updatingAll: boolean;
  /** Downloads or updates a family. `unchanged` in the result: an update found nothing new. */
  onInstall: (id: string) => Promise<GoogleInstallResult>;
  /** Removes a downloaded family (already confirmed here); the app offers Undo. */
  onRemove: (family: GoogleFamily) => Promise<void>;
  onUpdateAll: (families: GoogleFamily[]) => Promise<void>;
  onActivate: (ids: number[], on: boolean, scope: ActivationMode | null) => void;
  /** Double-click or Return on a family you have: its font page. */
  onOpen: (request: OpenRequest) => void;
  /** What the font menu and its shortcuts work on: the selected family, if you have it. */
  onTarget: (target: FontTarget | null) => void;
  /** The library family a style is listed under. */
  familyOfFace: (key: string) => Family | undefined;
  /** Changes with the search and filters: the list goes back to the top, nothing selected. */
  resetKey: string;
  ref?: React.Ref<ListHandle>;
}

export function GoogleFontsPanel({
  view,
  fonts,
  previewText,
  size,
  onlinePreviews,
  onOpenSettings,
  yoursFirst,
  onYoursFirst,
  busy,
  switching,
  updatingAll,
  onInstall,
  onRemove,
  onUpdateAll,
  onActivate,
  onOpen,
  onTarget,
  familyOfFace,
  resetKey,
  ref,
}: Props) {
  const { catalog, loading, error, reload, category, setCategory, holdings, visible } = view;
  const listId = useId();
  const yoursFirstHintId = useId();
  const tagIndex = useTagIndex();
  const scrollRef = useRef<HTMLDivElement>(null);

  // A preview font per family that's downloaded, or already in the library elsewhere: its most
  // regular style. No network.
  const matches = useMemo(() => matchLibrary(catalog?.families ?? [], fonts), [catalog, fonts]);

  // Switching online previews on or off asks again for every row that had no file, and rows that
  // asked before Rust saved the switch ask again once it has.
  useEffect(() => refreshGooglePreviews(), [onlinePreviews]);
  useEffect(() => listenForPreviewSetting(), []);
  const offline = useGoogleOffline() && onlinePreviews;

  // Yours: downloaded here, or a copy already in your library. Each group keeps the catalog's order.
  const items = useMemo(() => catalogItems(visible, (f) => !!f.installed || holdings.has(f.id), yoursFirst), [visible, holdings, yoursFirst]);
  const updates = useMemo(() => catalog?.families.filter(hasUpdate) ?? [], [catalog]);
  const byId = useMemo(() => new Map(visible.map((f) => [f.id, f])), [visible]);

  // ---------------------------------------------------------------- selection and keyboard

  const order = useMemo(() => items.flatMap((i) => (i.kind === "family" ? [rowKeyOf(i.family.id)] : [])), [items]);
  const itemIndex = useMemo(() => new Map(items.map((i, n) => [i.kind === "family" ? rowKeyOf(i.family.id) : i.id, n])), [items]);
  const position = useMemo(() => new Map(order.map((k, n) => [k, n + 1])), [order]);
  const sel = useSelection(order, `${resetKey}:${yoursFirst}`);
  const { selection } = sel;
  const familyOfKey = (key: string | null) => (key ? byId.get(key.slice(2)) : undefined);
  const [focused, setFocused] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const pressedAt = useRef(-Infinity);
  const [reveal, setReveal] = useState(0);
  const revealActive = () => setReveal((n) => n + 1);
  const menuOnActive = useRef(false);
  const activeIndex = selection.focus === null ? -1 : (itemIndex.get(selection.focus) ?? -1);
  const optionId = (key: string) => `${listId}-${key}`;

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (items[i].kind === "heading" ? HEADING_HEIGHT : Math.ceil(ROW_HEIGHT * size) + 43),
    getItemKey: (i) => {
      const item = items[i];
      return item.kind === "heading" ? item.id : rowKeyOf(item.family.id);
    },
    overscan: 6,
  });

  // New filters, search or order start at the top.
  useLayoutEffect(() => {
    virtualizer.scrollToOffset(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, yoursFirst]);
  // Key commands, keyboard focus and Back bring the active row into view (clicks don't scroll).
  const revealed = useRef(0);
  useEffect(() => {
    revealed.current = reveal;
    if (reveal && activeIndex >= 0) virtualizer.scrollToIndex(activeIndex, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);
  const activeItem = activeIndex >= 0 ? virtualizer.getVirtualItems().find((item) => item.index === activeIndex) : undefined;
  const activeOnScreen = activeInSight(activeItem, virtualizer.scrollOffset ?? 0, virtualizer.scrollRect?.height ?? Infinity, reveal !== revealed.current, activeIndex);
  const firstOnScreen = () => {
    const top = scrollRef.current?.scrollTop ?? 0;
    const item = virtualizer.getVirtualItems().find((i) => items[i.index].kind === "family" && i.start + i.size / 2 >= top);
    const row = item ? items[item.index] : undefined;
    return row?.kind === "family" ? rowKeyOf(row.family.id) : undefined;
  };
  const pageSize = () => Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 0) / (ROW_HEIGHT * size + 43)));

  // While the list has focus it always has an active row.
  useEffect(() => {
    if (focused && selection.focus === null && order.length) sel.ensureFocus(firstOnScreen());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, selection.focus, order.length]);

  // A row's own control with keyboard focus that goes away (Get becomes the switch, the row
  // scrolls out of the drawn ones): focus goes back to the list, whose active row speaks for it.
  const innerFocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const was = innerFocus.current;
    if (!was || was.isConnected) return;
    const now = document.activeElement;
    if (now !== null && now !== document.body) return;
    innerFocus.current = null;
    scrollRef.current?.focus({ preventScroll: true });
  });

  /** What the font actions work on for a row: the family's styles you have, else nothing. */
  const targetFor = (key: string | null): FontTarget | null => {
    const fam = familyOfKey(key);
    const faces = fam ? switchFaces(holdings.get(fam.id)) : [];
    const face = openFace(faces);
    const family = face && familyOfFace(face.key);
    if (!fam || !face || !family) return null;
    return { where: "list", items: [{ rowKey: rowKeyOf(fam.id), family, face, kind: "family" }], faces };
  };
  const selected = selection.keys.size === 1 ? [...selection.keys][0] : null;
  const selectedTarget = useMemo(() => targetFor(selected), [selected, holdings, byId, familyOfFace]); // eslint-disable-line react-hooks/exhaustive-deps
  const reportTarget = useRef(onTarget);
  reportTarget.current = onTarget;
  useEffect(() => reportTarget.current(selectedTarget), [selectedTarget]);
  useEffect(() => () => reportTarget.current(null), []);
  const [menuTarget, setMenuTarget] = useState<FontTarget | null>(null);

  /** Its font page, for a family you have. */
  const openRow = (fam: GoogleFamily | undefined) => {
    const face = fam && openFace(switchFaces(holdings.get(fam.id)));
    if (fam && face) onOpen({ faceKey: face.key, styleKey: face.key, rowKey: rowKeyOf(fam.id), name: fam.family });
  };

  useImperativeHandle(
    ref,
    () => ({
      focusRow: (key) => {
        const listed = key !== null && itemIndex.has(key);
        if (listed) sel.focus(key, false);
        revealActive();
        scrollRef.current?.focus({ preventScroll: true });
        return listed;
      },
    }),
    [itemIndex, sel],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (!e.currentTarget.contains(target) || target.closest("input, textarea")) return;
    setKeyboard(true);
    const onList = target === e.currentTarget;
    if (isMenuKey(e)) {
      if (onList) revealActive();
      menuOnActive.current = onList;
      openMenuFromKeyboard(e, onList && activeOnScreen && selection.focus ? document.getElementById(optionId(selection.focus)) : null);
      menuOnActive.current = false;
      return;
    }
    const command = listKeyCommand(e, IS_MAC);
    if (!command) return;
    if (command.kind === "clear") {
      // With nothing selected, Esc is left to whatever comes next.
      if (selection.keys.size) {
        e.preventDefault();
        sel.clear();
      }
      return;
    }
    // The active row's own controls keep their keys.
    if (!onList) return;
    switch (command.kind) {
      case "move":
        // One row at a time: Shift moves too, without extending.
        e.preventDefault();
        revealActive();
        sel.move(command.move, { extend: false, pageSize: pageSize(), across: 1 });
        return;
      case "open":
        e.preventDefault();
        revealActive();
        openRow(familyOfKey(selection.focus));
        return;
      case "toggle":
        // Space selects the active row (there's only ever one).
        e.preventDefault();
        if (selection.focus) sel.focus(selection.focus, true);
        return;
      case "selectAll":
        e.preventDefault();
        return;
    }
  };

  // ------------------------------------------------------------------------- actions

  /** Runs an action on a family and shows the message it resolves with, or its error. */
  const run = async (fam: GoogleFamily, action: () => Promise<string | void>) => {
    try {
      const message = await action();
      if (message) toast.success(message);
    } catch (e) {
      toast.error(fam.family, { description: e instanceof Error ? e.message : String(e) });
    }
  };
  const [removing, setRemoving] = useState<GoogleFamily | null>(null);
  // The last one stays drawn while the dialog fades out.
  const [removingShown, setRemovingShown] = useState<GoogleFamily | null>(null);
  if (removing && removing !== removingShown) setRemovingShown(removing);
  const removeConfirmed = useRef(false);
  const commands: RowCommands = {
    get: (fam, copy) =>
      void run(fam, () => onInstall(fam.id).then(() => (copy ? `Downloaded Google's ${fam.family} and turned it on` : `${fam.family} downloaded and turned on`))),
    update: (fam) =>
      void run(fam, async () => ((await onInstall(fam.id)).unchanged ? `${fam.family} is already up to date` : `${fam.family} updated`)),
    remove: (fam) => {
      removeConfirmed.current = false;
      setRemoving(fam);
    },
    activate: (fam, on, scope) => onActivate(switchIds(holdings.get(fam.id), on), on, scope),
  };

  // ---------------------------------------------------------------------------- view

  const container = (
    <div
      ref={scrollRef}
      tabIndex={0}
      // Where focus goes back to from a dialog that has nowhere better (focusReturn.ts).
      {...{ [LIBRARY_LIST_ATTR]: "" }}
      role="listbox"
      aria-label="Google Fonts families"
      aria-activedescendant={focused && activeItem && selection.focus ? optionId(selection.focus) : undefined}
      // Keyboard focus shows on the active row; while that row is out of sight, on the list itself.
      className={cn("min-h-0 flex-1 overflow-y-auto", focused && keyboard && !activeOnScreen ? "outline-2 -outline-offset-2 outline-ring/60" : "outline-none")}
      onKeyDown={onKeyDown}
      onMouseDown={() => {
        pressedAt.current = performance.now();
        setKeyboard(false);
      }}
      onFocus={(e) => {
        if (e.target !== e.currentTarget) {
          innerFocus.current = e.target as HTMLElement;
          return;
        }
        innerFocus.current = null;
        const fromKeyboard = performance.now() - pressedAt.current > 300;
        setFocused(true);
        setKeyboard(fromKeyboard);
        sel.ensureFocus(firstOnScreen());
        const from = e.relatedTarget as HTMLElement | null;
        const fromPopup = !from || !!from.closest('[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]');
        if (fromKeyboard && !fromPopup) revealActive();
      }}
      onBlur={(e) => {
        if (e.target === e.currentTarget) setFocused(false);
        // Focus went somewhere else on purpose: nothing to bring back if that control goes.
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) innerFocus.current = null;
      }}
      onContextMenuCapture={(e) => {
        const el = (e.target as HTMLElement).closest<HTMLElement>("[data-row-key]");
        const key = el?.dataset.rowKey ?? (menuOnActive.current ? selection.focus : null);
        setMenuTarget(targetFor(key));
        // Right-clicking a row selects it, like Finder. It never opens the font.
        if (key) sel.focus(key, true);
      }}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The slim bar: what kind of families, their order, and updating them. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2">
        <ChoiceGroup
          look="chips"
          label="Category"
          value={category}
          options={CATEGORIES.map((c) => ({ value: c.value, label: c.label, tip: c.tip }))}
          onChange={setCategory}
        />
        <span className="min-w-2 flex-1" />
        {/* The whole label shows the tooltip (keyboard focus on the switch too). Its words, which
            change with the switch, are the switch's description; its name is only "Yours first". */}
        <Tip tip={yoursFirstTip(yoursFirst)} describe={false} contentClassName="max-w-xs">
          <label className="flex cursor-default items-center gap-2 text-xs text-muted-foreground has-[[role=switch]:focus-visible]:text-foreground">
            <Switch checked={yoursFirst} onCheckedChange={(on) => onYoursFirst(on)} aria-label="Yours first" aria-describedby={yoursFirstHintId} />
            Yours first
            <span id={yoursFirstHintId} hidden>
              {yoursFirstTip(yoursFirst)}
            </span>
          </label>
        </Tip>
        {updates.length > 0 && (
          <Tip
            tip={`Downloads the newest version of ${updates.length === 1 ? "the family" : `all ${updates.length.toLocaleString()} families`} with an update. What's on stays on.`}
            disabledReason={updatingAll && "Updating now. Each family turns back on as it was."}
          >
            <Button
              size="sm"
              variant="outline"
              onClick={() => !updatingAll && void onUpdateAll(updates)}
              disabled={updatingAll}
              focusableWhenDisabled
              className="aria-disabled:opacity-50"
            >
              <Icon name="update" size={16} className={cn(updatingAll && "animate-spin")} />
              {updatingAll ? "Updating…" : `Update all · ${updates.length.toLocaleString()}`}
            </Button>
          </Tip>
        )}
        <Tip tip="Checks Google Fonts for new families and updates" disabledReason={loading && "Checking now…"}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Check for new families and updates"
            onClick={() => !loading && reload(true)}
            disabled={loading}
            focusableWhenDisabled
            className="aria-disabled:opacity-50"
          >
            <Icon name="refresh" size={16} className={cn(loading && "animate-spin")} />
          </Button>
        </Tip>
      </div>
      {category === "icons" && (
        <p className="shrink-0 border-b px-4 py-1.5 text-xs text-muted-foreground">
          Icon fonts draw an icon when you type its name, such as “home”, in apps that support ligatures (letters drawn as one shape).
        </p>
      )}

      {error && !catalog ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <Icon name="cloud_off" size={36} weight={300} className="text-muted-foreground" />
          <p className="max-w-sm text-sm text-muted-foreground">Couldn't load the Google Fonts catalog. {error}</p>
          <Tip tip="Asks Google Fonts for its catalog again">
            <Button onClick={() => reload(true)}>Try again</Button>
          </Tip>
        </div>
      ) : !catalog ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Icon name="progress_activity" size={18} className="animate-spin" />
          Loading the catalog…
        </div>
      ) : (
        <ContextMenu>
          <ContextMenuTrigger render={container}>
            <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = items[item.index];
                if (row.kind === "heading") {
                  return (
                    // Not an option: each row's name already says whether you have it.
                    <div
                      key={item.key}
                      data-index={item.index}
                      ref={virtualizer.measureElement}
                      aria-hidden
                      className="absolute top-0 left-0 flex w-full items-end border-b bg-muted/40 px-4 pb-1.5"
                      style={{ transform: `translateY(${item.start}px)`, height: HEADING_HEIGHT }}
                    >
                      <h3 className="text-xs font-medium text-muted-foreground">
                        {row.label} · {row.count.toLocaleString()}
                      </h3>
                    </div>
                  );
                }
                const fam = row.family;
                const key = rowKeyOf(fam.id);
                const holding = holdings.get(fam.id);
                const working = busy.has(fam.id);
                const plan = rowPlan(fam, holding, working);
                const isSelected = selection.keys.has(key);
                const active = selection.focus === key;
                const id = optionId(key);
                const switchBusy = switchFaces(holding).some((face) => face.copies.some((c) => switching.has(c.path)));
                return (
                  <div
                    key={item.key}
                    data-index={item.index}
                    data-row-key={key}
                    ref={virtualizer.measureElement}
                    id={id}
                    role="option"
                    aria-selected={isSelected}
                    aria-setsize={order.length}
                    aria-posinset={position.get(key)}
                    aria-label={rowLabel(fam, plan, holding)}
                    aria-describedby={`${id}-facts ${id}-state`}
                    className={cn(
                      "group/row absolute top-0 left-0 flex w-full cursor-default items-center gap-3 border-b px-4 py-2.5",
                      isSelected ? "bg-accent" : "hover:bg-muted/50",
                      active && focused && keyboard && "outline-2 -outline-offset-2 outline-ring/60",
                    )}
                    style={{ transform: `translateY(${item.start}px)` }}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest(ROW_CONTROLS)) return;
                      sel.click(key, { toggle: false, range: false });
                    }}
                    onDoubleClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (e.target as HTMLElement).closest(ROW_CONTROLS)) return;
                      openRow(fam);
                    }}
                  >
                    <FamilyInfo
                      family={fam}
                      match={matches.get(fam.id)}
                      text={previewText}
                      online={onlinePreviews}
                      size={size}
                      downloaded={plan.downloaded}
                      factsId={`${id}-facts`}
                    />
                    <RowControls
                      fam={fam}
                      plan={plan}
                      holding={holding}
                      working={working}
                      switchBusy={switchBusy}
                      tab={active ? 0 : -1}
                      stateId={`${id}-state`}
                      commands={commands}
                    />
                  </div>
                );
              })}
            </div>
            {visible.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">{noMatchText(view.filters)}</div>
            )}
          </ContextMenuTrigger>
          <ContextMenuContent className="max-h-[min(32rem,var(--available-height))] min-w-56">
            {menuTarget ? (
              <FontActionItems kind="context" target={menuTarget} index={tagIndex} />
            ) : (
              <ContextMenuItem disabled>Get this family to use its menu</ContextMenuItem>
            )}
          </ContextMenuContent>
        </ContextMenu>
      )}

      {/* One quiet line: where previews come from, and how to turn that off. */}
      <footer className="@container/footer flex shrink-0 items-baseline gap-3 border-t px-4 py-1.5 text-[11px] text-muted-foreground">
        <p className="min-w-0 flex-1">
          {onlinePreviews
            ? "Previews of families you haven't downloaded come from Google. You can turn them off in "
            : "Previews of families you haven't downloaded are off. You can turn them on in "}
          <Tip tip="Opens Settings › General, where you can turn these previews on or off">
            <button
              type="button"
              className="rounded-sm underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              onClick={onOpenSettings}
            >
              Settings
            </button>
          </Tip>
          .{offline && ` Google couldn't be reached just now, so some families show their names. ${KEEPS_TRYING}`}
          {catalog?.stale && " Couldn't reach the catalog, so this is the last saved copy."}
        </p>
        <span className="shrink-0 @max-[640px]/footer:hidden">Catalog by Fontsource · files from Google</span>
      </footer>

      <AlertDialog open={!!removing} onOpenChange={(open) => !open && setRemoving(null)}>
        {/* Removed: the button that opened it is gone, so focus goes to the list. */}
        <AlertDialogContent finalFocus={() => (removeConfirmed.current ? scrollRef.current : null) ?? true}>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removingShown?.family}?</AlertDialogTitle>
            <AlertDialogDescription render={<div className="flex flex-col gap-2" />}>
              {removingShown && removalWords(removingShown.family, holdings.get(removingShown.id)).map((w) => <p key={w}>{w}</p>)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Tip tip={`Turns off ${removingShown?.family ?? "the family"} and deletes the files Fontface downloaded. You can undo it for 10 seconds.`}>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  const fam = removing;
                  removeConfirmed.current = true;
                  setRemoving(null);
                  if (fam) void run(fam, () => onRemove(fam));
                }}
              >
                Remove
              </AlertDialogAction>
            </Tip>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** The View options on the Google Fonts view: the preview styling, which the catalog's previews
 *  follow as the library's do. (Its one layout is Rows; the toolbar's switch says why.) */
export function CatalogViewOptions({ preview, onPreview, dark }: { preview: PreviewOptions; onPreview: (patch: Partial<PreviewOptions>) => void; dark: boolean }) {
  return (
    <Popover>
      <Tip tip="Preview styling for the catalog's rows">
        <PopoverTrigger render={<Button variant="ghost" size="icon-sm" aria-label="View options" />}>
          <Icon name="tune" size={18} />
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" className="max-h-[min(44rem,var(--available-height))] w-[22rem] gap-3.5 overflow-y-auto p-3.5">
        <PopoverTitle className="sr-only">View options</PopoverTitle>
        <PreviewOptionsSection preview={preview} onPreview={onPreview} dark={dark} />
      </PopoverContent>
    </Popover>
  );
}
