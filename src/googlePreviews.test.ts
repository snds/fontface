// Run with `npm run test:ui`. How the Google Fonts catalog previews each family (googlePreviews.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answerKey,
  describesRowFile,
  failNote,
  familyKey,
  fileStatus,
  inAlphabet,
  irregularity,
  keepAnswerUntil,
  matchLibrary,
  onlineChoice,
  outsideAlphabet,
  parsePreviewPath,
  previewCacheButton,
  previewFilePath,
  remoteFaceName,
  RETRY_OFF_MS,
  RETRY_OFFLINE_MS,
  rowSource,
  wantsAlphabet,
  yourCopyNote,
  type CatalogRef,
  type MatchFont,
} from "./googlePreviews.ts";
import { darkPaletteCss } from "./colorPalette.ts";

let nextId = 1;
const font = (family: string, path: string, o: Partial<MatchFont> = {}): MatchFont => ({
  id: nextId++,
  family,
  path,
  italic: false,
  weight: 400,
  width: 5,
  ...o,
});
const fam = (id: string, family: string, dir?: string): CatalogRef => ({ id, family, installed: dir ? { dir } : null });

const MANAGED = "/Users/me/Library/Application Support/design.snds.fontface/Services/google";

test("family names match ignoring case, spaces and punctuation", () => {
  assert.equal(familyKey("IBM Plex Sans"), "ibmplexsans");
  assert.equal(familyKey("IBMPlexSans"), familyKey("Ibm-Plex  Sans"));
  assert.equal(familyKey("M PLUS 1p"), "mplus1p");
  assert.notEqual(familyKey("Inter"), familyKey("Inter Tight"));
  assert.equal(familyKey("— . —"), "", "nothing left to compare");
});

test("a family in the library previews from its most regular style", () => {
  const italic = font("Inter", "/fonts/Inter-Italic.ttf", { italic: true });
  const bold = font("Inter", "/fonts/Inter-Bold.ttf", { weight: 700 });
  const light = font("Inter", "/fonts/Inter-Light.ttf", { weight: 300 });
  const condensed = font("Inter", "/fonts/Inter-Cond.ttf", { weight: 300, width: 3 });
  const m = matchLibrary([fam("inter", "Inter")], [italic, bold, condensed, light]);
  assert.deepEqual(m.get("inter"), { font: light, downloaded: false });
  assert.ok(irregularity(italic) > irregularity(bold), "upright before weight");
});

test("the downloaded copy wins over any other copy, whatever its name", () => {
  const mine = font("Roboto", "/Users/me/Fonts/Roboto-Regular.ttf");
  const downloaded = font("Roboto Variable", `${MANAGED}/roboto/Roboto[wdth,wght].ttf`, { weight: 100 });
  const m = matchLibrary([fam("roboto", "Roboto", `${MANAGED}/roboto/`)], [mine, downloaded]);
  assert.deepEqual(m.get("roboto"), { font: downloaded, downloaded: true });
});

test("files deeper in the downloaded folder count, and other folders don't", () => {
  const deep = font("Noto Sans JP", `${MANAGED}/noto-sans-jp/static/NotoSansJP-Regular.ttf`);
  const sibling = font("Noto Sans", `${MANAGED}/noto-sans-jp-old/NotoSans.ttf`);
  const m = matchLibrary([fam("noto-sans-jp", "Noto Sans JP", `${MANAGED}/noto-sans-jp`), fam("noto-sans", "Noto Sans")], [deep, sibling]);
  assert.deepEqual(m.get("noto-sans-jp"), { font: deep, downloaded: true });
  assert.deepEqual(m.get("noto-sans"), { font: sibling, downloaded: false }, "a folder whose name only starts the same isn't it");
});

test("Windows paths work too", () => {
  const f = font("Lato", "C:\\Users\\me\\AppData\\fontface\\google\\lato\\Lato-Regular.ttf");
  const m = matchLibrary([fam("lato", "Lato", "C:\\Users\\me\\AppData\\fontface\\google\\lato")], [f]);
  assert.equal(m.get("lato")?.downloaded, true);
});

test("families with no copy, or only a similar name, aren't matched", () => {
  const m = matchLibrary([fam("inter", "Inter"), fam("lora", "Lora")], [font("Inter Display", "/f/a.ttf"), font("Lorasans", "/f/b.ttf")]);
  assert.equal(m.size, 0);
});

test("ties between equally regular styles go the same way every time", () => {
  const a = font("Lato", "/f/a.ttf");
  const b = font("Lato", "/f/b.ttf");
  assert.equal(matchLibrary([fam("lato", "Lato")], [b, a]).get("lato")?.font, a);
  assert.equal(matchLibrary([fam("lato", "Lato")], [a, b]).get("lato")?.font, a);
});

test("which source a row uses", () => {
  const downloaded = { downloaded: true };
  const library = { downloaded: false };
  assert.equal(rowSource({ match: downloaded, localFailed: false, online: true }), "download");
  assert.equal(rowSource({ match: library, localFailed: false, online: true }), "library");
  assert.equal(rowSource({ match: library, localFailed: false, online: false }), "library", "your own copy never needs the network");
  assert.equal(rowSource({ match: undefined, localFailed: false, online: true }), "online");
  assert.equal(rowSource({ match: undefined, localFailed: false, online: false }), "name");
  assert.equal(rowSource({ match: library, localFailed: true, online: true }), "online", "a copy that won't load");
  assert.equal(rowSource({ match: downloaded, localFailed: true, online: false }), "name");
});

test("typed text asks for the alphabet file, except in icon families", () => {
  assert.equal(wantsAlphabet("", false), false);
  assert.equal(wantsAlphabet("Hello", false), true);
  assert.equal(wantsAlphabet("home", true), false);
});

test("preview paths: only the cache's own form is accepted", () => {
  assert.deepEqual(parsePreviewPath("google/inter/2024-01-02/name"), { id: "inter", token: "2024-01-02", kind: "name" });
  assert.deepEqual(parsePreviewPath("google/material-icons/v42/icons"), { id: "material-icons", token: "v42", kind: "icons" });
  for (const bad of [
    undefined,
    "",
    "google/inter/2024-01-02/other",
    "google/inter/2024-01-02",
    "google/../2024/name",
    "google/inter/../name",
    "google/Inter/2024/name",
    "google/inter/2024/name/extra",
    "/google/inter/2024/name",
    "google/inter/20 24/name",
    "12",
  ]) {
    assert.equal(parsePreviewPath(bad), null, String(bad));
  }
});

test("face names are unambiguous and safe for the dark-palette CSS", () => {
  const a = remoteFaceName({ id: "abc-2024", token: "05", kind: "name" });
  const b = remoteFaceName({ id: "abc", token: "2024-05", kind: "name" });
  assert.notEqual(a, b);
  assert.equal(remoteFaceName({ id: "inter", token: "2024-01-02", kind: "alphabet" }), "gf-inter_2024-01-02_alphabet");
  assert.notEqual(darkPaletteCss(a, "0 rgb(250 250 250 / 1)"), "", "the name is one darkPaletteCss accepts");
});

test("a file's path is the one google_preview gave", () => {
  for (const path of ["google/inter/2024-01-02/name", "google/lycian/v3/script", "google/inter/2024-01-02/alphabet"]) {
    assert.equal(previewFilePath(parsePreviewPath(path)!), path);
  }
});

test("answers are kept per family, catalog version and kind", () => {
  assert.notEqual(answerKey("inter", "2024-01-02", "row"), answerKey("inter", "2024-03-04", "row"));
  assert.notEqual(answerKey("inter", "2024-01-02", "row"), answerKey("inter", "2024-01-02", "alphabet"));
});

test("files and final failures are kept for the session; the rest are asked again", () => {
  const now = 1_000;
  assert.equal(keepAnswerUntil({ state: "ready", path: "google/a/b/name" }, now), Infinity);
  assert.equal(keepAnswerUntil({ state: "unavailable" }, now), Infinity);
  assert.equal(keepAnswerUntil({ state: "tooLarge" }, now), Infinity);
  assert.equal(keepAnswerUntil({ state: "offline" }, now), now + RETRY_OFFLINE_MS);
  assert.equal(keepAnswerUntil(null, now), now + RETRY_OFFLINE_MS, "the call itself failed");
  assert.ok(RETRY_OFFLINE_MS <= 30_000, "no longer than Rust's first pause after network trouble");
});

test("an 'off' answer is asked again in a moment, not kept for a minute, and isn't shown as off", () => {
  // Turning previews on shows at once and saves a moment later: rows on the page underneath can
  // ask before Rust has the new setting, and hear "off".
  const now = 1_000;
  assert.equal(keepAnswerUntil({ state: "off" }, now), now + RETRY_OFF_MS);
  assert.ok(RETRY_OFF_MS <= 2_000);
  // Meanwhile the row waits, as for any answer still to come: no "off in Settings" note.
  assert.deepEqual(fileStatus({ state: "off" }, "loading"), { kind: "waiting" });
  assert.deepEqual(onlineChoice(fileStatus({ state: "off" }, "loading")), { draw: "loading" });
});

test("the alphabet: printable ASCII and Latin-1", () => {
  assert.ok(inAlphabet(" ") && inAlphabet("~") && inAlphabet("A") && inAlphabet("é") && inAlphabet("ÿ") && inAlphabet("\u00a0"));
  assert.ok(!inAlphabet("\u007f") && !inAlphabet("\u0080") && !inAlphabet("\u009f"), "control characters");
  assert.ok(!inAlphabet("Ÿ") && !inAlphabet("ж") && !inAlphabet("€") && !inAlphabet("😀"));
  assert.deepEqual(outsideAlphabet("Café"), []);
  assert.deepEqual(outsideAlphabet("Привет, мир"), ["П", "р", "и", "в", "е", "т", "м"]);
  assert.deepEqual(outsideAlphabet("€5 or €6 😀"), ["€", "😀"], "each once, emoji whole");
});

test("a file's status: answer first, then its font", () => {
  const ready = { state: "ready" as const, path: "google/inter/2024/name" };
  assert.deepEqual(fileStatus(undefined, "loading"), { kind: "waiting" });
  assert.deepEqual(fileStatus({ state: "offline" }, "loading"), { kind: "failed", why: "offline" });
  assert.deepEqual(fileStatus({ state: "tooLarge" }, "loading"), { kind: "failed", why: "tooLarge" });
  assert.deepEqual(fileStatus(ready, "loading"), { kind: "loading" });
  assert.deepEqual(fileStatus(ready, "ready"), { kind: "ready" });
  assert.deepEqual(fileStatus(ready, "error"), { kind: "failed", why: "error" });
  assert.deepEqual(fileStatus(ready, "too-large"), { kind: "failed", why: "tooLarge" });
  assert.deepEqual(fileStatus({ state: "ready", path: "../etc/passwd" }, "ready"), { kind: "failed", why: "error" }, "a path that isn't a preview file");
});

test("what an online row draws, and never two fonts at once", () => {
  const waiting = { kind: "waiting" } as const;
  const loading = { kind: "loading" } as const;
  const ready = { kind: "ready" } as const;
  const offline = { kind: "failed", why: "offline" } as const;
  // No typed text.
  assert.deepEqual(onlineChoice(waiting), { draw: "loading" });
  assert.deepEqual(onlineChoice(loading), { draw: "loading" });
  assert.deepEqual(onlineChoice(ready), { draw: "row" });
  assert.deepEqual(onlineChoice(offline), { draw: "plain", why: "offline" });
  // Typed text: the name preview stays until the alphabet file is ready.
  assert.deepEqual(onlineChoice(ready, waiting), { draw: "row" });
  assert.deepEqual(onlineChoice(ready, loading), { draw: "row" });
  assert.deepEqual(onlineChoice(ready, ready), { draw: "alphabet" });
  assert.deepEqual(onlineChoice(ready, offline), { draw: "row" }, "the alphabet never came: keep the name");
  assert.deepEqual(onlineChoice(offline, ready), { draw: "alphabet" });
  assert.deepEqual(onlineChoice(waiting, loading), { draw: "loading" });
  assert.deepEqual(onlineChoice(offline, offline), { draw: "plain", why: "offline" });
});

test("every failure has a plain explanation", () => {
  for (const why of ["offline", "unavailable", "tooLarge", "error"] as const) assert.ok(failNote(why).endsWith("."));
  assert.ok(!/minutes|minute/.test(failNote("offline")), "no promise about when: the wait grows while Google stays out of reach");
});

test("the line under an online row follows its file, not whether the font has loaded", () => {
  assert.equal(describesRowFile({ kind: "waiting" }), false, "no answer yet");
  assert.equal(describesRowFile({ kind: "loading" }), true, "still loading after the preview's wait: the line stays");
  assert.equal(describesRowFile({ kind: "ready" }), true);
  assert.equal(describesRowFile({ kind: "failed", why: "offline" }), false);
  assert.equal(describesRowFile({ kind: "failed", why: "error" }), false);
  // A ready answer's file: the same whether its font is loading or loaded.
  const ready = { state: "ready" as const, path: "google/inter/2024/name" };
  assert.equal(describesRowFile(fileStatus(ready, "loading")), describesRowFile(fileStatus(ready, "ready")));
});

test("'Your copy' explains itself in words, for hover and screen readers alike", () => {
  const note = yourCopyNote("Inter-Regular.otf");
  assert.ok(note.includes("Inter-Regular.otf") && note.includes("your library") && note.includes("different version"));
  assert.ok(note.endsWith("."));
});

test("the cache's size never disables Clear: only clearing does", () => {
  assert.deepEqual(previewCacheButton(null, false), { label: "Clear preview cache", disabled: false }, "not read yet");
  assert.deepEqual(previewCacheButton(0, false), { label: "Clear preview cache", disabled: false }, "read as empty, maybe a while ago");
  assert.deepEqual(previewCacheButton(4.2 * 1024 * 1024, false), { label: "Clear preview cache (4.2 MB)", disabled: false });
  assert.equal(previewCacheButton(12_345, true).disabled, true);
});
