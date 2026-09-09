import type { ComponentMeta } from "../lib/types.ts";

export const meta: ComponentMeta = {
  name: "Meter",
  description: "Labeled progress bar with a mono value readout.",
  whenToUse:
    "Progress toward a known target: completed tasks, reviewed pages, resolved comments, or checklist coverage.",
  whenNotToUse:
    "Comparing several quantities (BarChart) or open-ended numbers with no natural 100 percent.",
  props: [
    { name: "value", type: "number", required: true, description: "Current value." },
    { name: "max", type: "number", default: "100", description: "The full-bar value." },
    { name: "label", type: "string", required: true, description: "What is being measured." },
    { name: "display", type: "string", description: "Readout override (defaults to a percentage)." },
    { name: "detail", type: "string", description: "Small italic line under the bar." },
  ],
  example: `<Meter value={68} label="review comments resolved" detail="68 of 100 comments, sample counts" />`,
};

export default function Meter({
  value,
  max = 100,
  label,
  display,
  detail,
}: {
  value: number;
  max?: number;
  label: string;
  display?: string;
  detail?: string;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="meter">
      <div className="meter-head">
        <span className="meter-label">{label}</span>
        <span className="meter-value">{display ?? `${Math.round(pct)}%`}</span>
      </div>
      <div
        className="meter-track"
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={label}
      >
        <div className="meter-fill" style={{ width: `${pct}%` }} />
      </div>
      {detail && <div className="meter-detail">{detail}</div>}
    </div>
  );
}
