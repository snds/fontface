import { Icon } from "@/components/ui/icon";
import { ROW_TIP_DELAY, Tip } from "@/components/Tip";
import { dragRegion, IS_MAC, useTitleBar } from "@/components/TitleBar";
import { cn } from "@/lib/utils";
import { SECTION_LIST, type SectionId } from "./parts";

const COMPUTER = IS_MAC ? "Mac" : "computer";

/** What each section holds, for its tooltip in the list. */
const SECTION_TIPS: Record<SectionId, string> = {
  general: "Shows settings for appearance, preview text, opening and Google Fonts",
  library: "Shows settings for folders, family groups and removed fonts",
  sidebar: "Shows settings for what the sidebar lists",
  activation: "Shows settings for how fonts turn on and off",
  sync: `Shows settings for syncing tags and turned-on fonts across your ${COMPUTER}s`,
  purchases: "Shows settings for watching for font purchases",
  backups: "Shows settings for tag backups, and your saved backups",
  about: "Shows the version, the app data folder and resetting settings",
};

const itemClass = (selected: boolean) =>
  cn(
    "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
    selected ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60",
  );

/**
 * The sidebar while settings are open: a way back to the library, then the sections. Same
 * width, color and top strip as the library sidebar, so the window keeps its shape.
 */
export function SettingsNav({
  current,
  searching,
  onSection,
  onBack,
}: {
  current: SectionId;
  /** While searching, results come from every section, so none is marked. */
  searching: boolean;
  onSection: (id: SectionId) => void;
  onBack: () => void;
}) {
  const titleBar = useTitleBar();
  return (
    <aside className="flex min-h-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      {/* macOS: the window buttons sit here, and the strip moves the window (see TitleBar.tsx). */}
      {titleBar && <div className="h-13 shrink-0 select-none" {...dragRegion(true)} />}
      <nav aria-label="Settings" className={cn("flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-2", !titleBar && "pt-3")}>
        <Tip tip="Closes Settings and goes back to the library" shortcut="Esc" side="right">
          <button className={cn(itemClass(false), "text-muted-foreground hover:text-sidebar-foreground")} onClick={onBack}>
            <Icon name="arrow_back" size={18} />
            <span className="flex-1 truncate">Back to library</span>
            <kbd className="font-mono text-[11px]" aria-hidden>
              esc
            </kbd>
          </button>
        </Tip>
        <div>
          <h2 className="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Settings</h2>
          {SECTION_LIST.map((s) => {
            const selected = !searching && s.id === current;
            return (
              // A sidebar row the pointer crosses on its way elsewhere: the row delay.
              <Tip key={s.id} tip={SECTION_TIPS[s.id]} side="right" delay={ROW_TIP_DELAY}>
                <button className={itemClass(selected)} aria-current={selected ? "page" : undefined} onClick={() => onSection(s.id)}>
                  <Icon name={s.icon} size={18} filled={selected} className="text-muted-foreground" />
                  <span className="truncate">{s.label}</span>
                </button>
              </Tip>
            );
          })}
        </div>
      </nav>
    </aside>
  );
}
