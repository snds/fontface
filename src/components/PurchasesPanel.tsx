import { useEffect, useMemo, useState } from "react";
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
  );
}

export function PurchasesPanel({ version, busy, onStatus, onImport, onImportPath, onReplace, onRemove, onSubscriptionEnded }: Props) {
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
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-col gap-3 border-b px-4 py-3">
        <div className="flex items-start gap-3">
          <Icon name="shopping_bag" size={22} className="mt-0.5 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">Purchases</h2>
            <p className="max-w-2xl text-xs text-muted-foreground">
              Fontface notices fonts you download from stores like MyFonts or Fontspring, works out where they came
              from, and adds them to your library when you say so. It copies the desktop font files and any license
              files it can find into a folder it manages, and leaves out web and app font files. Your downloads stay
              where they are, and nothing is uploaded anywhere.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={status.watching}
              disabled={settingBusy}
              onCheckedChange={(on) => setting(() => api.purchasesSetWatching(on), on ? "Watching for font downloads" : undefined)}
              aria-label="Watch for font downloads"
            />
            Watch for font downloads
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={checking || status.folders.length === 0}
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
          <Button size="sm" variant="outline" onClick={() => pickImport(false)}>
            <Icon name="upload_file" size={16} />
            Import zip or fonts…
          </Button>
          <Button size="sm" variant="outline" onClick={() => pickImport(true)}>
            <Icon name="drive_folder_upload" size={16} />
            Import folder…
          </Button>
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
                title={f.problem ?? f.path}
              >
                {f.problem && <Icon name="warning" size={14} />}
                {fileName(f.path)}
                <button
                  className="rounded-full hover:text-foreground disabled:opacity-50"
                  aria-label={`Stop watching ${f.path}`}
                  disabled={settingBusy}
                  onClick={() => setting(() => api.purchasesRemoveFolder(f.path))}
                >
                  <Icon name="close" size={14} />
                </button>
              </span>
            ))}
            <Button size="xs" variant="ghost" onClick={addFolder} disabled={settingBusy}>
              <Icon name="add" size={14} />
              Add folder
            </Button>
          </div>
          {status.folders
            .filter((f) => f.problem)
            .map((f) => (
              <p key={f.path} className="text-destructive" role="alert">
                {fileName(f.path)}: {f.problem}
              </p>
            ))}
        </div>
      </header>

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
                    <span className="truncate text-sm font-medium" title={find.path}>
                      {find.contents.families.length ? list(find.contents.families) : find.name}
                    </span>
                    {find.contents.trial && (
                      <Badge variant="outline" title="The name suggests trial or demo fonts, which usually aren't licensed for commercial work">
                        Looks like a trial
                      </Badge>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                    <span className="font-mono">{find.name}</span>
                    <span>
                      {find.contents.fonts.length} {find.contents.fonts.length === 1 ? "font" : "fonts"}
                      {find.contents.licenses.length > 0 ? ` · ${find.contents.licenses.length} license` : " · no license file found"}
                    </span>
                    {find.contents.skippedFonts.length > 0 && (
                      <span title={find.contents.skippedFonts.join("\n")}>
                        {find.contents.skippedFonts.length} web, app or duplicate files left out
                      </span>
                    )}
                    {find.contents.unreadable.length > 0 && (
                      <span className="text-destructive" title={find.contents.unreadable.join("\n")}>
                        {find.contents.unreadable.length} {find.contents.unreadable.length === 1 ? "file" : "files"} couldn't be
                        read
                      </span>
                    )}
                    {from &&
                      (from.openable ? (
                        <button
                          className="underline-offset-2 hover:underline"
                          onClick={() => openUrl(from.url).catch((e) => toast.error(message(e)))}
                        >
                          from {from.host}
                        </button>
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
                  <Button
                    size="sm"
                    disabled={busy.has(key) || busy.has(`dir:${older.dir}`) || find.missing}
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
                ) : (
                  <Button
                    size="sm"
                    disabled={busy.has(key) || find.missing}
                    aria-label={`Add ${find.name} to the library`}
                    onClick={() => run(() => onImport(find, chosen || null))}
                  >
                    {busy.has(key) ? <Icon name="progress_activity" size={16} className="animate-spin" /> : <Icon name="add" size={16} />}
                    Add to library
                  </Button>
                )}
                <Button size="sm" variant="ghost" aria-label={`Dismiss ${find.name}`} onClick={() => run(() => api.purchasesDismiss(find.id))}>
                  Dismiss
                </Button>
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
                <Button size="sm" variant="outline" disabled={busy.has(`dir:${item.dir}`)} onClick={() => boughtIt(item)}>
                  <Icon name="check" size={16} />I bought it
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${item.label}`}
                  disabled={busy.has(`dir:${item.dir}`) || replacing.has(item.dir)}
                  onClick={() => ask({ kind: "remove", item })}
                >
                  Remove
                </Button>
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
                    <Button
                      size="xs"
                      variant="ghost"
                      className="ml-auto"
                      disabled={storeBusy}
                      onClick={() => ask({ kind: "ended", store: subscription.store, name: storeName })}
                    >
                      {busy.has(`store:${subscription.store}`) && <Icon name="progress_activity" size={14} className="animate-spin" />}
                      My {storeName} subscription ended…
                    </Button>
                  )}
                </div>
                {items.map((item) => {
                  const itemBusy = busy.has(`dir:${item.dir}`) || storeBusy || replacing.has(item.dir);
                  return (
                    <div key={item.dir} className="flex flex-wrap items-center gap-2 border-b py-2 last:border-b-0">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm">{item.label}</span>
                          {item.subscriptionBound && (
                            <Badge variant="outline" title="The license ends with your subscription">
                              Subscription
                            </Badge>
                          )}
                          {item.mayBeTrial && (
                            <Badge variant="outline" title="Trial fonts usually aren't licensed for commercial work">
                              May be a trial
                            </Badge>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {item.fontFiles} {item.fontFiles === 1 ? "font file" : "font files"} · added {when(item.importedAt)} ·{" "}
                          {item.licenseFiles.length ? `license: ${list(item.licenseFiles, 2)}` : "no license file was included"}
                        </div>
                      </div>
                      <Button
                        size="xs"
                        variant="ghost"
                        aria-label={`Show ${item.label} in Finder`}
                        onClick={() => api.purchasesReveal(item.dir).catch((e) => toast.error(message(e)))}
                      >
                        <Icon name="folder_open" size={14} />
                        Show
                      </Button>
                      {item.mayBeTrial && (
                        <Button
                          size="xs"
                          variant="ghost"
                          aria-label={`I bought ${item.label}`}
                          title="You have a license: stop marking it as a trial"
                          disabled={itemBusy}
                          onClick={() => boughtIt(item)}
                        >
                          <Icon name="check" size={14} />I bought it
                        </Button>
                      )}
                      <Button
                        size="xs"
                        variant="ghost"
                        aria-label={`Mark ${item.label} as transferred`}
                        title="You passed this license on to someone else"
                        disabled={itemBusy}
                        onClick={() => ask({ kind: "transferred", item })}
                      >
                        <Icon name="move_item" size={14} />
                        License transferred…
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        aria-label={`Remove ${item.label}`}
                        disabled={itemBusy}
                        onClick={() => ask({ kind: "remove", item })}
                      >
                        <Icon name="delete" size={14} />
                        Remove
                      </Button>
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
            <AlertDialogAction
              onClick={() => {
                if (importing) run(() => onImportPath(importing.path, importStore || null));
                setImporting(null);
              }}
            >
              Add to library
            </AlertDialogAction>
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
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
