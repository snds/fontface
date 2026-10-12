import { useEffect, useState } from "react";
import { api, type FontDetail } from "@/api";
import { faceName, useFontFace } from "@/fontLoader";
import { activationIds, WEIGHT_NAMES, type Face } from "@/library";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { colorVar } from "@/tags/api";
import type { Locations } from "@/tags/locations";
import { leafOf, useTagIndex } from "@/tags/model";
import { applyTags, TagPicker } from "@/tags/TagPicker";
import { ActivationSwitch, InstalledBadge } from "./ActivationSwitch";

interface Props {
  face: Face;
  previewText: string;
  busy: boolean;
  locations: Locations;
  onClose: () => void;
  onActivate: (ids: number[], active: boolean) => void;
  onReveal: (id: number) => void;
}

const WATERFALL = [12, 16, 24, 36, 48, 72];
const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ\nabcdefghijklmnopqrstuvwxyz\n0123456789 !?&@#%$€£(){}[]“”‘’—–…";

const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{children}</h3>;
}

/** The style's tags, each removable, and a button to add more. */
function TagsSection({ face }: { face: Face }) {
  const index = useTagIndex();
  const tags = index.tagsOf(face).map((id) => index.byId.get(id)!).filter(Boolean);
  return (
    <section>
      <SectionTitle>Tags</SectionTitle>
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((t) => (
          <span
            key={t.id}
            className="inline-flex h-6 items-center gap-1 rounded-full pr-0.5 pl-2 text-xs"
            style={{ background: `color-mix(in oklch, ${colorVar(t.color)} var(--tag-tint), transparent)` }}
            title={t.name}
          >
            <span className="size-2 rounded-full" style={{ background: colorVar(t.color) }} aria-hidden />
            <span>
              {t.name.includes("/") && <span className="text-muted-foreground">{t.name.slice(0, t.name.lastIndexOf("/") + 1)}</span>}
              {leafOf(t.name)}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-5 rounded-full"
              aria-label={`Remove tag ${t.name}`}
              onClick={() => applyTags([t.id], [face], false)}
            >
              <Icon name="close" size={14} />
            </Button>
          </span>
        ))}
        <Popover>
          <PopoverTrigger render={<Button variant="outline" size="xs" className="rounded-full" />}>
            <Icon name="add" size={14} />
            {tags.length ? "Tag" : "Add a tag"}
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80">
            <TagPicker faces={[face]} />
          </PopoverContent>
        </Popover>
      </div>
    </section>
  );
}

export function DetailPanel({ face, previewText, busy, locations, onClose, onActivate, onReveal }: Props) {
  const font = face.primary;
  const [detail, setDetail] = useState<FontDetail | null>(null);
  const [axisValues, setAxisValues] = useState<Record<string, number>>({});
  const state = useFontFace(font);

  useEffect(() => {
    let live = true;
    setDetail(null);
    setAxisValues({});
    api.getFont(font.id).then(
      (d) => live && setDetail(d),
      () => live && setDetail(null),
    );
    return () => {
      live = false;
    };
  }, [font.id]);

  const variation = Object.entries(axisValues)
    .map(([tag, v]) => `"${tag}" ${v}`)
    .join(", ");
  const faceStyle = { fontFamily: `"${faceName(font)}"`, fontVariationSettings: variation || undefined };
  const faceClass = cn("transition-opacity", state === "loading" && "preview-loading");
  const sample = previewText || "The quick brown fox jumps over the lazy dog";
  const axes = detail?.axes.filter((a) => !a.hidden) ?? [];

  // [label, value, monospace?]
  const rows: [string, string | null | undefined, boolean?][] = detail
    ? [
        ["PostScript", detail.postscriptName, true],
        ["Version", detail.version],
        ["Format", detail.format],
        ["Weight", `${detail.weight}${WEIGHT_NAMES[detail.weight] ? ` · ${WEIGHT_NAMES[detail.weight]}` : ""}`],
        ["Width", String(detail.width)],
        ["Glyphs", detail.glyphCount.toLocaleString()],
        ["Monospaced", detail.monospace ? "Yes" : "No"],
        ["Designer", detail.designer],
        ["Foundry", detail.manufacturer],
        ["File size", formatBytes(font.fileSize)],
        ["Copyright", detail.copyright],
        ["License", detail.license],
        ["License URL", detail.licenseUrl, true],
      ]
    : [];

  return (
    <aside className="flex min-h-0 flex-col border-l" aria-label="Font details">
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{font.family}</h2>
          <div className="truncate text-sm text-muted-foreground">{font.subfamily}</div>
        </div>
        {face.installed ? (
          <InstalledBadge />
        ) : (
          <ActivationSwitch
            active={face.active ? 1 : 0}
            total={1}
            label={`Activate ${font.family} ${font.subfamily}`}
            busy={busy}
            onChange={(on) => onActivate(activationIds([face], on), on)}
          />
        )}
        <Button variant="ghost" size="icon-sm" aria-label="Close details" onClick={onClose}>
          <Icon name="close" size={18} />
        </Button>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-4">
          {state === "error" && <p className="text-xs text-muted-foreground italic">This font can't be previewed.</p>}
      {state === "cloud" && (
        <p className="text-xs text-muted-foreground italic">This file is online-only. It will preview once your cloud drive downloads it.</p>
      )}
      {state === "too-large" && <p className="text-xs text-muted-foreground italic">This file is too large to preview.</p>}

          <TagsSection face={face} />

          <Separator />
          <section>
            <SectionTitle>Waterfall</SectionTitle>
            {WATERFALL.map((px) => (
              <div key={px} className="flex items-baseline gap-2 overflow-hidden whitespace-nowrap">
                <span className="w-5 shrink-0 text-right font-mono text-[10px] text-muted-foreground">{px}</span>
                <span className={faceClass} style={{ ...faceStyle, fontSize: px }}>
                  {sample}
                </span>
              </div>
            ))}
          </section>

          {axes.length > 0 && (
            <>
              <Separator />
              <section className="flex flex-col gap-3">
                <SectionTitle>Variable axes</SectionTitle>
                {axes.map((a) => {
                  const value = axisValues[a.tag] ?? a.default;
                  return (
                    <div key={a.tag} className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span>
                          {a.name ?? a.tag} <code className="font-mono text-muted-foreground">{a.tag}</code>
                        </span>
                        <span className="font-mono text-muted-foreground tabular-nums">{Math.round(value * 10) / 10}</span>
                      </div>
                      <Slider
                        min={a.min}
                        max={a.max}
                        step={(a.max - a.min) / 200 || 1}
                        value={[value]}
                        onValueChange={(v) => setAxisValues((s) => ({ ...s, [a.tag]: Array.isArray(v) ? v[0] : v }))}
                        aria-label={a.name ?? a.tag}
                      />
                    </div>
                  );
                })}
              </section>
            </>
          )}

          <Separator />
          <section>
            <SectionTitle>Characters</SectionTitle>
            <div className={cn(faceClass, "selectable text-[22px] leading-snug break-all whitespace-pre-wrap")} style={faceStyle}>
              {CHARSET}
            </div>
          </section>

          <Separator />
          <section>
            <SectionTitle>Info</SectionTitle>
            <dl className="flex flex-col gap-1.5 text-xs">
              {rows
                .filter(([, v]) => v)
                .map(([k, v, mono]) => (
                  <div key={k} className="grid grid-cols-[96px_1fr] gap-2">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className={cn("selectable max-h-32 overflow-y-auto break-words", mono && "font-mono")}>{v}</dd>
                  </div>
                ))}
            </dl>
            {face.copies.length > 1 ? (
              <div className="mt-3 flex flex-col gap-1.5">
                <div className="text-xs font-medium">{face.copies.length} copies of this font</div>
                {face.copies.map((c) => (
                  <div key={c.id} className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span className="size-2 shrink-0 rounded-full" style={{ background: colorVar(locations.colorOfCopy(c)) }} aria-hidden />
                      <span className="truncate">{locations.describeCopy(c)}</span>
                    </div>
                    <div className="flex items-start gap-1.5 font-mono text-[11px] text-muted-foreground">
                      <Icon
                        name={c.osActive ? "check_circle" : "radio_button_unchecked"}
                        size={14}
                        filled={c.osActive}
                        className={c.osActive ? "text-active" : ""}
                      />
                      <span className="selectable break-all" title={c.osActive ? "On" : "Off"}>
                        {c.path}
                        {c.faceIndex > 0 ? ` (face ${c.faceIndex})` : ""}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-3 flex flex-col gap-0.5">
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: colorVar(locations.colorOfCopy(font)) }} aria-hidden />
                  <span className="truncate">{locations.describeCopy(font)}</span>
                </div>
                <div className="selectable font-mono text-[11px] break-all text-muted-foreground" title={font.path}>
                  {font.path}
                  {font.faceIndex > 0 ? ` (face ${font.faceIndex})` : ""}
                </div>
              </div>
            )}
            <Button variant="outline" size="sm" className="mt-3" onClick={() => onReveal(font.id)}>
              <Icon name="folder_open" size={16} />
              Show in Finder
            </Button>
          </section>
        </div>
      </ScrollArea>
    </aside>
  );
}
