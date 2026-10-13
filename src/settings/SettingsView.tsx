import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/TitleBar";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { SECTION_LIST, SettingGroup, SettingRow, type RowDef, type SectionDef, type SectionId } from "./parts";
import { useSections, type SectionProps } from "./sections";
import { SettingsNav } from "./SettingsNav";
import { useSettings } from "./useSettings";

/** The search field's id, so Cmd+, can focus it while settings are open. */
export const SETTINGS_SEARCH_ID = "settings-search";

const TEXT_INPUTS = new Set(["text", "search", "number", "email", "url", "tel", "password"]);

interface Props extends SectionProps {
  section: SectionId;
  onSection: (id: SectionId) => void;
  onClose: () => void;
}

/** Every term must appear in the row's label, description, extra words or section name. */
function search(sections: SectionDef[], query: string): { section: SectionDef; rows: RowDef[] }[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return sections
    .map((section) => ({
      section,
      rows: section.groups
        .flatMap((g) => g.rows)
        .filter((row) => {
          const text = `${row.label} ${row.description} ${row.keywords ?? ""} ${section.label}`.toLowerCase();
          return terms.every((t) => text.includes(t));
        }),
    }))
    .filter((r) => r.rows.length > 0);
}

/**
 * Settings, inside the main window: it covers the library while open (the library stays as it
 * was underneath). The sidebar becomes the list of sections; the main column shows one
 * section, or search results from all of them. Changes save as they're made.
 *
 * Keys: Esc goes back to the library. In the search field, Esc first clears the search; in any
 * other text box, Esc first leaves the box (which saves it), empty or not. Dialogs and menus on
 * top handle their own Esc.
 */
export function SettingsScreen({ section, onSection, onClose, ...props }: Props) {
  const { settings, error, reload } = useSettings();
  const sections = useSections(props);
  const [query, setQuery] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const searching = query.trim().length > 0;
  const current = sections?.find((s) => s.id === section) ?? sections?.[0];
  const meta = SECTION_LIST.find((s) => s.id === section) ?? SECTION_LIST[0];
  const results = sections && searching ? search(sections, query.trim()) : [];
  const found = results.reduce((sum, r) => sum + r.rows.length, 0);

  // Start in the search field: type to find a setting, or Tab on to the rest.
  useEffect(() => searchBox.current?.focus(), []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [section, searching]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      // Something inside already handled Esc. Except a disabled button that stays focusable
      // (Base UI's focusableWhenDisabled): it blocks every key but Tab, and that isn't handling Esc.
      if (e.defaultPrevented && !target?.matches('[aria-disabled="true"]')) return;
      if (target?.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return;
      // The search field clears its own text first (its onKeyDown); once it's empty, Esc goes back.
      if (target instanceof HTMLInputElement && TEXT_INPUTS.has(target.type) && target.id !== SETTINGS_SEARCH_ID) {
        target.blur();
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const go = (id: SectionId) => {
    setQuery("");
    onSection(id);
  };

  return (
    <div className="absolute inset-0 grid grid-cols-[240px_1fr]">
      <SettingsNav current={section} searching={searching} onSection={go} onBack={onClose} />
      <main aria-label="Settings" className="flex min-h-0 min-w-0 flex-col bg-background">
        <PageHeader icon={searching ? "search" : meta.icon} title={searching ? "Search results" : meta.label}>
          <div className="relative w-56">
            <Icon name="search" size={16} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchBox}
              id={SETTINGS_SEARCH_ID}
              type="search"
              placeholder="Search settings"
              aria-label="Search settings"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) {
                  e.preventDefault();
                  setQuery("");
                }
              }}
              className="pl-8"
            />
          </div>
        </PageHeader>
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[720px] flex-col gap-8 px-8 pt-6 pb-16">
            {!sections || !current ? (
              <div className="flex flex-col items-center gap-3 py-16 text-center text-sm text-muted-foreground">
                {error ? (
                  <>
                    <p>Couldn't load the settings. {error}</p>
                    <Button size="sm" variant="outline" onClick={reload}>
                      Try again
                    </Button>
                  </>
                ) : (
                  <p className="flex items-center gap-2">
                    <Icon name="progress_activity" size={18} className="animate-spin" />
                    Loading…
                  </p>
                )}
              </div>
            ) : searching ? (
              results.length === 0 ? (
                <p className="py-16 text-center text-sm text-muted-foreground">No settings match “{query.trim()}”</p>
              ) : (
                results.map(({ section: s, rows }) => (
                  <SettingGroup key={s.id} id={`search-${s.id}`} title={s.label}>
                    {rows.map((row) => (
                      <SettingRow key={row.id} row={row} />
                    ))}
                  </SettingGroup>
                ))
              )
            ) : (
              <>
                {current.intro && <p className="-mb-2 px-1 text-sm text-muted-foreground">{current.intro}</p>}
                {current.groups.map((group) => (
                  <SettingGroup key={group.id} id={group.id} title={group.title}>
                    {group.rows.map((row) => (
                      <SettingRow key={row.id} row={row} />
                    ))}
                  </SettingGroup>
                ))}
              </>
            )}
          </div>
        </div>
        {/* Screen readers hear how many settings a search found. */}
        <p role="status" className="sr-only">
          {searching && settings ? (found === 1 ? "1 setting found" : `${found} settings found`) : ""}
        </p>
      </main>
    </div>
  );
}
