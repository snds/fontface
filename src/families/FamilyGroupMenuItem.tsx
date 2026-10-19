import type { Face } from "@/library";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import { useOpenFamilyGroups } from "./store";

/** "Family Group…" in a font's right-click menu: the Family groups page, with these styles checked. */
export function FamilyGroupMenuItem({ faces, returnTo }: { faces: Face[]; returnTo?: string | null }) {
  const open = useOpenFamilyGroups();
  if (!faces.length) return null;
  return (
    <>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => open(faces, { returnTo })}>
        <Icon name="account_tree" size={16} />
        Family Group…
      </ContextMenuItem>
    </>
  );
}
