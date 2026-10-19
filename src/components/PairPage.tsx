import { useEffect, useRef, useState } from "react";
import { PAIR_TEXT, swapPair, type PairFonts } from "@/compare";
import type { PagePatch, PairPageEntry } from "@/nav";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { usePreviewProfile } from "@/previewProfiles";
import { useFontPicker } from "./FontPicker";
import { FaceSample, SizeSlider, StylePicker, type FaceRef } from "./ComparePage";
import { MissingHint } from "./FacePreview";
import { BackButton } from "./fontPage/PageHeader";
import { dragRegion, useTitleBar } from "./TitleBar";

interface Props {
  page: PairPageEntry;
  faceOf: (key: string) => FaceRef | undefined;
  /** What Back returns to, in words. */
  placeName: string;
  /** The toolbar's preview text: the heading, when there is some. */
  previewText: string;
  onBack: () => void;
  onChange: (patch: PagePatch) => void;
  announce: (text: string) => void;
}

const ROLES = { heading: "Heading", body: "Body" } as const;
type Role = keyof typeof ROLES;

/**
 * Pair (from a font's menus or the Font menu): a heading font and a body font, set together as a
 * simple page: a heading, a line under it in the heading font, and a paragraph in the body font.
 * Each font has its own style and size (the body its line height too), either can be swapped
 * for another from the library, and Swap trades them.
 */
export function PairPage({ page, faceOf, placeName, previewText, onBack, onChange, announce }: Props) {
  const titleBar = useTitleBar();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pick = useFontPicker();
  const [headingSize, setHeadingSize] = useState(48);
  const [bodySize, setBodySize] = useState(18);
  const [leading, setLeading] = useState(1.5);
  useEffect(() => headingRef.current?.focus({ preventScroll: true }), []);

  const fonts: PairFonts = { heading: page.heading, body: page.body };
  const heading = faceOf(page.heading);
  const body = faceOf(page.body);
  const name = (ref: FaceRef | undefined) => ref?.family.name ?? "a font that's no longer in your library";

  const choose = (role: Role) =>
    pick({
      title: role === "heading" ? "Choose the heading font" : "Choose the body font",
      multiple: false,
      onPick: ([family]) => {
        onChange({ [role]: family.representative.key });
        announce(`${ROLES[role]} font: ${family.name}`);
      },
    });

  const swap = () => {
    onChange(swapPair(fonts));
    announce(`Swapped: ${name(body)} is the heading, ${name(heading)} the body`);
  };

  return (
    <>
      <header className="@container/pagehead flex h-13 shrink-0 items-center gap-2 overflow-hidden border-b px-3 select-none" {...dragRegion(titleBar)}>
        <BackButton placeName={placeName} onBack={onBack} />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h1 ref={headingRef} tabIndex={-1} className="truncate text-base font-semibold outline-none">
            Pair
          </h1>
          <span className="truncate text-xs text-muted-foreground @max-[560px]/pagehead:sr-only">
            {heading?.family.name ?? "…"} and {body?.family.name ?? "…"}
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={swap} aria-label="Swap the heading and body fonts">
          <Icon name="swap_vert" size={16} />
          <span className="@max-[480px]/pagehead:sr-only">Swap</span>
        </Button>
      </header>
      <div className="flex shrink-0 flex-col gap-2 border-b px-6 py-2.5">
        <FontControls role="heading" face={heading} typed={previewText} onChoose={() => choose("heading")} onStyle={(key) => onChange({ heading: key })}>
          <SizeSlider label="Size" value={headingSize} min={16} max={128} onChange={setHeadingSize} />
        </FontControls>
        <FontControls role="body" face={body} onChoose={() => choose("body")} onStyle={(key) => onChange({ body: key })}>
          <SizeSlider label="Size" value={bodySize} min={10} max={32} onChange={setBodySize} />
          <SizeSlider label="Line height" value={leading} min={1} max={2.2} step={0.05} unit="" onChange={(v) => setLeading(Math.round(v * 100) / 100)} />
        </FontControls>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <section aria-label="Preview" className="mx-auto flex max-w-3xl flex-col gap-3 px-8 pt-10 pb-16">
          {heading ? (
            <>
              {/* Each in words the font can draw (a caps-only or symbol font gets text it has). */}
              <FaceSample face={heading.face} typed={previewText} words={PAIR_TEXT.heading} size={headingSize} lineHeight={1.1} />
              <FaceSample face={heading.face} words={PAIR_TEXT.subheading} size={Math.max(14, Math.round(headingSize * 0.45))} lineHeight={1.25} className="text-muted-foreground" />
            </>
          ) : (
            <Missing role="heading" onChoose={() => choose("heading")} />
          )}
          {body ? (
            <FaceSample face={body.face} words={PAIR_TEXT.body} size={bodySize} lineHeight={leading} className="mt-3 max-w-[68ch]" />
          ) : (
            <Missing role="body" onChoose={() => choose("body")} />
          )}
        </section>
      </div>
    </>
  );
}

/** One font's controls: which font (opens the library search), its style, and its sizes. `typed`:
 *  text from the toolbar it shows, marked when the font can't draw all of it. */
function FontControls({
  role,
  face,
  typed = "",
  onChoose,
  onStyle,
  children,
}: {
  role: Role;
  face: FaceRef | undefined;
  typed?: string;
  onChoose: () => void;
  onStyle: (key: string) => void;
  children: React.ReactNode;
}) {
  const { profile } = usePreviewProfile(face?.face.primary);
  return (
    <div role="group" aria-label={`${ROLES[role]} font`} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="w-14 shrink-0 text-xs font-medium text-muted-foreground">{ROLES[role]}</span>
      <Button variant="outline" size="sm" className="max-w-56" onClick={onChoose} aria-label={`${ROLES[role]} font: ${face?.family.name ?? "none"}. Choose another`}>
        <span className="truncate">{face?.family.name ?? "Choose…"}</span>
        <Icon name="unfold_more" size={14} className="text-muted-foreground" />
      </Button>
      {face && <StylePicker face={face} label={`${ROLES[role]} style`} onChange={onStyle} />}
      {face && typed && <MissingHint text={typed} profile={profile} />}
      {children}
    </div>
  );
}

function Missing({ role, onChoose }: { role: Role; onChoose: () => void }) {
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      The {role} font isn't in your library anymore.
      <Button variant="outline" size="sm" onClick={onChoose}>
        Choose a {role} font…
      </Button>
    </p>
  );
}
