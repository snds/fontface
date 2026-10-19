import { useId, useRef, useState } from "react";
import type { Axis } from "@/api";
import { commitAxis, discardAxis, typeAxis, type AxisDraft } from "@/axisField";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";

interface Props {
  /** The visible axes, or null while they're being read. */
  axes: Axis[] | null;
  values: Record<string, number>;
  onChange: (tag: string, value: number) => void;
}

const tidy = (v: number) => String(Math.round(v * 100) / 100);

/** A slider and a number field per variable axis. The values apply to Specimen and Characters too. */
export function AxesTab({ axes, values, onChange }: Props) {
  if (!axes) return <p className="px-6 pt-5 text-xs text-muted-foreground">Reading the axes…</p>;
  if (!axes.length) return <p className="px-6 pt-5 text-xs text-muted-foreground">This style has no axes to adjust.</p>;
  return (
    <div className="flex max-w-2xl flex-col gap-6 px-6 pt-5 pb-12">
      <p className="text-xs text-muted-foreground">Changes show in Specimen and Characters too, for this style.</p>
      {axes.map((a) => (
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
            // Back to the value before typing (values applied while typing are undone too), out
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
      <Slider
        className="col-span-2"
        min={axis.min}
        max={axis.max}
        step={(axis.max - axis.min) / 200 || 1}
        value={[value]}
        onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)}
        aria-label={name}
      />
      <div className="col-span-2 flex justify-between font-mono text-[11px] text-muted-foreground tabular-nums">
        <span>{tidy(axis.min)}</span>
        <span>Default {tidy(axis.default)}</span>
        <span>{tidy(axis.max)}</span>
      </div>
    </div>
  );
}
