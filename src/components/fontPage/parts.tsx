import { useEffect, useState } from "react";
import { api, type FontDetail } from "@/api";
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

// The font page's sample texts, and how a font that can't draw them gets text it can.
export { PANGRAM, PARAGRAPH, paragraphText, waterfallText } from "@/sampleText";

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
