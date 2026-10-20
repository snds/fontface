import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, type FactsAnswer, type FontDetail } from "@/api";
import { cssText, type CssStyle } from "@/cssExport";
import { unreadWords } from "@/fontInfo";
import { copyText } from "@/lib/clipboard";
import type { FaceState } from "@/fontLoader";
import type { Face } from "@/library";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Tip } from "@/components/Tip";
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

export type FactsState = { status: "loading" } | { status: "ready"; answer: FactsAnswer } | { status: "error"; message: string };

/**
 * The chosen style's facts (`font_facts`: OpenType features, named styles, embedding, more
 * names, languages, last turned on), read once `enabled` (the OpenType, Axes or Info tab shows
 * them). What was read stays while the style is the same. `retry` asks again (after an
 * online-only file has downloaded, say), showing "Reading…" meanwhile. A new `refresh` (the
 * style was turned on or off) asks again quietly, keeping what's shown until the answer comes,
 * so "Last turned on" follows (the file isn't read again: the back end keeps what it read).
 */
export function useFontFacts(fontId: number, enabled: boolean, refresh = ""): { state: FactsState; retry: () => void } {
  const [read, setRead] = useState<{ id: number; n: number; state: FactsState } | null>(null);
  const [asked, setAsked] = useState(0);
  const wanted = enabled || read?.id === fontId;
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    setRead((r) => (r?.id === fontId && r.n === asked ? r : { id: fontId, n: asked, state: { status: "loading" } }));
    api.fontFacts(fontId).then(
      (answer) => live && setRead({ id: fontId, n: asked, state: { status: "ready", answer } }),
      // A quiet refresh that fails keeps what's shown.
      (e) =>
        live &&
        setRead((r) => (r?.id === fontId && r.n === asked && r.state.status === "ready" ? r : { id: fontId, n: asked, state: { status: "error", message: String(e) } })),
    );
    return () => {
      live = false;
    };
  }, [fontId, wanted, asked, refresh]);
  const retry = useCallback(() => setAsked((n) => n + 1), []);
  return { state: read?.id === fontId ? read.state : { status: "loading" }, retry };
}

/** The file's facts, if they were read. */
export const factsOf = (state: FactsState) => (state.status === "ready" ? state.answer.facts : null);

/**
 * Why the file's details aren't here: "Download to see details" for an online-only file (with
 * Check again, for once it has downloaded), or what stopped it. Nothing while it's read or once
 * it has been.
 */
export function FactsMessage({ state, retry, what = "details" }: { state: FactsState; retry: () => void; what?: string }) {
  if (state.status === "loading") return <p className="text-xs text-muted-foreground">Reading the font's {what}…</p>;
  const unread = state.status === "ready" ? state.answer.unread : null;
  if (state.status === "ready" && !unread) return null;
  const words =
    state.status === "error" ? { title: "Details unavailable", text: state.message } : unreadWords(unread!, state.answer.message);
  const cloud = unread === "cloud";
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border px-3 py-2.5 text-sm" role="status">
      <Icon name={cloud ? "cloud_download" : "info"} size={18} className="mt-px text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium">{words.title}</span>
        <span className="text-xs text-muted-foreground">{words.text}</span>
      </span>
      {(cloud || unread === "missing" || unread === "changed" || state.status === "error") && (
        <Button variant="outline" size="sm" onClick={retry}>
          <Icon name="refresh" size={16} />
          Check again
        </Button>
      )}
    </div>
  );
}

/**
 * Copy as CSS: puts the style's CSS on the clipboard (cssExport.ts) and says so in a toast,
 * with the style's name. Called straight from the click, so the clipboard takes it.
 */
export function copyCss(style: CssStyle, name: string) {
  void copyText(cssText(style)).then((ok) =>
    ok ? toast.success("Copied as CSS", { description: name }) : toast.error("Couldn't copy the CSS"),
  );
}

/** The Axes and OpenType tabs' Copy as CSS button. `waiting`: greyed out while the style's
 *  features are still being read. Its words are its name: no tooltip. */
export function CopyCssButton({ onCopy, waiting = false }: { onCopy: () => void; waiting?: boolean }) {
  return (
    // Stays focusable while it waits, so focus doesn't fall out of the page.
    <Button variant="outline" size="sm" disabled={waiting} focusableWhenDisabled className="aria-disabled:opacity-50" onClick={onCopy}>
      <Icon name="content_copy" size={16} />
      Copy as CSS
    </Button>
  );
}

/**
 * The family's tags, each with a remove button (a lock for built-in tags, which are read-only).
 * A tag only some styles have is drawn dashed and says how many; removing it takes it off all of
 * them. Nothing shows when there are none (the header's Tags button adds them).
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
          >
            <span className="size-2 rounded-full" style={{ background: colorVar(t.color) }} aria-hidden />
            {/* The full name always shows. A dashed tag is on only some styles (screen readers
                hear how many in the name). */}
            <span>
              {t.name.includes("/") && <span className="text-muted-foreground">{t.name.slice(0, t.name.lastIndexOf("/") + 1)}</span>}
              {leafOf(t.name)}
              {partial && <span className="sr-only">, on {n} of {faces.length} styles</span>}
            </span>
            {t.builtin ? (
              // Built-in tags are read-only: a lock where the remove button would be (not a control),
              // named by its tooltip.
              <Tip tip="Built-in, read-only">
                <span className="flex size-5 items-center justify-center text-muted-foreground">
                  <Icon name="lock" size={12} />
                  <span className="sr-only">Built-in, read-only</span>
                </span>
              </Tip>
            ) : (
              // An icon: its tooltip is its name (which, for screen readers, also names the tag).
              <Tip tip="Remove tag">
                <Button variant="ghost" size="icon-xs" className="size-5 rounded-full" aria-label={`Remove tag ${t.name}`} onClick={() => applyTags([t.id], on, false)}>
                  <Icon name="close" size={14} />
                </Button>
              </Tip>
            )}
          </li>
        );
      })}
    </ul>
  );
}
