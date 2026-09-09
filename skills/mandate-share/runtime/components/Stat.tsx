import type { ComponentMeta } from "../lib/types.ts";

export const meta: ComponentMeta = {
  name: "Stat",
  description: "One big number with a label, optional delta with trend color, and a hint line.",
  whenToUse:
    "Headline measurements: completed tasks, pages reviewed, or open questions. Wrap several in a StatRow to form a hairline grid.",
  whenNotToUse:
    "More than ~5 numbers (use DataTable) or values that need explanation longer than the hint allows (write prose).",
  props: [
    { name: "value", type: "string", required: true, description: "The number, preformatted (e.g. \"1,240\")." },
    { name: "label", type: "string", required: true, description: "What the number is." },
    { name: "delta", type: "string", description: "Change, preformatted (e.g. \"+3.2%\")." },
    {
      name: "trend",
      type: "'up' | 'down' | 'flat'",
      description: "Colors the delta: up green, down red, flat muted. Color reflects direction, not goodness.",
    },
    { name: "hint", type: "string", description: "Small italic context line under the label." },
  ],
  example: `<StatRow>
  <Stat value="48" label="pages reviewed" delta="+8" trend="up" />
  <Stat value="12" label="open questions" delta="-6" trend="down" />
  <Stat value="86%" label="checklist complete" delta="+3pt" trend="up" hint="sample figures" />
</StatRow>`,
};

const ARROWS = { up: "▲", down: "▼", flat: "→" } as const;

export default function Stat({
  value,
  label,
  delta,
  trend = "flat",
  hint,
}: {
  value: string;
  label: string;
  delta?: string;
  trend?: keyof typeof ARROWS;
  hint?: string;
}) {
  return (
    <div className="stat">
      <div className="stat-value">
        {value}
        {delta && (
          <span className="stat-delta" data-trend={trend}>
            {ARROWS[trend]} {delta}
          </span>
        )}
      </div>
      <div className="stat-label">{label}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}
