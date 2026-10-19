import type { FamilyChange, NameRef } from "./api";
import { squash, type NameRule } from "./familyGroups.ts";
import type { Face, Family } from "./library.ts";

/**
 * What the Family groups page and the font page write when you merge, keep separate or clear
 * (families/store.ts saves it). Pure, so `npm run test:ui` covers it with the grouping rules.
 */

/**
 * What merging some families into another writes: a rule for each family name their styles
 * carry (fonts that arrive later follow it), and for styles you'd moved into one of them by
 * hand, a choice that moves them along. A rule written for the name a style shows also holds
 * when another of its copies is shown (familyGroups.placeFace reads every copy's name).
 */
export function mergeEdits(families: readonly Family[]): { names: NameRef[]; faces: string[] } {
  const names = new Map<string, NameRef>();
  const faces: string[] = [];
  for (const family of families)
    for (const face of family.faces) {
      if (face.groupedBy === "choice") faces.push(face.key);
      else names.set(squash(face.primary.family), { nameKey: squash(face.primary.family), name: face.primary.family });
    }
  return { names: [...names.values()], faces };
}

/** `mergeEdits` as a change, for several merges in one ("Merge all suggestions"). */
export function mergeChange(merges: readonly { families: readonly Family[]; into: string }[]): FamilyChange {
  const change: FamilyChange = { faces: [], names: [] };
  for (const { families, into } of merges) {
    const { names, faces } = mergeEdits(families);
    for (const n of names) change.names.push({ nameKey: n.nameKey, set: { name: n.name, decision: "merge", into } });
    for (const key of faces) change.faces.push({ faceKey: key, set: { family: into, style: null } });
  }
  return change;
}

/** The rule key and spelling for keeping a family name separate. */
export const nameRef = (name: string): NameRef => ({ nameKey: squash(name), name });

/**
 * Your rule on a family's own name when none of its styles carries that name: "Keep separate" on
 * a suggestion for a family grouped by name ("AmplitudeComp", from AmplitudeComp-Light and
 * others). It changes no style; it keeps the family out of the suggestions. The Family groups
 * page lists it under Your changes, and Clear my choices forgets it.
 */
export function familyRuleKey(family: Pick<Family, "name" | "faces">, rules: ReadonlyMap<string, NameRule> | undefined): string | undefined {
  const key = squash(family.name);
  if (!rules?.has(key) || family.faces.some((f) => f.ruleKey === key)) return undefined;
  return key;
}

/** The families with a rule of their own (`familyRuleKey`), by name key. */
export function familyRuleKeys(families: readonly Family[], rules: ReadonlyMap<string, NameRule> | undefined): Set<string> {
  const out = new Set<string>();
  if (!rules?.size) return out;
  for (const family of families) {
    const key = familyRuleKey(family, rules);
    if (key) out.add(key);
  }
  return out;
}

/**
 * Faces you changed by a rule or a choice, and the rules behind them: what "Clear my choices"
 * forgets. A rule is the one that placed the face (its own name's, or a copy's); `familyRules`
 * adds the rule of the family a face is listed in, when that rule is the family's own.
 */
export function yourEdits(faces: readonly Face[], familyRules?: ReadonlySet<string>): { faces: string[]; nameKeys: string[] } {
  const keys: string[] = [];
  const names = new Set<string>();
  for (const f of faces) {
    if (f.groupedBy === "choice") keys.push(f.key);
    if (f.groupedBy === "rule") names.add(f.ruleKey ?? squash(f.primary.family));
    const own = squash(f.family);
    if (familyRules?.has(own)) names.add(own);
  }
  return { faces: keys, nameKeys: [...names] };
}
