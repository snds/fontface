import { toast } from "sonner";
import type { Face } from "@/library";
import { IS_MAC } from "@/components/TitleBar";
import {
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import type { Exception } from "./api";
import { setException, useSync } from "./store";

const HERE = IS_MAC ? "On this Mac" : "On this computer";

/** Only fonts with a PostScript name sync (a `file:` key names a path on this computer). */
const syncable = (faces: Face[]) => [...new Set(faces.map((f) => f.key).filter((k) => k.startsWith("ps:")))];

/**
 * "On this Mac: Follow sync / Always on / Never on", for a font's right-click menu. Shown only
 * while sync is on. With several fonts, the current choice is ticked only if they all share it.
 */
export function SyncFontMenuItems({ faces }: { faces: Face[] }) {
  const { status, exceptions } = useSync();
  if (!status?.enabled) return null;
  const keys = syncable(faces);
  const values = new Set<Exception>(keys.map((k) => exceptions.get(k) ?? "follow"));
  const current = values.size === 1 ? [...values][0] : "";
  const choose = (value: Exception) =>
    setException(keys, value).catch((e) => toast.error("Couldn't change that", { description: String(e) }));
  return (
    <>
      <ContextMenuSeparator />
      <ContextMenuSub>
        <ContextMenuSubTrigger disabled={!keys.length} className="data-disabled:pointer-events-none data-disabled:opacity-50">
          <Icon name="sync" size={16} />
          {HERE}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="min-w-52 shadow-lg">
          <ContextMenuRadioGroup value={current} onValueChange={(v) => choose(v as Exception)}>
            <ContextMenuRadioItem value="follow">Follow sync</ContextMenuRadioItem>
            <ContextMenuRadioItem value="on">Always on here</ContextMenuRadioItem>
            <ContextMenuRadioItem value="off">Never on here</ContextMenuRadioItem>
          </ContextMenuRadioGroup>
        </ContextMenuSubContent>
      </ContextMenuSub>
    </>
  );
}
