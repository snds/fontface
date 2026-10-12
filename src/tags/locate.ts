import { ask, open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import type { Folder } from "@/api";
import { tagsApi } from "./api";
import { reload } from "./store";

/**
 * "Locate…" for a folder that was moved or renamed: pick where it is now. Its fonts, their
 * on/off state, tags and colors move with it. If none of its fonts are in the folder picked,
 * this asks before using it anyway. Returns true when the folder now points at the new place;
 * the caller then rescans it.
 */
export async function locateFolder(folder: Folder): Promise<boolean> {
  const path = await open({ directory: true, multiple: false, title: `Where is “${folder.label}” now?` });
  if (typeof path !== "string") return false;
  try {
    let r = await tagsApi.relocateFolder(folder.id, path, false);
    if (!r.moved) {
      const ok = await ask(
        `None of the fonts from “${folder.label}” are in that folder. Use it anyway? Fonts that aren't there leave the library at the next scan; their tags are kept.`,
        { title: "Use this folder?", kind: "warning", okLabel: "Use Folder", cancelLabel: "Cancel" },
      );
      if (!ok) return false;
      r = await tagsApi.relocateFolder(folder.id, path, true);
    }
    // Tags kept by file and location colors moved with it.
    await reload().catch(() => {});
    toast.success(`Found “${folder.label}”`, {
      description:
        r.checked && r.found < r.checked
          ? `${r.found.toLocaleString()} of the ${r.checked.toLocaleString()} fonts checked are there. Rescanning to catch the rest of the changes.`
          : "Rescanning to catch any changes.",
    });
    return true;
  } catch (e) {
    toast.error("Couldn't use that folder", { description: String(e) });
    return false;
  }
}
