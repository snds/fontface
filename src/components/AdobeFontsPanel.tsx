import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type AdobeFace, type AdobeStatus } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { libraryCountText } from "@/footerCounts";
import { cn } from "@/lib/utils";
import { ListFrame } from "./FooterRail";
import { PREVIEW_BAR_SPACE } from "./PreviewBar";
import { PreviewText } from "./PreviewText";
import { PageHeader } from "./TitleBar";

const LINKS = {
  browse: "https://fonts.adobe.com/fonts",
  mine: "https://fonts.adobe.com/my_fonts",
  app: "https://www.adobe.com/creativecloud/desktop-app.html",
  search: (family: string) => `https://fonts.adobe.com/search?query=${encodeURIComponent(family)}`,
};

const open = (url: string) => openUrl(url).catch(() => {});

/** The face to preview a family with: Regular-like and upright if there is one. */
function previewFace(faces: AdobeFace[]): AdobeFace {
  const upright = (f: AdobeFace) => !/italic|oblique/i.test(f.style);
  return (
    faces.find((f) => upright(f) && /^(regular|book|roman|normal|text)$/i.test(f.style.trim())) ??
    faces.find(upright) ??
    faces[0]
  );
}

interface Props {
  /** The preview bar's text and size. */
  previewText: string;
  size: number;
  /** The preview bar, shown over the bottom of the list while there's one. */
  bar?: React.ReactNode;
  onStatus?: (status: AdobeStatus) => void;
}

/**
 * Adobe Fonts are licensed for use through Creative Cloud only. Fontface lists the ones Creative
 * Cloud has turned on (names from the OS), draws them through the OS by name, and sends the user
 * to Adobe to change anything. It never opens, copies or switches the files. The preview bar's
 * text, size and styling apply to the previews, which are drawn by name all the same; the
 * footer rail counts the families and styles.
 */
export function AdobeFontsPanel({ previewText, size, bar, onStatus }: Props) {
  const [status, setStatus] = useState<AdobeStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const s = await api.adobeStatus();
      setStatus(s);
      onStatus?.(s);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const families = useMemo(() => {
    const map = new Map<string, AdobeFace[]>();
    for (const face of status?.faces ?? []) {
      const list = map.get(face.family);
      if (list) list.push(face);
      else map.set(face.family, [face]);
    }
    return [...map.entries()];
  }, [status]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader icon="cloud" title="Adobe Fonts">
        <Button variant="outline" size="sm" onClick={load} disabled={loading} focusableWhenDisabled className="aria-disabled:opacity-50">
          <Icon name="refresh" size={16} className={cn(loading && "animate-spin")} />
          Refresh
        </Button>
      </PageHeader>

      <div className="flex flex-col gap-3 border-b px-4 py-3">
        <p className="max-w-2xl text-xs text-muted-foreground">
          Adobe Fonts come with Creative Cloud, and Adobe only allows using them through Creative Cloud. So Fontface shows
          the ones Creative Cloud has turned on, and sends you to Adobe to turn fonts on or off. It never opens or copies
          Adobe's font files.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => open(LINKS.browse)}>
            <Icon name="open_in_new" size={16} />
            Browse Adobe Fonts
          </Button>
          <Button size="sm" variant="outline" onClick={() => open(LINKS.mine)}>
            <Icon name="open_in_new" size={16} />
            My Adobe Fonts
          </Button>
        </div>
      </div>

      <ListFrame
        bar={status?.supported && status.faces.length > 0 ? bar : undefined}
        count={status ? libraryCountText(families.length, status.faces.length) : ""}
      >
      {!status ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Icon name="progress_activity" size={18} className="animate-spin" />
          Checking Creative Cloud…
        </div>
      ) : !status.supported ? (
        <Empty icon="info" title="Not available on this system yet">
          Listing Adobe Fonts is built for macOS first.
        </Empty>
      ) : !status.appInstalled && status.faces.length === 0 ? (
        <Empty icon="cloud_off" title="Creative Cloud isn't installed">
          <p>Install the Creative Cloud desktop app and sign in to use Adobe Fonts. Fonts it turns on will show up here.</p>
          <Button className="mt-3" onClick={() => open(LINKS.app)}>
            <Icon name="open_in_new" size={16} />
            Get Creative Cloud
          </Button>
        </Empty>
      ) : status.faces.length === 0 ? (
        <Empty icon="font_download_off" title="No Adobe Fonts are turned on">
          Turn fonts on at fonts.adobe.com or in the Creative Cloud app. Fonts added for "Adobe apps only" don't show up
          here, because other apps can't use them.
        </Empty>
      ) : (
        <div
          className="min-h-0 flex-1 overflow-y-auto"
          // Room under the last family, and when one is scrolled into view, for the preview bar.
          style={{ paddingBottom: PREVIEW_BAR_SPACE, scrollPaddingBottom: PREVIEW_BAR_SPACE }}
          role="list"
          aria-label="Adobe Fonts turned on by Creative Cloud"
        >
          {families.map(([family, faces]) => (
            <div key={family} role="listitem" className="border-b px-4 py-3">
              <div className="mb-1 flex items-center gap-2">
                <span className="truncate text-sm font-semibold">{family}</span>
                <span className="flex-1 text-xs text-muted-foreground">
                  {faces.length} {faces.length === 1 ? "style" : "styles"}
                </span>
                <Badge variant="secondary" className="gap-1">
                  <Icon name="lock" size={12} />
                  Creative Cloud
                </Badge>
                {/* Its name says which family, as each row's button reads the same. */}
                <Button size="xs" variant="ghost" aria-label={`Find ${family} on Adobe Fonts`} onClick={() => open(LINKS.search(family))}>
                  <Icon name="open_in_new" size={14} />
                  Adobe Fonts
                </Button>
              </div>
              {/* Drawn by the OS through the font's registered name. Nothing is read from Adobe's files. */}
              {/* Fitted from the canvas's measurement of the drawn text, never from the file. */}
              <PreviewText fontFamily={`"${previewFace(faces).postscriptName}", "${family}"`} text={previewText || family} typed={!!previewText} size={size} ready />

              <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                {faces.map((f) => (
                  <span key={f.postscriptName}>{f.style}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      </ListFrame>
    </div>
  );
}

function Empty({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <Icon name={icon} size={36} weight={300} className="text-muted-foreground" />
      <h3 className="font-semibold">{title}</h3>
      <div className="max-w-md text-sm text-muted-foreground">{children}</div>
    </div>
  );
}
