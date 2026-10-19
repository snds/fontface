import { toast } from "sonner";
import type { Face } from "@/library";
import { IS_MAC } from "@/components/TitleBar";
import { CONTEXT, TipItem } from "@/components/Tip";
import { ContextMenuRadioGroup, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent } from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import type { Exception } from "./api";
import { setException, useSync } from "./store";

const HERE = IS_MAC ? "On this Mac" : "On this computer";
const THIS = IS_MAC ? "this Mac" : "this computer";

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
  const these = faces.length === 1 ? "this font" : "these fonts";
  const it = faces.length === 1 ? "it" : "them";
  return (
    <>
      <ContextMenuSeparator />
      <ContextMenuSub>
        {/* Greyed out, it still takes the pointer, so its tooltip says why. */}
        <TipItem
          kit={CONTEXT}
          as="SubTrigger"
          disabled={!keys.length}
          tip={keys.length ? `Chooses whether ${these} follow sync on ${THIS}` : `Can't sync: ${faces.length === 1 ? "it has" : "they have"} no PostScript name`}
        >
          <Icon name="sync" size={16} />
          {HERE}
        </TipItem>
        <ContextMenuSubContent className="min-w-52 shadow-lg">
          <ContextMenuRadioGroup value={current} onValueChange={(v) => choose(v as Exception)}>
            <TipItem kit={CONTEXT} as="RadioItem" value="follow" tip={`Turns ${it} on or off here as your synced computers do`}>
              Follow sync
            </TipItem>
            <TipItem kit={CONTEXT} as="RadioItem" value="on" tip={`Keeps ${it} on here, whatever sync says`}>
              Always on here
            </TipItem>
            <TipItem kit={CONTEXT} as="RadioItem" value="off" tip={`Keeps ${it} off here, whatever sync says`}>
              Never on here
            </TipItem>
          </ContextMenuRadioGroup>
        </ContextMenuSubContent>
      </ContextMenuSub>
    </>
  );
}
