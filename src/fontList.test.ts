// Run with `npm run test:ui`. Turn On Fonts from a List…: reading the pasted text, and the words
// for what each name found (fontList.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FoundFace, LineMatch } from "./api.ts";
import {
  foundHowText,
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

test("CSS copied from a style sheet gives its families, and nothing else", () => {
  // Tailwind's theme: a custom property for fonts. Its weights and other settings aren't fonts.
  assert.deepEqual(labels(`--font-sans: "Inter", ui-sans-serif, system-ui;`), ["Inter"]);
  assert.deepEqual(labels(`@theme {\n  --font-display: "Fraunces", serif;\n  --font-weight-bold: 700;\n  --color-brand: #ff0000;\n  --font-mono: var(--font-code);\n}`), ["Fraunces"]);
  // The font shorthand: the families come after the size (and line height).
  assert.deepEqual(labels(`font: 700 16px/1.5 "Inter", sans-serif;`), ["Inter"]);
  assert.deepEqual(labels(`font: italic bold 1.2rem / 1.4 'IBM Plex Sans', Georgia, serif`), ["IBM Plex Sans", "Georgia"]);
  assert.deepEqual(labels("font: menu;"), [], "a system font names no family");
  // A copied rule: the selector, braces and other properties give no names.
  assert.deepEqual(labels(`body {\n  font-family: "Inter", sans-serif;\n  color: red;\n}`), ["Inter"]);
  assert.deepEqual(labels(`h1, h2 { font-family: Lora; font-weight: 700; }`), ["Lora"]);
  assert.deepEqual(labels("font-family: Inter; font-weight: 700;"), ["Inter"]);
  assert.deepEqual(labels(`@font-face {\n  font-family: "Söhne";\n  src: url(soehne.woff2) format("woff2");\n}`), ["Söhne"]);
  // A comma inside quotes is part of the name; an apostrophe inside a name isn't a quote.
  assert.deepEqual(labels(`font-family: "Foo, Bar", serif;`), ["Foo, Bar"]);
  assert.deepEqual(labels("Mom's Typewriter, Inter"), ["Mom's Typewriter", "Inter"]);
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
  // An accent as one letter, or as a letter and a separate mark: the same name.
  assert.equal(nameKey("So\u0308hne"), nameKey("S\u00f6hne"));
  assert.equal(nameKey("So\u0308hne"), "s\u00f6hne");
  assert.equal(parseFontList("S\u00f6hne Kr\u00e4ftig\nSo\u0308hne Kra\u0308ftig").repeats, 1);
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
  // A variable font: its family, not its file's own style ("Regular"), which isn't what was asked for.
  const flex = match("namedStyle", [face("Roboto Flex", "Regular", { variable: true })]);
  assert.equal(foundText(flex), "Roboto Flex (variable font)");
  assert.equal(foundHowText(flex), null, "not said twice");
  assert.equal(foundText(match("namedStyle", [face("Fraunces", "Regular", { variable: true }), face("Fraunces", "Italic", { variable: true })])), "Fraunces, 2 variable fonts");
  assert.equal(foundHowText(match("postScript", [styles[1]])), "PostScript name");
  assert.equal(foundHowText(match(null, [])), null);
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

test("a label before a name gives the name; CSS that isn't about fonts gives nothing", () => {
  const names = (text: string) => parseFontList(text).entries.map((e) => e.label);
  assert.deepEqual(names("Headings: Playfair Display\nBody: Inter"), ["Playfair Display", "Inter"]);
  assert.deepEqual(names("Primary: Inter, Secondary: Lora"), ["Inter", "Lora"]);
  assert.deepEqual(names("Body copy: Inter"), ["Inter"]);
  assert.deepEqual(names("color: red;"), []);
  assert.deepEqual(names("margin: 0"), [], "a one-word CSS property, even without a semicolon");
  assert.deepEqual(names('@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap");'), [], "an at-rule");
  assert.deepEqual(names("h1 { font-family: Inter; color: red }"), ["Inter"]);
});
