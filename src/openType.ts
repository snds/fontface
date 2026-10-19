import type { FontFeature, FontScript, PreviewCase } from "./api.ts";
import { previewCase, type FeatureValues } from "./previewStyle.ts";

/**
 * The font page's OpenType tab: plain names for the features a face has, the groups they're
 * listed in, which are on by default, short samples, and what the switches add up to. Also the
 * names of the scripts and languages the font's tables are written for. Pure (no React, no DOM),
 * so `npm run test:ui` covers it. The features themselves come from `fontFacts`
 * (src-tauri/src/facts/layout.rs), so only features the face really has are listed.
 */

export type FeatureGroupId =
  | "ligatures"
  | "capitals"
  | "figures"
  | "fractions"
  | "positions"
  | "alternates"
  | "sets"
  | "variants"
  | "spacing"
  | "language"
  | "vertical"
  | "other";

export const FEATURE_GROUPS: readonly { id: FeatureGroupId; label: string; note?: string }[] = [
  { id: "ligatures", label: "Ligatures" },
  { id: "capitals", label: "Capitals" },
  { id: "figures", label: "Figures" },
  { id: "fractions", label: "Fractions" },
  { id: "positions", label: "Positions", note: "Superscripts, subscripts and ordinals." },
  { id: "alternates", label: "Alternates" },
  { id: "sets", label: "Stylistic sets", note: "Groups of alternate shapes the designer made to go together." },
  { id: "variants", label: "Character variants", note: "Alternate shapes for single characters." },
  { id: "spacing", label: "Spacing" },
  { id: "language", label: "Language and script", note: "Used automatically where a language or script needs them." },
  { id: "vertical", label: "Vertical text", note: "These change only text set vertically, so these previews don't show them." },
  { id: "other", label: "Other" },
];

interface Known {
  name: string;
  group: FeatureGroupId;
  /** On unless turned off (the text engine applies it by itself). */
  on?: boolean;
  /** Text that shows it, when the font can draw it. */
  sample?: string;
  /** Prefer `sample` over the characters the font says it changes. */
  ownSample?: boolean;
}

const LANGUAGE: FeatureGroupId = "language";

/** Registered OpenType features, in Fontface's words. Ones not listed show under Other. */
const KNOWN: Readonly<Record<string, Known>> = {
  liga: { name: "Standard ligatures", group: "ligatures", on: true, sample: "fi fl ff ffi" },
  clig: { name: "Contextual ligatures", group: "ligatures", on: true },
  dlig: { name: "Discretionary ligatures", group: "ligatures", sample: "ct st sp" },
  hlig: { name: "Historical ligatures", group: "ligatures", sample: "ct st" },
  rlig: { name: "Required ligatures", group: LANGUAGE, on: true },

  smcp: { name: "Small capitals", group: "capitals", sample: "Small Caps", ownSample: true },
  c2sc: { name: "Capitals to small capitals", group: "capitals", sample: "CAPITALS", ownSample: true },
  pcap: { name: "Petite capitals", group: "capitals", sample: "Petite Caps", ownSample: true },
  c2pc: { name: "Capitals to petite capitals", group: "capitals", sample: "CAPITALS", ownSample: true },
  unic: { name: "Unicase", group: "capitals", sample: "Unicase", ownSample: true },
  case: { name: "Case-sensitive forms", group: "capitals", sample: "(H-O) [A] «B»", ownSample: true },
  cpsp: { name: "Capital spacing", group: "capitals", sample: "CAPITALS", ownSample: true },
  titl: { name: "Titling capitals", group: "capitals", sample: "TITLING" },

  lnum: { name: "Lining figures", group: "figures", sample: "0123456789", ownSample: true },
  onum: { name: "Old-style figures", group: "figures", sample: "0123456789", ownSample: true },
  pnum: { name: "Proportional figures", group: "figures", sample: "0123456789", ownSample: true },
  tnum: { name: "Tabular figures", group: "figures", sample: "0123456789", ownSample: true },
  zero: { name: "Slashed zero", group: "figures", sample: "0 10 2020", ownSample: true },

  frac: { name: "Fractions", group: "fractions", sample: "1/2 3/4 5/8", ownSample: true },
  afrc: { name: "Stacked fractions", group: "fractions", sample: "1/2 3/4", ownSample: true },
  numr: { name: "Numerators", group: "fractions", sample: "123", ownSample: true },
  dnom: { name: "Denominators", group: "fractions", sample: "123", ownSample: true },

  sups: { name: "Superscript", group: "positions", sample: "x2 m3", ownSample: true },
  subs: { name: "Subscript", group: "positions", sample: "H2O CO2", ownSample: true },
  sinf: { name: "Scientific inferiors", group: "positions", sample: "H2O", ownSample: true },
  ordn: { name: "Ordinals", group: "positions", sample: "1a 2o No", ownSample: true },

  calt: { name: "Contextual alternates", group: "alternates", on: true },
  // Required variation alternates: shapes a variable font swaps at set points along its axes
  // (a $ that loses its bar at heavy weights). Text engines always apply it.
  rvrn: { name: "Alternates for variable styles", group: "alternates", on: true },
  salt: { name: "Stylistic alternates", group: "alternates" },
  swsh: { name: "Swashes", group: "alternates" },
  cswh: { name: "Contextual swashes", group: "alternates" },
  hist: { name: "Historical forms", group: "alternates" },
  ornm: { name: "Ornaments", group: "alternates" },
  nalt: { name: "Annotation forms", group: "alternates" },
  aalt: { name: "All alternates", group: "alternates" },
  rand: { name: "Random alternates", group: "alternates" },
  jalt: { name: "Justification alternates", group: "alternates" },
  falt: { name: "Final glyph on line alternates", group: "alternates" },
  dtls: { name: "Dotless forms", group: "alternates" },
  flac: { name: "Flattened accents", group: "alternates" },
  ital: { name: "Italics", group: "alternates" },
  ssty: { name: "Math script style", group: "alternates" },
  mgrk: { name: "Mathematical Greek", group: "alternates" },

  kern: { name: "Kerning", group: "spacing", on: true, sample: "AVATAR Type", ownSample: true },
  palt: { name: "Proportional widths (East Asian)", group: "spacing" },
  halt: { name: "Half widths (East Asian)", group: "spacing" },
  pwid: { name: "Proportional widths", group: "spacing" },
  fwid: { name: "Full widths", group: "spacing" },
  hwid: { name: "Half widths", group: "spacing" },
  twid: { name: "Third widths", group: "spacing" },
  qwid: { name: "Quarter widths", group: "spacing" },
  opbd: { name: "Optical bounds", group: "spacing" },
  lfbd: { name: "Left bounds", group: "spacing" },
  rtbd: { name: "Right bounds", group: "spacing" },

  locl: { name: "Localized forms", group: LANGUAGE, on: true },
  ccmp: { name: "Glyph composition", group: LANGUAGE, on: true },
  mark: { name: "Mark positioning", group: LANGUAGE, on: true },
  mkmk: { name: "Mark-to-mark positioning", group: LANGUAGE, on: true },
  curs: { name: "Cursive joining", group: LANGUAGE, on: true },
  dist: { name: "Distances", group: LANGUAGE, on: true },
  rclt: { name: "Required contextual alternates", group: LANGUAGE, on: true },
  init: { name: "Initial forms", group: LANGUAGE, on: true },
  medi: { name: "Medial forms", group: LANGUAGE, on: true },
  fina: { name: "Final forms", group: LANGUAGE, on: true },
  isol: { name: "Isolated forms", group: LANGUAGE, on: true },
  med2: { name: "Medial forms 2", group: LANGUAGE, on: true },
  fin2: { name: "Final forms 2", group: LANGUAGE, on: true },
  fin3: { name: "Final forms 3", group: LANGUAGE, on: true },
  stch: { name: "Stretching forms", group: LANGUAGE, on: true },
  mset: { name: "Mark positioning by substitution", group: LANGUAGE, on: true },
  abvm: { name: "Above-base marks", group: LANGUAGE, on: true },
  blwm: { name: "Below-base marks", group: LANGUAGE, on: true },
  abvs: { name: "Above-base substitutions", group: LANGUAGE, on: true },
  blws: { name: "Below-base substitutions", group: LANGUAGE, on: true },
  abvf: { name: "Above-base forms", group: LANGUAGE, on: true },
  blwf: { name: "Below-base forms", group: LANGUAGE, on: true },
  akhn: { name: "Akhand ligatures", group: LANGUAGE, on: true },
  rphf: { name: "Reph forms", group: LANGUAGE, on: true },
  rkrf: { name: "Rakar forms", group: LANGUAGE, on: true },
  pref: { name: "Pre-base forms", group: LANGUAGE, on: true },
  pres: { name: "Pre-base substitutions", group: LANGUAGE, on: true },
  pstf: { name: "Post-base forms", group: LANGUAGE, on: true },
  psts: { name: "Post-base substitutions", group: LANGUAGE, on: true },
  half: { name: "Half forms", group: LANGUAGE, on: true },
  haln: { name: "Halant forms", group: LANGUAGE, on: true },
  vatu: { name: "Vattu variants", group: LANGUAGE, on: true },
  cjct: { name: "Conjunct forms", group: LANGUAGE, on: true },
  nukt: { name: "Nukta forms", group: LANGUAGE, on: true },
  cfar: { name: "Conjunct form after ro", group: LANGUAGE, on: true },
  ljmo: { name: "Leading jamo forms", group: LANGUAGE, on: true },
  vjmo: { name: "Vowel jamo forms", group: LANGUAGE, on: true },
  tjmo: { name: "Trailing jamo forms", group: LANGUAGE, on: true },
  ltra: { name: "Left-to-right alternates", group: LANGUAGE, on: true },
  ltrm: { name: "Left-to-right mirrored forms", group: LANGUAGE, on: true },
  rtla: { name: "Right-to-left alternates", group: LANGUAGE, on: true },
  rtlm: { name: "Right-to-left mirrored forms", group: LANGUAGE, on: true },
  trad: { name: "Traditional forms", group: LANGUAGE },
  smpl: { name: "Simplified forms", group: LANGUAGE },
  tnam: { name: "Traditional name forms", group: LANGUAGE },
  jp78: { name: "JIS78 forms", group: LANGUAGE },
  jp83: { name: "JIS83 forms", group: LANGUAGE },
  jp90: { name: "JIS90 forms", group: LANGUAGE },
  jp04: { name: "JIS2004 forms", group: LANGUAGE },
  expt: { name: "Expert forms (Japanese)", group: LANGUAGE },
  hojo: { name: "Hojo kanji forms", group: LANGUAGE },
  nlck: { name: "NLC kanji forms", group: LANGUAGE },
  hkna: { name: "Horizontal kana alternates", group: LANGUAGE },
  pkna: { name: "Proportional kana", group: LANGUAGE },
  ruby: { name: "Ruby notation forms", group: LANGUAGE },

  vert: { name: "Vertical alternates", group: "vertical" },
  vrt2: { name: "Vertical alternates and rotation", group: "vertical" },
  vrtr: { name: "Vertical alternates for rotation", group: "vertical" },
  vkna: { name: "Vertical kana alternates", group: "vertical" },
  vkrn: { name: "Vertical kerning", group: "vertical" },
  vpal: { name: "Proportional vertical metrics", group: "vertical" },
  vhal: { name: "Alternate vertical half metrics", group: "vertical" },
  valt: { name: "Alternate vertical metrics", group: "vertical" },
};

/** The registered features Fontface has its own words for, in the order the tab lists them. */
export const KNOWN_FEATURE_TAGS: readonly string[] = Object.keys(KNOWN);

/** Features that never draw outside the plain text's ink, or that the text engine applies to
 *  the plain text anyway (so its measurement has them already: liga, calt, rvrn…), so fitting
 *  needs no extra room when they're turned on. Anything else (swashes, alternates, sets…) gets
 *  a little (`featureSlack`). */
const INK_SAFE = new Set([
  "liga", "clig", "calt", "rvrn", "kern", "rlig", "ccmp", "locl", "mark", "mkmk",
  "smcp", "c2sc", "pcap", "c2pc", "unic", "case", "cpsp",
  "lnum", "pnum", "tnum", "zero", "frac", "afrc", "numr", "dnom", "sups", "subs", "sinf", "ordn",
  "pwid", "fwid", "hwid", "twid", "qwid", "palt", "halt", "opbd", "lfbd", "rtbd",
]);

/** How much more room, in em above and below, fitting keeps while such features are on. */
export const FEATURE_SLACK = 0.2;

const setNumber = (tag: string) => /^(ss|cv)\d\d$/.test(tag) ? Number(tag.slice(2)) : null;

/** One feature, ready to list. */
export interface FeatureView {
  tag: string;
  /** The font's own name for it if it has one, else Fontface's. */
  label: string;
  /** What else to say: the kind and tag ("Stylistic set 1 · ss01") or just the tag. */
  detail: string;
  group: FeatureGroupId;
  /** On unless turned off. */
  defaultOn: boolean;
  /** Text that shows it, if there's any the font can draw. */
  sample?: string;
  /** Whether a switch changes the previews (vertical-text features don't). */
  switchable: boolean;
}

/** True if the font can draw every character of `text` (`missing`: printable ASCII it can't). */
const drawable = (text: string, missing: string | undefined) => !missing || ![...text].some((c) => missing.includes(c));

/** A feature as the OpenType tab lists it. `missing`: printable ASCII the font can't draw. */
export function describeFeature(f: FontFeature, missing?: string): FeatureView {
  const tag = f.tag;
  const known = KNOWN[tag];
  const n = setNumber(tag);
  let kind: string | undefined;
  let group: FeatureGroupId = known?.group ?? "other";
  if (n !== null && tag.startsWith("ss")) {
    kind = `Stylistic set ${n}`;
    group = "sets";
  } else if (n !== null) {
    kind = `Character variant ${n}`;
    group = "variants";
  }
  const ours = kind ?? known?.name ?? `Feature “${tag}”`;
  const label = f.name ?? ours;
  const detail = f.name && kind ? `${kind} · ${tag}` : tag;
  const fixed = known?.sample && drawable(known.sample, missing) ? known.sample : undefined;
  const sample = known?.ownSample ? (fixed ?? f.sample) : (f.sample ?? fixed);
  return { tag, label, detail, group, defaultOn: !!known?.on, sample, switchable: group !== "vertical" };
}

/** The sample a feature's row draws, in the View options' case `mode`. Always as it is: a
 *  sample holds the characters its feature changes ("a à á", "fi fl", "Small Caps"), and other
 *  letters would show no change at all. */
export const featureSampleText = (feature: FeatureView, mode: PreviewCase): string | undefined =>
  feature.sample && previewCase(feature.sample, mode, { sample: true });

/** The face's features in their groups (empty groups left out), each group in a steady order:
 *  the order of `KNOWN`, then by tag. */
export function groupFeatures(features: readonly FontFeature[], missing?: string): { id: FeatureGroupId; label: string; note?: string; features: FeatureView[] }[] {
  const order = KNOWN_FEATURE_TAGS;
  const rank = (tag: string) => {
    const i = order.indexOf(tag);
    return i < 0 ? order.length : i;
  };
  const views = features.map((f) => describeFeature(f, missing));
  return FEATURE_GROUPS.map((g) => ({
    ...g,
    features: views.filter((v) => v.group === g.id).sort((a, b) => rank(a.tag) - rank(b.tag) || a.tag.localeCompare(b.tag)),
  })).filter((g) => g.features.length > 0);
}

/** Feature switches the page set, by tag: on or off. A tag that isn't here is as the View
 *  options or the font have it. */
export type Toggles = Readonly<Record<string, boolean>>;

/** Whether a feature is on now: the page's switch, else the View options' features, else the font's default. */
export function isOn(tag: string, defaultOn: boolean, toggles: Toggles, preview: FeatureValues): boolean {
  if (tag in toggles) return toggles[tag];
  if (tag in preview) return preview[tag] === 1;
  return defaultOn;
}

/** The page's switches after one changes. A switch put back to how it would be anyway is
 *  dropped, so Reset has only real changes to undo. */
export function setToggle(toggles: Toggles, tag: string, on: boolean, defaultOn: boolean, preview: FeatureValues): Toggles {
  const without = { ...toggles };
  delete without[tag];
  return isOn(tag, defaultOn, without, preview) === on ? without : { ...without, [tag]: on };
}

/** What the page's previews use: the View options' features, with the page's switches on top. */
export function pageFeatureValues(preview: FeatureValues, toggles: Toggles): FeatureValues {
  const out: Record<string, number> = { ...preview };
  for (const [tag, on] of Object.entries(toggles)) out[tag] = on ? 1 : 0;
  return out;
}

/** Extra room for fitting (in em) while a feature that can draw past the plain ink is on. */
export function featureSlack(values: FeatureValues): number {
  return Object.entries(values).some(([tag, v]) => v === 1 && !INK_SAFE.has(tag)) ? FEATURE_SLACK : 0;
}

// ------------------------------------------------------------------- scripts and languages

/** OpenType script tags that aren't their ISO 15924 code in lowercase. */
const SCRIPT_CODES: Readonly<Record<string, string>> = {
  dev2: "Deva", bng2: "Beng", gjr2: "Gujr", gur2: "Guru", knd2: "Knda", mlm2: "Mlym", ory2: "Orya", tml2: "Taml",
  tel2: "Telu", mym2: "Mymr", kana: "Kana", hani: "Hani", hang: "Hang", jamo: "Jamo", lao: "Laoo", nko: "Nkoo",
  vai: "Vaii", yi: "Yiii", brai: "Brai", byzm: "Zsym", musc: "Zsym", math: "Zmth", xpeo: "Xpeo", xsux: "Xsux",
};

/** The OpenType language tags Fontface can name, as BCP 47 codes (for names and the `lang`
 *  attribute, which turns on a font's localized forms). */
export const OT_LANGUAGES: Readonly<Record<string, string>> = {
  AFK: "af", AMH: "am", ARA: "ar", AZE: "az", BEL: "be", BEN: "bn", BGR: "bg", BOS: "bs", BRE: "br", BRM: "my",
  BSH: "ba", CAT: "ca", CHU: "cv", CRT: "crh", CSY: "cs", DAN: "da", DEU: "de", ELL: "el", ENG: "en", ESP: "es",
  ETI: "et", EUQ: "eu", FAR: "fa", FIN: "fi", FOS: "fo", FRA: "fr", FRI: "fy", GAE: "gd", GAG: "gag", GAL: "gl",
  GRN: "kl", GUA: "gn", GUJ: "gu", HAU: "ha", HEB: "he", HIN: "hi", HRV: "hr", HUN: "hu", HYE: "hy", IND: "id",
  IRI: "ga", IRT: "ga", ISL: "is", ITA: "it", JAN: "ja", KAN: "kn", KAZ: "kk", KGE: "ka", KHM: "km", KIR: "ky",
  KOR: "ko", KUR: "ku", LAO: "lo", LAT: "la", LSM: "smj", LTH: "lt", LVI: "lv", MAH: "mh", MAL: "ml", MAR: "mr",
  MKD: "mk", MLY: "ms", MNG: "mn", MOL: "ro-MD", MTS: "mt", NAV: "nv", NEP: "ne", NLD: "nl", NOR: "nb", NSM: "se",
  NYN: "nn", PAN: "pa", PLK: "pl", PTG: "pt", ROM: "ro", RUS: "ru", SKS: "sms", SKY: "sk", SLV: "sl", SNH: "si",
  SQI: "sq", SRB: "sr", SVE: "sv", SWK: "sw", TAM: "ta", TAT: "tt", TEL: "te", THA: "th", TRK: "tr", UKR: "uk",
  URD: "ur", UZB: "uz", VIT: "vi", WEL: "cy", YAK: "sah", ZHH: "zh-HK", ZHP: "zh", ZHS: "zh-Hans", ZHT: "zh-Hant",
};

let languageNames: Intl.DisplayNames | null | undefined;
let scriptNames: Intl.DisplayNames | null | undefined;

/** A language's name in English ("tr" is "Turkish"), or undefined if there's none. */
export function languageName(code: string): string | undefined {
  languageNames ??= typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["en"], { type: "language", fallback: "none" }) : null;
  try {
    return languageNames?.of(code.replace(/_/g, "-")) ?? undefined;
  } catch {
    return undefined;
  }
}

/** A script's name in English ("latn" is "Latin", "dev2" is "Devanagari"), or the tag. */
export function scriptName(tag: string): string {
  const code = SCRIPT_CODES[tag] ?? (tag.length === 4 ? tag[0].toUpperCase() + tag.slice(1) : tag);
  if (code === "Zmth") return "Math";
  if (code === "Zsym") return "Music";
  scriptNames ??= typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["en"], { type: "script", fallback: "none" }) : null;
  try {
    return scriptNames?.of(code) ?? tag;
  } catch {
    return tag;
  }
}

/** An OpenType language tag's name ("TRK" is "Turkish"), or the tag itself. */
export const otLanguageName = (tag: string) => (OT_LANGUAGES[tag] && languageName(OT_LANGUAGES[tag])) || tag;

/** "Latin (Turkish, Romanian), Cyrillic": the scripts the tables are written for, with the
 *  languages they treat specially. */
export function scriptsLine(scripts: readonly FontScript[]): string {
  return scripts
    .map((s) => {
      const name = scriptName(s.tag);
      const languages = s.languages.map(otLanguageName);
      return languages.length ? `${name} (${languages.join(", ")})` : name;
    })
    .join(", ");
}

/** The languages the font has its own forms for, as choices for the `lang` attribute: each
 *  once, by name. Tags Fontface can't name are left out. */
export function languageChoices(scripts: readonly FontScript[]): { value: string; label: string; tag: string }[] {
  const out = new Map<string, { value: string; label: string; tag: string }>();
  for (const s of scripts)
    for (const tag of s.languages) {
      const value = OT_LANGUAGES[tag];
      const label = value && languageName(value);
      if (value && label && !out.has(value)) out.set(value, { value, label, tag });
    }
  return [...out.values()].sort((a, b) => a.label.localeCompare(b.label));
}
