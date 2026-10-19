import { useId, useRef, useState } from "react";
import type { Axis, NamedInstance } from "@/api";
import { commitAxis, currentInstance, discardAxis, instanceValues, typeAxis, type AxisDraft } from "@/axisField";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Tip } from "@/components/Tip";
import { FactsMessage, type FactsState } from "./parts";

interface Props {
  /** Every axis of the style (hidden ones too), or null while they're being read. */
  axes: Axis[] | null;
  values: Record<string, number>;
  onChange: (tag: string, value: number) => void;
  /** Sets every axis at once (a named style), or clears them all (Reset: the defaults). */
  onSet: (values: Record<string, number>) => void;
  /** The style's named styles, read from its file (`fontFacts`). */
  instances: NamedInstance[] | null;
  facts: FactsState;
  retry: () => void;
}

const tidy = (v: number) => String(Math.round(v * 100) / 100);

/** The named style picker's choice while the axes aren't at one. */
const CUSTOM = "custom";

/**
 * The style's named styles (a picker that sets every slider), then a slider and a number field
 * per variable axis, Reset, and Show hidden axes when the font hides some (axes its maker keeps
 * for fine-tuning). The values apply to Specimen, Characters and OpenType too, for this style.
 */
export function AxesTab({ axes, values, onChange, onSet, instances, facts, retry }: Props) {
  const id = useId();
  const [showHidden, setShowHidden] = useState(false);
  if (!axes) return <p className="px-6 pt-5 text-xs text-muted-foreground">Reading the axes…</p>;
  const hidden = axes.filter((a) => a.hidden).length;
  const shown = showHidden ? axes : axes.filter((a) => !a.hidden);
  if (!axes.length) return <p className="px-6 pt-5 text-xs text-muted-foreground">This style has no axes to adjust.</p>;
  const named = instances ?? [];
  const current = currentInstance(named, axes, values);
  const changed = Object.keys(values).length > 0;
  return (
    <div className="flex max-w-2xl flex-col gap-6 px-6 pt-5 pb-12">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {named.length > 0 && (
          <>
            <label id={`${id}-named`} className="text-sm">
              Named style
            </label>
            <Select
              value={current >= 0 ? String(current) : CUSTOM}
              onValueChange={(v) => {
                if (typeof v !== "string" || v === CUSTOM) return;
                const instance = named[Number(v)];
                if (instance) onSet(instanceValues(instance, axes));
              }}
              items={[...named.map((n, i) => ({ value: String(i), label: n.name })), { value: CUSTOM, label: "Custom" }]}
            >
              <Tip tip="Sets every axis to one of the font's named styles">
                <SelectTrigger size="sm" aria-labelledby={`${id}-named`} className="min-w-40">
                  <SelectValue />
                </SelectTrigger>
              </Tip>
              <SelectContent className="max-h-80">
                {named.map((n, i) => (
                  <SelectItem key={`${n.name}-${i}`} value={String(i)}>
                    {n.name}
                  </SelectItem>
                ))}
                {/* Only to show what's set now; it can't be picked. */}
                {current < 0 && (
                  <SelectItem value={CUSTOM} disabled>
                    Custom
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </>
        )}
        <span className="flex-1" />
        {hidden > 0 && (
          <label className="flex items-center gap-2 text-sm">
            <Tip tip={showHidden ? "Hides the fine-tuning axes again" : "Shows the fine-tuning axes the font's maker hid"}>
              <Checkbox checked={showHidden} onCheckedChange={(on) => setShowHidden(on)} />
            </Tip>
            Show hidden axes ({hidden})
          </label>
        )}
        {/* Stays focusable once every axis is back at its default (focus doesn't fall out of the
            page, and the tooltip says why it's greyed out). */}
        <Tip tip="Puts every axis back to its default" disabledReason={!changed && "Nothing to reset yet: every axis is at its default"}>
          <Button variant="outline" size="sm" disabled={!changed} focusableWhenDisabled className="aria-disabled:opacity-50" onClick={() => onSet({})}>
            <Icon name="restart_alt" size={16} />
            Reset
          </Button>
        </Tip>
      </div>
      {facts.status !== "ready" || facts.answer.unread ? <FactsMessage state={facts} retry={retry} what="named styles" /> : null}
      <p className="-mt-2 text-xs text-muted-foreground">Changes show in Specimen, Characters and OpenType too, for this style.</p>
      {shown.map((a) => (
        <AxisRow key={a.tag} axis={a} value={values[a.tag] ?? a.default} onChange={(v) => onChange(a.tag, v)} />
      ))}
    </div>
  );
}

function AxisRow({ axis, value, onChange }: { axis: Axis; value: number; onChange: (v: number) => void }) {
  const id = useId();
  const name = axis.name ?? axis.tag;
  // What's typed in the number field, until it's finished (Return or leaving the field), and
  // the value from before typing, for Esc (see axisField.ts).
  const [draft, setDraft] = useState<AxisDraft | null>(null);
  const discard = useRef(false);
  const commit = () => {
    const v = commitAxis(draft, axis);
    if (v !== undefined) onChange(v);
  };
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2">
      <label htmlFor={id} className="text-sm">
        {name} <code className="font-mono text-xs text-muted-foreground">{axis.tag}</code>
        {axis.hidden && <span className="ml-1.5 text-xs text-muted-foreground">(hidden)</span>}
      </label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={axis.min}
        max={axis.max}
        step="any"
        value={draft?.text ?? tidy(value)}
        onChange={(e) => {
          // Values in range show as they're typed; anything else waits until the field is left.
          const next = typeAxis(draft, e.target.value, value, axis);
          setDraft(next.draft);
          if (next.apply !== undefined) onChange(next.apply);
        }}
        onBlur={() => {
          if (!discard.current) commit();
          discard.current = false;
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            setDraft(null);
          } else if (e.key === "Escape") {
            // Back to the value from before typing (values applied while typing are undone too), out
            // of the field; the next Esc goes back.
            e.preventDefault();
            const before = discardAxis(draft);
            if (before !== undefined) onChange(before);
            discard.current = true;
            e.currentTarget.blur();
          }
        }}
        className="w-24 text-right font-mono tabular-nums"
      />
      <Tip tip={`Sets ${name}, from ${tidy(axis.min)} to ${tidy(axis.max)}`}>
        <Slider
          className="col-span-2"
          min={axis.min}
          max={axis.max}
          step={(axis.max - axis.min) / 200 || 1}
          value={[value]}
          onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)}
          aria-label={name}
        />
      </Tip>
      <div className="col-span-2 flex justify-between font-mono text-[11px] text-muted-foreground tabular-nums">
        <span>{tidy(axis.min)}</span>
        <span>Default {tidy(axis.default)}</span>
        <span>{tidy(axis.max)}</span>
      </div>
    </div>
  );
}
