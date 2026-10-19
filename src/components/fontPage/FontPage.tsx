import { useEffect, useRef, useState } from "react";
import type { ActivationMode, FontPageTab } from "@/api";
import type { Face, Family } from "@/library";
import type { FontPageEntry, PagePatch } from "@/nav";
import { usePreviewProfile } from "@/previewProfiles";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useFontCharacters } from "@/components/CharacterGrid";
import { dragRegion, useTitleBar } from "@/components/TitleBar";
import { FontActionItems } from "@/components/FontActions";
import { pageTarget } from "@/fontActions";
import type { Locations } from "@/tags/locations";
import { openMenuFromKeyboard } from "@/tags/menus";
import { useTagIndex } from "@/tags/model";
import { AxesTab } from "./AxesTab";
import { CharactersTab } from "./CharactersTab";
import { InfoTab } from "./InfoTab";
import { BackButton, FontPageHeader } from "./PageHeader";
import { TagChipsRow, useFontDetail } from "./parts";
import { SpecimenTab } from "./SpecimenTab";

interface Props {
  page: FontPageEntry;
  /** The whole family (filters don't apply here), or undefined once it has left the library. */
  family: Family | undefined;
  /** What Back returns to, in words ("All Fonts", a folder, a tag). */
  placeName: string;
  previewText: string;
  /** Files with an on/off request in progress. */
  busy: Set<string>;
  locations: Locations;
  onBack: () => void;
  onChange: (patch: PagePatch) => void;
  onActivate: (ids: number[], active: boolean, scope?: ActivationMode | null) => void;
  onReveal: (fontId: number) => void;
  /** Bumped by Cmd+T (or the Font menu's Tags…) to open the header's Tags popover. */
  tagsAsk?: number;
}

/**
 * A family's page, opened over the library list (double-click or Return on a row). It always
 * shows the whole family. The chosen style and tab live in the page's stack entry (nav.ts);
 * axis values and the character search live here, and stay while the page is open.
 */
export function FontPage(props: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const gone = !props.family;
  // Focus starts on the heading when the page opens (and if its font leaves the library while
  // it's open, on the message that says so).
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [gone]);
  if (!props.family) return <GonePage placeName={props.placeName} onBack={props.onBack} headingRef={headingRef} />;
  return <FamilyPage {...props} family={props.family} headingRef={headingRef} />;
}

function GonePage({ placeName, onBack, headingRef }: { placeName: string; onBack: () => void; headingRef: React.Ref<HTMLHeadingElement> }) {
  const titleBar = useTitleBar();
  return (
    <>
      <header className="flex h-13 shrink-0 items-center gap-2 border-b px-3 select-none" {...dragRegion(titleBar)}>
        <BackButton placeName={placeName} onBack={onBack} />
        <h1 ref={headingRef} tabIndex={-1} className="truncate text-base font-semibold outline-none">
          Font not found
        </h1>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name="font_download_off" size={40} weight={300} className="text-muted-foreground" />
        <p className="text-sm font-medium">This font isn't in your library anymore.</p>
        <p className="max-w-sm text-sm text-muted-foreground">Its file may have been moved or deleted, or its folder removed from the library.</p>
        <Button variant="outline" onClick={onBack}>
          <Icon name="arrow_back" size={16} />
          Back to {placeName}
        </Button>
      </div>
    </>
  );
}

const TAB_LABELS: Record<FontPageTab, string> = { specimen: "Specimen", characters: "Characters", axes: "Axes", info: "Info" };

function FamilyPage({ page, family, placeName, previewText, busy, locations, onBack, onChange, onActivate, onReveal, tagsAsk, headingRef }: Props & { family: Family; headingRef: React.RefObject<HTMLHeadingElement | null> }) {
  const face: Face =
    family.faces.find((f) => f.key === page.styleKey) ?? family.faces.find((f) => f.key === page.faceKey) ?? family.representative;
  const font = face.primary;
  // Axes show only for a variable style; another style shows Specimen instead (the saved tab stays).
  const tabs: FontPageTab[] = font.variable ? ["specimen", "characters", "axes", "info"] : ["specimen", "characters", "info"];
  const tab = tabs.includes(page.tab) ? page.tab : "specimen";

  const detail = useFontDetail(font.id);
  const characters = useFontCharacters(font.id, tab === "characters" || tab === "info");
  const { profile } = usePreviewProfile(font);
  const [query, setQuery] = useState("");
  // Axis values belong to one style: another style starts at its defaults.
  const [axes, setAxes] = useState<{ fontId: number; values: Record<string, number> }>({ fontId: font.id, values: {} });
  const values = axes.fontId === font.id ? axes.values : {};
  const variation =
    Object.entries(values)
      .map(([tag, v]) => `"${tag}" ${v}`)
      .join(", ") || undefined;
  const visibleAxes = detail ? detail.axes.filter((a) => !a.hidden) : null;

  return (
    <PageMenu family={family} face={face}>
      <FontPageHeader
        family={family}
        face={face}
        placeName={placeName}
        headingRef={headingRef}
        busy={busy}
        onBack={onBack}
        onChoose={(styleKey) => onChange({ styleKey })}
        onActivate={onActivate}
        tagsAsk={tagsAsk}
      />
      <Tabs value={tab} onValueChange={(v) => onChange({ tab: v as FontPageTab })} className="min-h-0 flex-1 gap-0">
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-6 py-2.5">
          <TabsList aria-label="Font page" activateOnFocus>
            {tabs.map((t) => (
              <TabsTrigger key={t} value={t}>
                {TAB_LABELS[t]}
              </TabsTrigger>
            ))}
          </TabsList>
          <TagChipsRow faces={family.faces} />
        </div>
        <TabsContent value="specimen" className="min-h-0 overflow-y-auto">
          <SpecimenTab
            family={family}
            face={face}
            previewText={previewText}
            variation={variation}
            busy={busy}
            onChoose={(styleKey) => onChange({ styleKey })}
            onActivate={onActivate}
          />
        </TabsContent>
        <TabsContent value="characters" className="min-h-0 overflow-y-auto">
          <CharactersTab font={font} characters={characters} variation={variation} query={query} onQuery={setQuery} />
        </TabsContent>
        {font.variable && (
          <TabsContent value="axes" className="min-h-0 overflow-y-auto">
            <AxesTab
              axes={visibleAxes}
              values={values}
              onChange={(tag, v) => setAxes({ fontId: font.id, values: { ...values, [tag]: v } })}
            />
          </TabsContent>
        )}
        <TabsContent value="info" className="min-h-0 overflow-y-auto">
          <InfoTab face={face} detail={detail} characters={characters} profile={profile} locations={locations} onReveal={onReveal} />
        </TabsContent>
      </Tabs>
    </PageMenu>
  );
}

/** Right-click text that's selected, or a field, for the normal menu (Copy, Paste). */
function wantsNativeMenu(e: React.MouseEvent) {
  const selection = window.getSelection();
  const target = e.target as HTMLElement;
  return (selection && !selection.isCollapsed && !!selection.toString().trim()) || !!target.closest("input, textarea, [role=slider]");
}

/**
 * Right-click anywhere on the page (or Shift-F10) for the font's menu (components/FontActions):
 * on a line in "All styles" it covers that style, elsewhere the whole family in its chosen style.
 */
function PageMenu({ family, face, children }: { family: Family; face: Face; children: React.ReactNode }) {
  const index = useTagIndex();
  const [line, setLine] = useState<Face | null>(null);
  return (
    // The line right-clicked is set as the menu opens (and kept while it closes).
    <ContextMenu>
      <ContextMenuTrigger
        render={<div className="flex min-h-0 flex-1 flex-col" />}
        onKeyDown={(e) => openMenuFromKeyboard(e)}
        onContextMenuCapture={(e) => {
          // Inside a popover (portaled, but React passes its events up) or on a field: the normal menu.
          if (!e.currentTarget.contains(e.target as Node) || wantsNativeMenu(e)) {
            e.stopPropagation();
            return;
          }
          const key = (e.target as HTMLElement).closest<HTMLElement>("[data-face-key]")?.dataset.faceKey;
          setLine((key && family.faces.find((f) => f.key === key)) || null);
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="max-h-[min(32rem,var(--available-height))] min-w-56">
        <FontActionItems kind="context" target={pageTarget(family, face, line ?? undefined)} index={index} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
