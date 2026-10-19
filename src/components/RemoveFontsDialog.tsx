import { removalSummary, type RemovalPlan } from "@/fontActions";
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
import { IS_MAC } from "./TitleBar";

/** What Remove from Library… asks about: the fonts in words ("Inter", "12 styles") and the plan. */
export interface RemovalRequest {
  what: string;
  plan: RemovalPlan;
}

/**
 * Remove from Library… asks first, and says exactly what happens: which files are turned off
 * and no longer listed, that nothing is deleted, other styles that share those files, and fonts
 * that stay (copies elsewhere, or not in your folders).
 */
export function RemoveFontsDialog({ request, onConfirm, onCancel }: { request: RemovalRequest | null; onConfirm: (request: RemovalRequest) => void; onCancel: () => void }) {
  const words = request ? removalSummary(request.plan, IS_MAC ? "macOS" : "Windows") : [];
  return (
    <AlertDialog open={!!request} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {request?.what} from the library?</AlertDialogTitle>
          <AlertDialogDescription render={<div className="flex flex-col gap-2" />}>
            {words.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => request && onConfirm(request)}>
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
