import type { FontSummary, GooglePreview, GooglePreviewKind } from "./api.ts";
import { formatBytes } from "./familyFacts.ts";

// How the Google Fonts catalog (components/GoogleFontsPanel.tsx) previews each family:
// - **Downloaded** (in the folder Fontface manages): from those files, as before.
// - **Already in your library** (any folder): from your own copy, with no network at all. The
//   catalog's name and the library's family name are compared ignoring case, spaces and
//   punctuation.
// - **Online** (Settings › General, on by default): Rust downloads a tiny file holding just the
//   characters the row draws from Google's CSS2 `text=` option, keeps it in a cache and serves it
//   through `ff://`; the web view itself never talks to Google. Typed text draws from a fixed
//   "alphabet" file (printable ASCII and Latin-1), so what's typed never leaves the Mac.
// - Otherwise the name in the interface font.
// Pure (no DOM, no Tauri), so `npm run test:ui` covers it.

// --------------------------------------------------------------------------- library match

/** A family name for comparing: lowercase letters and digits only, so "IBM Plex Sans",
 *  "IBMPlexSans" and "Ibm-Plex Sans" are the same. */
export const familyKey = (name: string) =>
  name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

export type MatchFont = Pick<FontSummary, "id" | "family" | "path" | "italic" | "weight" | "width">;

/** The catalog fields matching needs. */
export interface CatalogRef {
  id: string;
  family: string;
  installed: { dir: string } | null;
}

export interface LibraryMatch<F> {
  font: F;
  /** The copy Fontface downloaded into its Google Fonts folder. False: a copy elsewhere in the
   *  library, which may be another version. */
  downloaded: boolean;
}

/** How far a style is from the regular one: upright first, then the weight nearest 400, then
 *  the normal width. Lower is more regular. */
export const irregularity = (f: Pick<FontSummary, "italic" | "weight" | "width">) =>
  (f.italic ? 1_000_000 : 0) + Math.abs(f.weight - 400) * 100 + Math.abs(f.width - 5);

const moreRegular = <F extends MatchFont>(a: F, b: F | undefined) =>
  !b || irregularity(a) < irregularity(b) || (irregularity(a) === irregularity(b) && a.id < b.id);

const trimDir = (dir: string) => dir.replace(/[\\/]+$/, "");

/** The folder `path` is in ("" for none). */
const parentOf = (path: string) => path.slice(0, Math.max(0, path.search(/[\\/][^\\/]*$/)));

/**
 * The library font each catalog family previews with, by catalog id: a font in the family's
 * downloaded folder if it has one, else a font whose family name matches. Either way its most
 * regular style. Families with neither aren't in the map. Fonts sharing a folder or a family
 * name are looked up once, so a library of tens of thousands of fonts stays quick.
 */
export function matchLibrary<F extends MatchFont>(families: readonly CatalogRef[], fonts: readonly F[]): Map<string, LibraryMatch<F>> {
  const byDir = new Map<string, string>();
  const byKey = new Map<string, string>();
  for (const fam of families) {
    if (fam.installed) byDir.set(trimDir(fam.installed.dir), fam.id);
    const key = familyKey(fam.family);
    if (key && !byKey.has(key)) byKey.set(key, fam.id);
  }
  /** Folder → the downloaded family it's in (at any depth), or null. */
  const dirFamily = new Map<string, string | null>();
  const downloadedIn = (dir: string): string | null => {
    if (!dir) return null;
    let hit = dirFamily.get(dir);
    if (hit === undefined) {
      hit = byDir.get(dir) ?? downloadedIn(parentOf(dir));
      dirFamily.set(dir, hit);
    }
    return hit;
  };
  /** Family name → catalog id, or null. */
  const nameFamily = new Map<string, string | null>();
  const downloaded = new Map<string, F>();
  const named = new Map<string, F>();
  for (const font of fonts) {
    const inDir = byDir.size ? downloadedIn(parentOf(font.path)) : null;
    if (inDir) {
      if (moreRegular(font, downloaded.get(inDir))) downloaded.set(inDir, font);
      continue;
    }
    let id = nameFamily.get(font.family);
    if (id === undefined) {
      id = byKey.get(familyKey(font.family)) ?? null;
      nameFamily.set(font.family, id);
    }
    if (id && moreRegular(font, named.get(id))) named.set(id, font);
  }
  const out = new Map<string, LibraryMatch<F>>();
  for (const [id, font] of named) out.set(id, { font, downloaded: false });
  for (const [id, font] of downloaded) out.set(id, { font, downloaded: true });
  return out;
}

// ------------------------------------------------------------------------------ the source

/** Where a row's preview comes from. "name": the name in the interface font. */
export type RowSource = "download" | "library" | "online" | "name";

/**
 * Which source a row uses: a local font while it loads (or has loaded), then online previews if
 * they're on (also when a local file can't be read: online-only, too large, broken), then the
 * name in the interface font.
 */
export function rowSource(o: { match: { downloaded: boolean } | undefined; localFailed: boolean; online: boolean }): RowSource {
  if (o.match && !o.localFailed) return o.match.downloaded ? "download" : "library";
  return o.online ? "online" : "name";
}

/** Whether a row asks for the alphabet file: there's typed text, and the family isn't an icon
 *  font (those keep their icons). */
export const wantsAlphabet = (typed: string, icons: boolean) => typed !== "" && !icons;

// ----------------------------------------------------------------------- the cached files

export const PREVIEW_FILE_KINDS = ["name", "icons", "script", "alphabet"] as const;
export type PreviewFileKind = (typeof PREVIEW_FILE_KINDS)[number];

/** One file in the preview cache, as google_preview's `path` names it. */
export interface PreviewFile {
  id: string;
  /** The family's catalog version (its lastModified, tidied by Rust). */
  token: string;
  kind: PreviewFileKind;
}

const PATH = /^google\/([a-z0-9-]{1,80})\/([0-9A-Za-z-]{1,40})\/([a-z]+)$/;

/** The file a `path` from google_preview names ("google/<id>/<token>/<kind>"), or null for
 *  anything else (never passed to `ff://`). */
export function parsePreviewPath(path: string | undefined): PreviewFile | null {
  const m = path ? PATH.exec(path) : null;
  if (!m || !(PREVIEW_FILE_KINDS as readonly string[]).includes(m[3])) return null;
  return { id: m[1], token: m[2], kind: m[3] as PreviewFileKind };
}

/** The page-only font name for a cached preview file, like `gf-inter_2024-01-02_name`. The
 *  parts are joined with "_", which none of them can hold, so two files never share a name. */
export const remoteFaceName = (f: PreviewFile) => `gf-${f.id}_${f.token}_${f.kind}`;

/** A file's path as google_preview names it, `google/<id>/<token>/<kind>`: what fontLoader
 *  passes to `convertFileSrc(path, "ff")` (which escapes the slashes; Rust undoes that). */
export const previewFilePath = (f: PreviewFile) => `google/${f.id}/${f.token}/${f.kind}`;

/** The key google_preview's answers are kept under for the session. `token`: the catalog's
 *  lastModified, so a family Google updated is asked for again. */
export const answerKey = (id: string, token: string, kind: GooglePreviewKind) => `${id}\n${token}\n${kind}`;

/** How long an "offline" answer (or a call that failed) is kept before the row asks again. Just
 *  past Rust's first pause after network trouble (30 s, on a whole-second clock), so a row asks
 *  once it's over rather than a moment before; during a longer pause, asking costs nothing
 *  (Rust answers "offline" at once, without the network). */
export const RETRY_OFFLINE_MS = 31_000;

/** How long an "off" answer is kept. Rows only ask while the page has previews on, so "off" only
 *  means Rust hadn't saved the switch yet: the page shows a switch at once and saves it a moment
 *  later. Asked again shortly, never kept. */
export const RETRY_OFF_MS = 1_000;

/**
 * Until when (ms since the epoch) an answer is kept. A file, or a family Google can't preview,
 * for the session (Rust remembers failures for longer itself). "offline" and a call that failed:
 * `RETRY_OFFLINE_MS`. "off": a moment (`RETRY_OFF_MS`).
 */
export function keepAnswerUntil(answer: GooglePreview | null, now: number): number {
  if (answer && (answer.state === "ready" || answer.state === "unavailable" || answer.state === "tooLarge")) return Infinity;
  if (answer?.state === "off") return now + RETRY_OFF_MS;
  return now + RETRY_OFFLINE_MS;
}

// --------------------------------------------------------------------------- typed text

/** In the alphabet file: printable ASCII (U+0020–U+007E) or Latin-1 (U+00A0–U+00FF). */
export function inAlphabet(c: string): boolean {
  const cp = c.codePointAt(0) ?? 0;
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff);
}

/** Characters of `text` that the alphabet file doesn't hold, each once, in order. An online
 *  preview can't show them; the font itself may well have them. */
export function outsideAlphabet(text: string): string[] {
  const out: string[] = [];
  for (const c of text) if (!inAlphabet(c) && !out.includes(c)) out.push(c);
  return out;
}

// ---------------------------------------------------------------------- what a row draws

/** What Fontface does after network trouble (Rust pauses previews briefly, then for longer each
 *  time it goes on, up to 15 minutes). */
export const KEEPS_TRYING = "Fontface keeps trying, soon at first and then less often.";

/** Why an online file isn't drawn: google_preview's answer, or "error" for a file that came but
 *  wouldn't load as a font. ("off" isn't one: see `fileStatus`.) */
export type FailReason = "offline" | "unavailable" | "tooLarge" | "error";

export type FileStatus = { kind: "waiting" } | { kind: "loading" } | { kind: "ready" } | { kind: "failed"; why: FailReason };

/** The page font's state, as fontLoader reports it. */
type FaceState = "loading" | "ready" | "error" | "cloud" | "too-large";

/** Where one online file is: no answer yet, its font loading, ready to draw, or not coming. An
 *  "off" answer counts as no answer yet: rows only ask while previews are on, so it only means
 *  Rust hadn't saved the switch when it was asked (it's asked again in a moment). */
export function fileStatus(answer: GooglePreview | undefined, face: FaceState): FileStatus {
  if (!answer || answer.state === "off") return { kind: "waiting" };
  if (answer.state !== "ready") return { kind: "failed", why: answer.state };
  if (!parsePreviewPath(answer.path)) return { kind: "failed", why: "error" };
  if (face === "ready") return { kind: "ready" };
  if (face === "loading") return { kind: "loading" };
  return { kind: "failed", why: face === "too-large" ? "tooLarge" : "error" };
}

export type OnlineChoice = { draw: "row" | "alphabet" } | { draw: "loading" } | { draw: "plain"; why: FailReason };

/**
 * What an online row draws. Typed text draws from the alphabet file once it's ready; until then
 * (and if it never comes) the row keeps its own preview, so one row never mixes fonts. Without
 * typed text, the row's file. While nothing is ready yet: "loading" (hidden briefly, then the
 * name). Nothing coming: the name in the interface font, and why.
 */
export function onlineChoice(row: FileStatus, alphabet?: FileStatus): OnlineChoice {
  if (alphabet?.kind === "ready") return { draw: "alphabet" };
  if (row.kind === "ready") return { draw: "row" };
  if (row.kind === "failed") return { draw: "plain", why: row.why };
  return { draw: "loading" };
}

/**
 * Whether the line under an online row describes the row's file (the family's name, and the
 * badge naming a script sample): once the file is there, while its font loads too, until it
 * fails. Not whether the preview shows yet, which changes as the font loads, so the line stays
 * put meanwhile.
 */
export const describesRowFile = (row: FileStatus) => row.kind === "loading" || row.kind === "ready";

// ------------------------------------------------------------------------- the cache's size

/**
 * Settings' "Clear preview cache" button. The size is a reading that may be out of date (rows on
 * the Google Fonts page underneath keep saving files), so it never disables the button: only a
 * clear in progress does, and clearing an empty cache does nothing.
 */
export function previewCacheButton(bytes: number | null, clearing: boolean): { label: string; disabled: boolean } {
  return { label: bytes ? `Clear preview cache (${formatBytes(bytes)})` : "Clear preview cache", disabled: clearing };
}
