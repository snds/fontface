import { useEffect, useState } from "react";
import { api, type FontDetail, type PreviewInfo } from "@/api";
import type { FaceState } from "@/fontLoader";
import type { Face } from "@/library";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { colorVar } from "@/tags/api";
import { leafOf, useTagIndex } from "@/tags/model";
import { applyTags } from "@/tags/TagPicker";

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{children}</h2>;
}

export const PANGRAM = "The quick brown fox jumps over the lazy dog";

/** The Specimen tab's paragraph: Fontface's own words, with figures and punctuation in use. */
export const PARAGRAPH =
  "Every typeface has a voice. Set a few lines and you can hear it: whether the letters sit calmly or lean forward, whether the spaces between words breathe, and how the figures 0123456789 keep pace with the text around them. Good type disappears into the reading; it simply makes the next line a little easier than the last.";

/** True if the font can draw every character of `text` (by its profile; unknown counts as yes). */
const draws = (text: string, profile: PreviewInfo | undefined) => {
  const missing = profile?.asciiMissing ?? "";
  return ![...text].some((c) => missing.includes(c));
};

/** Symbol and Expert fonts: their letter keys hold pictures or extra characters, not letters. */
const lettersMeanLetters = (profile: PreviewInfo | undefined) => !profile || (profile.kind !== "symbols" && profile.kind !== "expert");

/**
 * The waterfall's text, first that fits: the typed text; the pangram, if the font has all its
 * letters; the pangram in UPPER or lower case; the profile's own text (the name, or a sample of
 * the font's characters).
 */
export function waterfallText(typed: string, profile: PreviewInfo | undefined, family: string): string {
  if (typed) return typed;
  if (!profile) return PANGRAM;
  if (lettersMeanLetters(profile)) {
    for (const text of [PANGRAM, PANGRAM.toUpperCase(), PANGRAM.toLowerCase()]) if (draws(text, profile)) return text;
  }
  return profile.familyText ?? family;
}

/** The paragraph's text: the paragraph if the font can draw it (in either case), else what the waterfall shows. */
export function paragraphText(profile: PreviewInfo | undefined, family: string): string {
  if (lettersMeanLetters(profile)) {
    for (const text of [PARAGRAPH, PARAGRAPH.toUpperCase(), PARAGRAPH.toLowerCase()]) if (draws(text, profile)) return text;
  }
  return waterfallText("", profile, family);
}

export const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

/** Why a face can't be drawn here, if it can't. */
export function FaceStateMessage({ state }: { state: FaceState }) {
  const text =
    state === "error"
      ? "This font can't be previewed."
      : state === "cloud"
        ? "This file is online-only. It will preview once your cloud drive downloads it."
        : state === "too-large"
          ? "This file is too large to preview."
          : null;
  if (!text) return null;
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground italic">
      <Icon name={state === "cloud" ? "cloud_download" : state === "too-large" ? "data_usage" : "error"} size={14} />
      {text}
    </p>
  );
}

/** The chosen style's details (`get_font`): null while loading or if it couldn't be read. */
export function useFontDetail(fontId: number): FontDetail | null {
  const [detail, setDetail] = useState<{ id: number; detail: FontDetail | null } | null>(null);
  useEffect(() => {
    let live = true;
    api.getFont(fontId).then(
      (d) => live && setDetail({ id: fontId, detail: d }),
      () => live && setDetail({ id: fontId, detail: null }),
    );
    return () => {
      live = false;
    };
  }, [fontId]);
  return detail?.id === fontId ? detail.detail : null;
}

/**
 * The family's tags, each with a remove button. A tag only some styles have is drawn dashed and
 * says how many; removing it takes it off all of them. Nothing shows when there are none (the
 * header's Tags button adds them).
 */
export function TagChipsRow({ faces }: { faces: Face[] }) {
  const index = useTagIndex();
  const counts = new Map<number, number>();
  for (const face of faces) for (const id of index.tagsOf(face)) counts.set(id, (counts.get(id) ?? 0) + 1);
  const tags = index.ordered.filter((n) => counts.has(n.tag.id)).map((n) => n.tag);
  if (!tags.length) return null;
  return (
    <ul className="flex flex-wrap items-center gap-1.5" aria-label="Tags">
      {tags.map((t) => {
        const n = counts.get(t.id)!;
        const partial = n < faces.length;
        const on = faces.filter((f) => index.tagsOf(f).includes(t.id));
        return (
          <li
            key={t.id}
            className="inline-flex h-6 items-center gap-1 rounded-full pr-0.5 pl-2 text-xs"
            style={{
              background: `color-mix(in oklch, ${colorVar(t.color)} var(--tag-tint), transparent)`,
              border: partial ? `1px dashed ${colorVar(t.color)}` : undefined,
            }}
            title={partial ? `${t.name}: on ${n} of ${faces.length} styles` : t.name}
          >
            <span className="size-2 rounded-full" style={{ background: colorVar(t.color) }} aria-hidden />
            <span>
              {t.name.includes("/") && <span className="text-muted-foreground">{t.name.slice(0, t.name.lastIndexOf("/") + 1)}</span>}
              {leafOf(t.name)}
              {partial && <span className="sr-only">, on {n} of {faces.length} styles</span>}
            </span>
            <Button variant="ghost" size="icon-xs" className="size-5 rounded-full" aria-label={`Remove tag ${t.name}`} onClick={() => applyTags([t.id], on, false)}>
              <Icon name="close" size={14} />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
