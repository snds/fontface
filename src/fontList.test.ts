// Run with `npm run test:ui`. Turn On Fonts from a List…: reading the pasted text, and the words
// for what each name found (fontList.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FoundFace, LineMatch } from "./api.ts";
import {
  foundText,
  MAX_NAMES,
  nameKey,
  notFoundText,
  parseFontList,
  rowStatus,
  statusText,
  summarize,
  summaryText,
  type FaceLookup,
  type FaceState,
} from "./fontList.ts";

const labels = (text: string) => parseFontList(text).entries.map((e) => e.label);

test("one name per line, as written, without empty lines, bullets or spaces around them", () => {
  assert.deepEqual(labels("Inter-Bold\n\n  Helvetica Neue Light  \r\n- IBM Plex Sans SemiBold Italic\n• Lora\n2. Fraunces\n"), [
    "Inter-Bold",
    "Helvetica Neue Light",
    "IBM Plex Sans SemiBold Italic",
    "Lora",
    "Fraunces",
  ]);
  assert.deepEqual(parseFontList("").entries, []);
  assert.deepEqual(parseFontList(" \n \n").entries, []);
});

test("commas, semicolons and CSS font-family lists give one name each, without CSS's own words", () => {
  assert.deepEqual(labels(`font-family: "Inter", 'Helvetica Neue', sans-serif;`), ["Inter", "Helvetica Neue"]);
  assert.deepEqual(labels(`"Inter Display", system-ui, -apple-system, BlinkMacSystemFont !important`), ["Inter Display"]);
  assert.deepEqual(labels("Inter; Lora, Fraunces"), ["Inter", "Lora", "Fraunces"]);
  // Quoted, a CSS word is a family name.
  assert.deepEqual(labels(`"Fantasy", fantasy`), ["Fantasy"]);
  // Curly quotes from a document.
  assert.deepEqual(labels("“Inter”, ‘Lora’"), ["Inter", "Lora"]);
});

test("a line from a table gives its first column; punctuation alone isn't a name", () => {
  assert.deepEqual(labels("Inter-Bold\tHeadings, Clients/Acme\nLora\t\n---\n;;\n"), ["Inter-Bold", "Lora"]);
});

test("each name is looked up once, however it's spaced or spelt in capitals", () => {
  const list = parseFontList("Inter Bold\ninter bold\nINTER-BOLD\nLora\nInter Bold");
  assert.deepEqual(
    list.entries.map((e) => e.label),
    ["Inter Bold", "Lora"],
  );
  assert.equal(list.repeats, 3);
  assert.equal(nameKey("Inter-Bold™"), "interbold");
});

test("text lines go to the matcher as they are", () => {
  assert.deepEqual(
    parseFontList("Inter-Bold\nLora Italic").entries.map((e) => e.line),
    ["Inter-Bold", "Lora Italic"],
  );
});

test("JSON pasted whole: the fonts list, or the list alone, each font by family, style and PostScript name", () => {
  const json = JSON.stringify({
    fonts: [
      { family: "Inter", style: "Bold" },
      { family: "Lora", style: "Italic", postscriptName: "Lora-Italic" },
      { postscriptName: "Fraunces-Black" },
      { family: "Roboto Flex" },
      { style: "Bold" },
      { family: "  " },
      "IBM Plex Mono",
      42,
      null,
    ],
  });
  const list = parseFontList(`\n  ${json}\n`);
  assert.equal(list.badJson, false);
  assert.deepEqual(
    list.entries.map((e) => e.label),
    ["Inter Bold", "Lora Italic", "Fraunces-Black", "Roboto Flex", "IBM Plex Mono"],
  );
  assert.deepEqual(
    list.entries.map((e) => e.line),
    [
      { family: "Inter", style: "Bold" },
      { family: "Lora", style: "Italic", postscriptName: "Lora-Italic" },
      { postscriptName: "Fraunces-Black" },
      { family: "Roboto Flex" },
      "IBM Plex Mono",
    ],
  );
  assert.deepEqual(labels(`[{"family":"Inter","style":"Bold"},{"family":"Inter","style":"bold"}]`), ["Inter Bold"]);
  // "postScriptName" is read too.
  assert.deepEqual(parseFontList(`[{"postScriptName":"Inter-Bold"}]`).entries[0].line, { postscriptName: "Inter-Bold" });
});

test("part of a JSON list is reported, not read as names; other text in brackets is read as lines", () => {
  const cut = parseFontList(`{"fonts": [{"family": "Inter", "style": "Bold"},`);
  assert.equal(cut.badJson, true);
  assert.deepEqual(cut.entries, []);
  assert.equal(parseFontList(`{"something": 1}`).badJson, true, "JSON without a fonts list");
  const brackets = parseFontList("[Inter]\nLora");
  assert.equal(brackets.badJson, false);
  assert.deepEqual(
    brackets.entries.map((e) => e.label),
    ["[Inter]", "Lora"],
  );
});

test("at most MAX_NAMES names are looked up; the rest are counted", () => {
  const text = Array.from({ length: MAX_NAMES + 7 }, (_, i) => `Font ${i}`).join("\n");
  const list = parseFontList(text);
  assert.equal(list.entries.length, MAX_NAMES);
  assert.equal(list.over, 7);
});

// ------------------------------------------------------------------------- what it found

let nextId = 1;
function face(family: string, style: string, more: Partial<FoundFace> = {}): FoundFace {
  const ps = `${family.replace(/ /g, "")}-${style.replace(/ /g, "")}`;
  return { key: `ps:${ps}|static|r`, family, style, postscriptName: ps, ids: [nextId++], variable: false, italic: false, installed: false, onlineOnly: false, ...more };
}

const match = (how: LineMatch["how"], faces: FoundFace[], near: string[] = []): LineMatch => ({ how, faces, near });

/** The library's state for these keys; others aren't in the list on screen. */
const states = (entries: Record<string, FaceState>): FaceLookup => (key) => entries[key];

test("a row is on, off, partly on, or not found; macOS Fonts count as on", () => {
  const bold = face("Inter", "Bold");
  const regular = face("Inter", "Regular");
  const system = face("Helvetica", "Regular", { installed: true });
  const state = states({ [bold.key]: { active: true, installed: false }, [regular.key]: { active: false, installed: false }, [system.key]: { active: false, installed: true } });
  assert.equal(rowStatus(match("postScript", [bold]), state), "on");
  assert.equal(rowStatus(match("postScript", [regular]), state), "off");
  assert.equal(rowStatus(match("family", [bold, regular]), state), "some");
  assert.equal(rowStatus(match(null, [], ["Inter"]), state), "notFound");
  assert.equal(statusText(match("family", [bold, regular]), state), "1 of 2 on");
  assert.equal(statusText(match("postScript", [system]), state), "On in macOS Fonts");
  assert.equal(statusText(match("postScript", [bold]), state), "On");
  assert.equal(statusText(match(null, []), state), "Not found");
  // Not in the list on screen (yet): what the matcher said.
  assert.equal(rowStatus(match("postScript", [face("Lora", "Regular", { installed: true })]), states({})), "on");
  const cloud = face("Mono", "Regular", { onlineOnly: true });
  assert.equal(statusText(match("postScript", [cloud]), states({})), "Off, online-only");
});

test("what a row found, in a few words, or the closest names", () => {
  const styles = [face("Inter", "Regular"), face("Inter", "Bold"), face("Inter", "Black")];
  assert.equal(foundText(match("family", styles)), "Inter, 3 styles");
  assert.equal(foundText(match("family", styles.slice(0, 1))), "Inter, 1 style");
  assert.equal(foundText(match("postScript", [styles[1]])), "Inter Bold");
  assert.equal(foundText(match("postScript", [styles[1], face("Inter", "Bold")])), "Inter Bold and 1 other");
  assert.equal(foundText(match("namedStyle", [face("Roboto Flex", "Regular", { variable: true })])), "Roboto Flex Regular (variable)");
  assert.equal(foundText(match(null, [], ["Inter Bold", "Inter Black"])), "Closest: Inter Bold, Inter Black");
  assert.equal(foundText(match(null, [])), "");
});

test("the summary counts names, styles once each, and what Turn On would turn on", () => {
  const bold = face("Inter", "Bold");
  const regular = face("Inter", "Regular");
  const lora = face("Lora", "Regular", { onlineOnly: true });
  const state = states({ [bold.key]: { active: true, installed: false } });
  const matches = [match("postScript", [bold]), match("family", [bold, regular]), match("postScript", [lora]), match(null, [], ["Inter"])];
  const s = summarize(matches, state);
  assert.equal(s.names, 4);
  assert.equal(s.found, 3);
  assert.equal(s.notFound, 1);
  assert.deepEqual(
    s.faces.map((f) => f.key),
    [bold.key, regular.key, lora.key],
  );
  assert.deepEqual(
    s.off.map((f) => f.key),
    [regular.key, lora.key],
  );
  assert.equal(s.downloads, 1);
  assert.equal(summaryText(s), "4 names: 3 found (3 styles, 2 off), 1 not found");
  assert.equal(summaryText(summarize([match("postScript", [bold])], state)), "1 name: all found (1 style, all on)");
  assert.equal(summaryText(summarize([match("postScript", [regular])], state)), "1 name: all found (1 style, all off)");
  assert.equal(summaryText(summarize([match(null, [])], state)), "1 name: none found");
  assert.equal(summaryText(summarize([], state)), "");
});

test("Copy Not Found copies the names that found nothing, as the list gave them", () => {
  const list = parseFontList("Inter-Bold\nIntr\n“Lorra”");
  const matches = [match("postScript", [face("Inter", "Bold")]), match(null, [], ["Inter"]), match(null, [])];
  assert.equal(notFoundText(list.entries, matches), "Intr\nLorra");
  // Before the answers are back, nothing.
  assert.equal(notFoundText(list.entries, []), "");
});
