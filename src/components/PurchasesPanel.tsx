import { useEffect, useId, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { api, type PurchaseFind, type PurchaseImported, type PurchasesStatus } from "@/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { Tip } from "./Tip";
import { IS_MAC, PageHeader, type PageBack } from "./TitleBar";

interface Props {
  /** Changes when the watcher finds something or an import/removal finishes; the page reloads. */
  version: number;
  /** Purchase operations in progress (owned by the app, so they survive leaving this page). */
  busy: Set<string>;
  onStatus?: (status: PurchasesStatus) => void;
  onImport: (find: PurchaseFind, store: string | null) => Promise<void>;
  onImportPath: (path: string, store: string | null) => Promise<void>;
  /** Swaps a newer download in for the imported purchase in `dir`. */
  onReplace: (find: PurchaseFind, dir: string) => Promise<void>;
  /** `transferred`: the license went to someone else (the download isn't offered again). */
  onRemove: (item: PurchaseImported, transferred?: boolean) => Promise<void>;
  onSubscriptionEnded: (store: string, name: string) => Promise<void>;
  /** Opened with Browse from the Purchases list: Back and the page's heading. */
  back?: PageBack;
}

type Confirm =
  | { kind: "remove"; item: PurchaseImported }
  | { kind: "transferred"; item: PurchaseImported }
  | { kind: "ended"; store: string; name: string };

/** The page a download came from: a host to show, and whether it can be opened (https only). */
const source = (url: string | null) => {
  try {
    if (!url) return null;
    const u = new URL(url);
    return { host: u.hostname.replace(/^www\./, ""), url, openable: u.protocol === "https:" };
  } catch {
    return null;
  }
};

const when = (secs: number) => new Date(secs * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

const list = (items: string[], max = 3) =>
  items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} +${items.length - max} more`;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fileName = (path: string) => path.split(/[/\\]/).pop() || path;
const FILE_BROWSER = IS_MAC ? "Finder" : "File Explorer";

/** File names for a tooltip, one per line: the first dozen, then how many more. */
const fileLines = (files: string[], max = 12) =>
  files.length <= max ? files.join("\n") : `${files.slice(0, max).join("\n")}\n+${files.length - max} more`;

/** What Add to library does, on the button and in the store dialog. */
const ADD_TIP = "Copies these fonts into Fontface, adds them and turns them on";
/** What Remove does once you confirm. */
const REMOVE_TIP = "Turns its fonts off and deletes the copy Fontface made";
/** What I bought it does. */
const BOUGHT_TIP = "Stops marking it as a trial, because you have a license";
/** Why a purchase's buttons are greyed out while something runs on it. */
const ITEM_BUSY = "Wait: Fontface is still working on this purchase";
const SWAPPING = "Wait: Fontface is still swapping in a newer version of it";
const SETTING_BUSY = "Wait: Fontface is still saving the last change";

/** A badge that explains itself on hover; screen readers hear the explanation with it. */
function NoteBadge({ note, children }: { note: string; children: React.ReactNode }) {
  return (
    <Tip tip={note} describe={false} contentClassName="max-w-xs">
      <Badge variant="outline">
        {children}
        <span className="sr-only">. {note}</span>
      </Badge>
    </Tip>
  );
}

function StoreSelect({
  value,
  stores,
  onChange,
  label,
}: {
  value: string;
  stores: PurchasesStatus["stores"];
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <Tip tip="Picks the store these fonts came from, to file them under">
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 rounded-md border bg-background px-2 text-xs"
      >
        <option value="">Store unknown: choose…</option>
        {stores.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
        <option value="other">Other / not listed</option>
      </select>
    </Tip>
  );
}

export function PurchasesPanel({ version, busy, onStatus, onImport, onImportPath, onReplace, onRemove, onSubscriptionEnded, back }: Props) {
  const [status, setStatus] = useState<PurchasesStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  /** Store picked by the user for finds whose store wasn't detected (or to correct it). */
  const [storeChoice, setStoreChoice] = useState<Record<number, string>>({});
  const [importing, setImporting] = useState<{ path: string } | null>(null);
  const [importStore, setImportStore] = useState("");
  // Open state is kept apart from the content, so the text doesn't change while the dialog fades out.
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** A watch setting change is in flight (the switch and folder buttons wait for it). */
  const [settingBusy, setSettingBusy] = useState(false);
  const watchHintId = useId();
  const setting = async (op: () => Promise<unknown>, done?: string) => {
    if (settingBusy) return;
    setSettingBusy(true);
    try {
      await run(op, done);
    } finally {
      setSettingBusy(false);
    }
  };

  const load = async () => {
    try {
      const st = await api.purchasesStatus();
      setStatus(st);
      onStatus?.(st);
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const run = async (op: () => Promise<unknown>, done?: string) => {
    try {
      await op();
      if (done) toast.success(done);
    } catch (e) {
      toast.error(message(e));
    } finally {
      await load();
    }
  };

  const newFinds = status?.finds.filter((f) => f.status === "new") ?? [];
  const tooLarge = newFinds.filter((f) => f.contents.tooLarge);
  const pendingPaths = [...busy].filter((k) => k.startsWith("path:")).map((k) => k.slice(5));
  const reminders = status?.imported.filter((i) => i.trialReminder) ?? [];
  /** Imported purchases with a newer version being swapped in right now. */
  const replacing = new Set(newFinds.filter((f) => f.replaces && busy.has(`path:${f.path}`)).map((f) => f.replaces));
  const boughtIt = (item: PurchaseImported) =>
    run(() => api.purchasesConfirmLicense(item.dir), `${item.label} is no longer marked as a trial`);
  const byStore = useMemo(() => {
    const map = new Map<string, PurchaseImported[]>();
    for (const item of status?.imported ?? []) {
      const list = map.get(item.storeName);
      if (list) list.push(item);
      else map.set(item.storeName, [item]);
    }
    return [...map.entries()];
  }, [status]);

  const pickImport = async (directory: boolean) => {
    const path = await openDialog(
      directory
        ? { directory: true, title: "Import a folder of purchased fonts" }
        : { filters: [{ name: "Fonts or zip", extensions: ["zip", "otf", "ttf", "ttc", "otc"] }], title: "Import purchased fonts" },
    );
    if (typeof path !== "string") return;
    setImportStore((await api.purchasesDetectStore(path).catch(() => null)) ?? "");
    setImporting({ path });
  };

  const addFolder = async () => {
    const path = await openDialog({ directory: true, title: "Watch a folder for font downloads" });
    if (typeof path === "string") setting(() => api.purchasesAddFolder(path));
  };

  const ask = (c: Confirm) => {
    setConfirm(c);
    setConfirmOpen(true);
  };

  if (!status) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader icon="shopping_bag" title="Purchases" back={back} />
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          {error ? (
            <span>Couldn't load purchases. {error}</span>
          ) : (
            <>
              <Icon name="progress_activity" size={18} className="animate-spin" />
              Loading…
            </>
          )}
        </div>
      </div>
    );
  }

  /** What the watch switch does now, or why it's greyed out. */
  const watchTip = settingBusy ? SETTING_BUSY : status.watching ? "Stops watching for font downloads" : "Watches your download folders for fonts you buy";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader icon="shopping_bag" title="Purchases" back={back}>
        <Tip tip="Adds fonts you bought earlier, from a zip or font files">
          <Button size="sm" variant="outline" onClick={() => pickImport(false)}>
            <Icon name="upload_file" size={16} />
            Import zip or fonts…
          </Button>
        </Tip>
        <Tip tip="Adds fonts you bought earlier, from a folder">
          <Button size="sm" variant="outline" onClick={() => pickImport(true)}>
            <Icon name="drive_folder_upload" size={16} />
            Import folder…
          </Button>
        </Tip>
      </PageHeader>
      <div className="flex flex-col gap-3 border-b px-4 py-3">
        <p className="max-w-2xl text-xs text-muted-foreground">
          Fontface notices fonts you download from stores like MyFonts or Fontspring, works out where they came from, and
          adds them to your library when you say so. It copies the desktop font files and any license files it can find
          into a folder it manages, and leaves out web and app font files. Your downloads stay where they are, and nothing
          is uploaded anywhere.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {/* The whole label shows the tooltip (keyboard focus on the switch too). Its words are
              the switch's description. */}
          <Tip tip={watchTip} describe={false}>
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={status.watching}
                disabled={settingBusy}
                onCheckedChange={(on) => setting(() => api.purchasesSetWatching(on), on ? "Watching for font downloads" : undefined)}
                aria-label="Watch for font downloads"
                aria-describedby={watchHintId}
              />
              Watch for font downloads
              <span id={watchHintId} hidden>
                {watchTip}
              </span>
            </label>
          </Tip>
          <Tip
            tip="Looks in your watched folders for new font downloads now"
            disabledReason={checking ? "Wait: Fontface is still checking" : status.folders.length === 0 && "Add a folder to watch first, or turn watching on"}
          >
            <Button
              size="sm"
              variant="outline"
              disabled={checking || status.folders.length === 0}
              focusableWhenDisabled
              className="aria-disabled:opacity-50"
              onClick={async () => {
                setChecking(true);
                await run(async () => {
                  const n = await api.purchasesCheckNow();
                  toast.info(n ? `Found ${n} new font ${n === 1 ? "download" : "downloads"}` : "No new font downloads");
                });
                setChecking(false);
              }}
            >
              <Icon name="refresh" size={16} className={cn(checking && "animate-spin")} />
              Check now
            </Button>
          </Tip>
        </div>
        <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center gap-2">
            <span>Watching:</span>
            {status.folders.length === 0 && <span>no folders yet (turning watching on adds Downloads)</span>}
            {status.folders.map((f) => (
              <span
                key={f.path}
                className={cn(
                  "flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono",
                  f.problem && "border-destructive/50 text-destructive",
                )}
              >
                {/* The whole path, or what's wrong with the folder (also listed below). */}
                <Tip tip={f.problem ?? f.path} describe={false} contentClassName="max-w-sm break-all">
                  <span className="flex items-center gap-1">
                    {f.problem && <Icon name="warning" size={14} />}
                    {fileName(f.path)}
                  </span>
                </Tip>
                {/* Greyed out with aria-disabled, not disabled, so its tooltip still shows;
                    `setting` ignores the click while busy. */}
                <Tip tip="Stops watching this folder for font downloads" disabledReason={settingBusy && SETTING_BUSY}>
                  <button
                    className="rounded-full hover:text-foreground aria-disabled:opacity-50"
                    aria-label={`Stop watching ${f.path}`}
                    aria-disabled={settingBusy || undefined}
                    onClick={() => setting(() => api.purchasesRemoveFolder(f.path))}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </Tip>
              </span>
            ))}
            <Tip tip="Picks another folder to watch for font downloads" disabledReason={settingBusy && SETTING_BUSY}>
              <Button size="xs" variant="ghost" onClick={addFolder} disabled={settingBusy} focusableWhenDisabled className="aria-disabled:opacity-50">
                <Icon name="add" size={14} />
                Add folder
              </Button>
            </Tip>
          </div>
          {status.folders
            .filter((f) => f.problem)
            .map((f) => (
              <p key={f.path} className="text-destructive" role="alert">
                {fileName(f.path)}: {f.problem}
              </p>
            ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <section aria-labelledby="new-downloads" className="border-b px-4 py-3">
          <h3 id="new-downloads" className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            New font downloads · {newFinds.length}
          </h3>
          {tooLarge.map((f) => (
            <p key={f.id} className="mb-2 text-xs text-muted-foreground">
              {f.name} holds too many fonts to treat as one download. Use “Import folder…” if you want to add it.
            </p>
          ))}
          {newFinds.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {status.watching
                ? "Nothing new. Fonts you download will show up here."
                : "Turn on watching, or import a zip or folder of fonts you've already bought."}
            </p>
          )}
          {newFinds.map((find) => {
            const chosen = storeChoice[find.id] ?? find.store ?? "";
            const from = source(find.referrer ?? find.originUrl);
            const key = `path:${find.path}`;
            // A newer version of something already imported (and still filed under the same store).
            const older = find.replaces && chosen === (find.store ?? "") ? status.imported.find((i) => i.dir === find.replaces) : undefined;
            return (
              <div key={find.id} className="flex flex-wrap items-center gap-3 border-b py-2.5 last:border-b-0">
                <Icon
                  name={find.isFolder ? "folder" : find.name.toLowerCase().endsWith(".zip") ? "folder_zip" : "font_download"}
                  size={22}
                  className="text-muted-foreground"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Tip tip={find.path} describe={false} contentClassName="max-w-sm break-all">
                      <span className="truncate text-sm font-medium">{find.contents.families.length ? list(find.contents.families) : find.name}</span>
                    </Tip>
                    {find.contents.trial && (
                      <NoteBadge note="The name suggests trial or demo fonts, which usually aren't licensed for commercial work">Looks like a trial</NoteBadge>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                    <span className="font-mono">{find.name}</span>
                    <span>
                      {find.contents.fonts.length} {find.contents.fonts.length === 1 ? "font" : "fonts"}
                      {find.contents.licenses.length > 0 ? ` · ${find.contents.licenses.length} license` : " · no license file found"}
                    </span>
                    {find.contents.skippedFonts.length > 0 && (
                      <Tip tip={fileLines(find.contents.skippedFonts)} describe={false} contentClassName="max-w-sm break-all whitespace-pre-line">
                        <span>
                          {find.contents.skippedFonts.length} web, app or duplicate files left out
                          <span className="sr-only">: {list(find.contents.skippedFonts, 12)}</span>
                        </span>
                      </Tip>
                    )}
                    {find.contents.unreadable.length > 0 && (
                      <Tip tip={fileLines(find.contents.unreadable)} describe={false} contentClassName="max-w-sm break-all whitespace-pre-line">
                        <span className="text-destructive">
                          {find.contents.unreadable.length} {find.contents.unreadable.length === 1 ? "file" : "files"} couldn't be
                          read
                          <span className="sr-only">: {list(find.contents.unreadable, 12)}</span>
                        </span>
                      </Tip>
                    )}
                    {from &&
                      (from.openable ? (
                        <Tip tip="Opens the page this download came from, in your browser">
                          <button
                            className="underline-offset-2 hover:underline"
                            onClick={() => openUrl(from.url).catch((e) => toast.error(message(e)))}
                          >
                            from {from.host}
                          </button>
                        </Tip>
                      ) : (
                        <span>from {from.host}</span>
                      ))}
                    <span>{when(find.foundAt)}</span>
                    {find.missing && <span className="text-destructive">The download is gone</span>}
                  </div>
                  {older && (
                    <p className="text-xs">
                      Looks like a new version of “{older.label}”, added {when(older.importedAt)}. Replace swaps in the new
                      files and turns the same styles back on.
                    </p>
                  )}
                </div>
                <StoreSelect
                  label={`Store for ${find.name}`}
                  value={chosen}
                  stores={status.stores}
                  onChange={(v) => setStoreChoice((c) => ({ ...c, [find.id]: v }))}
                />
                {older ? (
                  <Tip
                    tip="Swaps in the new files and turns the same styles back on"
                    disabledReason={
                      busy.has(key)
                        ? "Wait: Fontface is still swapping in this version"
                        : busy.has(`dir:${older.dir}`)
                          ? `Wait: Fontface is still working on “${older.label}”`
                          : find.missing && "The download is gone, so there's nothing to swap in. Dismiss it."
                    }
                  >
                    <Button
                      size="sm"
                      disabled={busy.has(key) || busy.has(`dir:${older.dir}`) || find.missing}
                      focusableWhenDisabled
                      className="aria-disabled:opacity-50"
                      aria-label={`Replace ${older.label} with ${find.name}`}
                      onClick={() => run(() => onReplace(find, older.dir))}
                    >
                      {busy.has(key) ? (
                        <Icon name="progress_activity" size={16} className="animate-spin" />
                      ) : (
                        <Icon name="swap_horiz" size={16} />
                      )}
                      Replace
                    </Button>
                  </Tip>
                ) : (
                  <Tip
                    tip={ADD_TIP}
                    disabledReason={
                      busy.has(key) ? "Wait: Fontface is still adding these fonts" : find.missing && "The download is gone, so there's nothing to add. Dismiss it."
                    }
                  >
                    <Button
                      size="sm"
                      disabled={busy.has(key) || find.missing}
                      focusableWhenDisabled
                      className="aria-disabled:opacity-50"
                      aria-label={`Add ${find.name} to the library`}
                      onClick={() => run(() => onImport(find, chosen || null))}
                    >
                      {busy.has(key) ? <Icon name="progress_activity" size={16} className="animate-spin" /> : <Icon name="add" size={16} />}
                      Add to library
                    </Button>
                  </Tip>
                )}
                <Tip tip="Takes this download off the list. The file stays where it is.">
                  <Button size="sm" variant="ghost" aria-label={`Dismiss ${find.name}`} onClick={() => run(() => api.purchasesDismiss(find.id))}>
                    Dismiss
                  </Button>
                </Tip>
              </div>
            );
          })}
        </section>

        {reminders.length > 0 && (
          <section aria-labelledby="reminders" className="border-b px-4 py-3">
            <h3 id="reminders" className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Reminders · {reminders.length}
            </h3>
            {reminders.map((item) => (
              <div key={item.dir} className="flex flex-wrap items-center gap-3 border-b py-2.5 last:border-b-0">
                <Icon name="schedule" size={22} className="text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{item.label} may be a trial</div>
                  <p className="text-xs text-muted-foreground">
                    Added from {item.storeName} on {when(item.importedAt)}. Trial fonts usually can't be used for paid work.
                    If you bought a license, say so. If not, remove it.
                  </p>
                </div>
                <Tip tip={BOUGHT_TIP} disabledReason={busy.has(`dir:${item.dir}`) && ITEM_BUSY}>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy.has(`dir:${item.dir}`)}
                    focusableWhenDisabled
                    className="aria-disabled:opacity-50"
                    onClick={() => boughtIt(item)}
                  >
                    <Icon name="check" size={16} />I bought it
                  </Button>
                </Tip>
                <Tip tip={`${REMOVE_TIP}, after asking`} disabledReason={busy.has(`dir:${item.dir}`) ? ITEM_BUSY : replacing.has(item.dir) && SWAPPING}>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${item.label}`}
                    disabled={busy.has(`dir:${item.dir}`) || replacing.has(item.dir)}
                    focusableWhenDisabled
                    className="aria-disabled:opacity-50"
                    onClick={() => ask({ kind: "remove", item })}
                  >
                    Remove
                  </Button>
                </Tip>
              </div>
            ))}
          </section>
        )}

        <section aria-labelledby="in-library" className="px-4 py-3">
          <h3 id="in-library" className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            In your library · {status.imported.length}
          </h3>
          {pendingPaths.map((p) => (
            <div key={p} className="flex items-center gap-2 border-b py-2 text-sm text-muted-foreground" role="status">
              <Icon name="progress_activity" size={16} className="animate-spin" />
              {newFinds.some((f) => f.path === p && replacing.has(f.replaces)) ? "Updating" : "Adding"} {fileName(p)}…
            </div>
          ))}
          {status.imported.length === 0 && pendingPaths.length === 0 && (
            <p className="text-sm text-muted-foreground">No purchases added yet.</p>
          )}
          {byStore.map(([storeName, items]) => {
            const subscription = items.find((i) => i.subscriptionBound);
            const storeBusy =
              !!subscription && (busy.has(`store:${subscription.store}`) || items.some((i) => busy.has(`dir:${i.dir}`)));
            return (
              <div key={storeName} className="mb-4">
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-sm font-semibold">{storeName}</span>
                  <span className="text-xs text-muted-foreground">{items.length}</span>
                  {subscription && (
                    <Tip
                      tip={`Removes your ${storeName} subscription fonts, after asking`}
                      disabledReason={storeBusy && `Wait: Fontface is still working on your ${storeName} fonts`}
                    >
                      <Button
                        size="xs"
                        variant="ghost"
                        className="ml-auto aria-disabled:opacity-50"
                        disabled={storeBusy}
                        focusableWhenDisabled
                        onClick={() => ask({ kind: "ended", store: subscription.store, name: storeName })}
                      >
                        {busy.has(`store:${subscription.store}`) && <Icon name="progress_activity" size={14} className="animate-spin" />}
                        My {storeName} subscription ended…
                      </Button>
                    </Tip>
                  )}
                </div>
                {items.map((item) => {
                  const itemBusy = busy.has(`dir:${item.dir}`) || storeBusy || replacing.has(item.dir);
                  const busyReason = replacing.has(item.dir) ? SWAPPING : ITEM_BUSY;
                  return (
                    <div key={item.dir} className="flex flex-wrap items-center gap-2 border-b py-2 last:border-b-0">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm">{item.label}</span>
                          {item.subscriptionBound && <NoteBadge note="The license ends with your subscription">Subscription</NoteBadge>}
                          {item.mayBeTrial && <NoteBadge note="Trial fonts usually aren't licensed for commercial work">May be a trial</NoteBadge>}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {item.fontFiles} {item.fontFiles === 1 ? "font file" : "font files"} · added {when(item.importedAt)} ·{" "}
                          {item.licenseFiles.length ? `license: ${list(item.licenseFiles, 2)}` : "no license file was included"}
                        </div>
                      </div>
                      <Tip tip={`Shows the copy Fontface made, in ${FILE_BROWSER}`}>
                        <Button
                          size="xs"
                          variant="ghost"
                          aria-label={`Show ${item.label} in ${FILE_BROWSER}`}
                          onClick={() => api.purchasesReveal(item.dir).catch((e) => toast.error(message(e)))}
                        >
                          <Icon name="folder_open" size={14} />
                          Show
                        </Button>
                      </Tip>
                      {item.mayBeTrial && (
                        <Tip tip={BOUGHT_TIP} disabledReason={itemBusy && busyReason}>
                          <Button
                            size="xs"
                            variant="ghost"
                            aria-label={`I bought ${item.label}`}
                            disabled={itemBusy}
                            focusableWhenDisabled
                            className="aria-disabled:opacity-50"
                            onClick={() => boughtIt(item)}
                          >
                            <Icon name="check" size={14} />I bought it
                          </Button>
                        </Tip>
                      )}
                      <Tip tip="Removes these fonts, after asking, because you passed the license on" disabledReason={itemBusy && busyReason}>
                        <Button
                          size="xs"
                          variant="ghost"
                          aria-label={`Mark ${item.label} as transferred`}
                          disabled={itemBusy}
                          focusableWhenDisabled
                          className="aria-disabled:opacity-50"
                          onClick={() => ask({ kind: "transferred", item })}
                        >
                          <Icon name="move_item" size={14} />
                          License transferred…
                        </Button>
                      </Tip>
                      <Tip tip={`${REMOVE_TIP}, after asking`} disabledReason={itemBusy && busyReason}>
                        <Button
                          size="xs"
                          variant="ghost"
                          aria-label={`Remove ${item.label}`}
                          disabled={itemBusy}
                          focusableWhenDisabled
                          className="aria-disabled:opacity-50"
                          onClick={() => ask({ kind: "remove", item })}
                        >
                          <Icon name="delete" size={14} />
                          Remove
                        </Button>
                      </Tip>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </section>
      </div>

      {/* Picking the store for a manual import. */}
      <AlertDialog open={importing !== null} onOpenChange={(o) => !o && setImporting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Where are these fonts from?</AlertDialogTitle>
            <AlertDialogDescription>
              Fontface files purchases by store, and keeps their license with them.
              {importStore ? " The store was read from the download." : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <StoreSelect label="Store" value={importStore} stores={status.stores} onChange={setImportStore} />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Tip tip={ADD_TIP}>
              <AlertDialogAction
                onClick={() => {
                  if (importing) run(() => onImportPath(importing.path, importStore || null));
                  setImporting(null);
                }}
              >
                Add to library
              </AlertDialogAction>
            </Tip>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onOpenChangeComplete={(o) => {
          if (!o) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "remove"
                ? `Remove “${confirm.item.label}”?`
                : confirm?.kind === "transferred"
                  ? `Mark “${confirm.item.label}” as transferred?`
                  : `Remove all ${confirm?.kind === "ended" ? confirm.name : ""} fonts?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "remove"
                ? "Its fonts are turned off and the copy Fontface made is deleted. Your original download isn't touched."
                : confirm?.kind === "transferred"
                  ? "Use this when you've passed the license on to someone else, so you can't keep using these fonts. They're turned off and the copy Fontface made is deleted. Fontface won't offer this download again. Your original download isn't touched."
                  : "Fonts from this subscription may only be used while it's active. They'll be turned off and the copies Fontface made deleted."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Tip
              tip={
                confirm?.kind === "transferred"
                  ? "Removes these fonts, and doesn't offer this download again"
                  : confirm?.kind === "ended"
                    ? "Turns these fonts off and deletes the copies Fontface made"
                    : REMOVE_TIP
              }
            >
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  const c = confirm;
                  setConfirmOpen(false);
                  if (c?.kind === "remove") run(() => onRemove(c.item), `Removed ${c.item.label}`);
                  if (c?.kind === "transferred") run(() => onRemove(c.item, true), `Removed ${c.item.label}`);
                  if (c?.kind === "ended") run(() => onSubscriptionEnded(c.store, c.name));
                }}
              >
                {confirm?.kind === "transferred" ? "Turn off and remove" : "Remove"}
              </AlertDialogAction>
            </Tip>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
