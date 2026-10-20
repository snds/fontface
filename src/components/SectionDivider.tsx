import { useEffect, useState } from "react";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { CONTEXT, DROPDOWN, Tip, TipItem, type Kit } from "@/components/Tip";
import { dividerLabel, dividerTip, SECTIONS, type MenuLine, type SidebarCommand, type SidebarSection } from "@/sidebar";
import { openMenuFromKeyboard } from "@/tags/menus";

/** The divider's icon button: a square centred on the line, one size up from the rows' icons. */
const ICON_BUTTON =
  "relative flex size-6 shrink-0 items-center justify-center rounded-md leading-none text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground";

/** A menu's lines (sidebar.ts) as items of a dropdown or right-click menu, each with its tooltip. */
export function MenuLines({ kit, lines, run }: { kit: Kit; lines: MenuLine[]; run: (id: SidebarCommand) => void }) {
  const { Separator } = kit;
  return (
    <>
      {lines.map((line, i) =>
        line === "-" ? (
          <Separator key={`-${i}`} />
        ) : (
          <TipItem kit={kit} key={line.id} tip={line.tip} disabled={line.disabled} onClick={() => run(line.id)}>
            <Icon name={line.icon} size={16} />
            {line.label}
          </TipItem>
        ),
      )}
    </>
  );
}

/**
 * The thin line that starts a sidebar section (Sources, Tags), with the section's outlined icon in
 * the middle, as a button. A right-click anywhere on the divider, or Shift-F10, opens the
 * section's menu (`menu`, run by `run`).
 * - `collapsible` (Sources): a click collapses or expands the section (Right expands, then moves
 *   into it; Left collapses), and a collapsed section shows a small arrow beside the icon. While
 *   fonts or tags are dragged (`dragging`), resting on a collapsed divider expands it.
 * - Not collapsible (Tags, always shown): a click opens the same menu.
 * `enter`: where Right goes once the section is open (a selector, within its rows).
 */
export function SectionDivider({
  section,
  open,
  onOpenChange,
  contentId,
  menu,
  run,
  collapsible = true,
  enter = "button",
  dragging = false,
}: {
  section: SidebarSection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The id of the section's rows, which the divider shows and hides. */
  contentId: string;
  menu: MenuLine[];
  run: (id: SidebarCommand) => void;
  collapsible?: boolean;
  enter?: string;
  dragging?: boolean;
}) {
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (!collapsible || open || !dragging || !hovered) return;
    const t = setTimeout(() => onOpenChange(true), 700);
    return () => clearTimeout(t);
  }, [collapsible, open, dragging, hovered, onOpenChange]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (!open) onOpenChange(true);
      else document.getElementById(contentId)?.querySelector<HTMLElement>(enter)?.focus();
    } else if (e.key === "ArrowLeft" && open) {
      e.preventDefault();
      onOpenChange(false);
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger
        className="flex h-7 shrink-0 items-center gap-1 px-2"
        onKeyDown={openMenuFromKeyboard}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        data-section-divider={section}
      >
        <span aria-hidden className="h-px flex-1 bg-sidebar-border" />
        {collapsible ? (
          // Its name is the section's; aria-expanded says whether its rows show.
          <Tip tip={dividerTip(section, { open, collapsible })} shortcut={open ? "Left" : "Right"} contentClassName="max-w-64">
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label={dividerLabel(section)}
              aria-expanded={open}
              aria-controls={open ? contentId : undefined}
              onClick={() => onOpenChange(!open)}
              onKeyDown={onKeyDown}
            >
              <Icon name={SECTIONS[section].icon} size={18} />
              {/* Beside the square, not in it, so the icon stays centred on the line. */}
              {!open && <Icon name="chevron_right" size={14} className="absolute left-full" aria-hidden />}
            </button>
          </Tip>
        ) : (
          <DropdownMenu>
            <Tip tip={dividerTip(section, { open, collapsible })} contentClassName="max-w-64">
              <DropdownMenuTrigger render={<button type="button" className={ICON_BUTTON} aria-label={`${dividerLabel(section)} menu`} />}>
                <Icon name={SECTIONS[section].icon} size={18} />
              </DropdownMenuTrigger>
            </Tip>
            <DropdownMenuContent align="center" className="min-w-48">
              <MenuLines kit={DROPDOWN} lines={menu} run={run} />
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <span aria-hidden className="h-px flex-1 bg-sidebar-border" />
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        <MenuLines kit={CONTEXT} lines={menu} run={run} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
