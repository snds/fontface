import { useEffect, useState } from "react";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import { CONTEXT, Tip, TipItem, type Kit } from "@/components/Tip";
import { dividerLabel, dividerTip, SECTIONS, type MenuLine, type SidebarCommand, type SidebarSection } from "@/sidebar";
import { openMenuFromKeyboard } from "@/tags/menus";

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
 * the middle. The icon is a button: a click collapses or expands the section (Right expands, then
 * moves into it; Left collapses), and a right-click anywhere on the divider, or Shift-F10, opens
 * the section's menu (`menu`, run by `run`). A collapsed section adds a small arrow to the icon.
 * `after`: what sits beside the icon (the Tags divider's (i)). `enter`: where Right goes once the
 * section is open (a selector, within its rows). While fonts or tags are dragged
 * (`dragging`), resting on a collapsed divider expands it, so its rows can be reached.
 */
export function SectionDivider({
  section,
  open,
  onOpenChange,
  contentId,
  menu,
  run,
  after,
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
  after?: React.ReactNode;
  enter?: string;
  dragging?: boolean;
}) {
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (open || !dragging || !hovered) return;
    const t = setTimeout(() => onOpenChange(true), 700);
    return () => clearTimeout(t);
  }, [open, dragging, hovered, onOpenChange]);

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
        className="flex h-6 shrink-0 items-center gap-1 px-2"
        onKeyDown={openMenuFromKeyboard}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        data-section-divider={section}
      >
        <span aria-hidden className="h-px flex-1 bg-sidebar-border" />
        {/* Its name is the section's; aria-expanded says whether its rows show. */}
        <Tip tip={dividerTip(section, open)} shortcut={open ? "Left" : "Right"} contentClassName="max-w-64">
          <button
            type="button"
            className="flex h-5 items-center rounded-md px-1 text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
            aria-label={dividerLabel(section)}
            aria-expanded={open}
            aria-controls={open ? contentId : undefined}
            onClick={() => onOpenChange(!open)}
            onKeyDown={onKeyDown}
          >
            <Icon name={SECTIONS[section].icon} size={16} />
            {!open && <Icon name="chevron_right" size={14} className="-mr-0.5" />}
          </button>
        </Tip>
        {after}
        <span aria-hidden className="h-px flex-1 bg-sidebar-border" />
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        <MenuLines kit={CONTEXT} lines={menu} run={run} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
