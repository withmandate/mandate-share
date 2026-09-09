import type { ComponentMeta } from "../lib/types.ts";

export const meta: ComponentMeta = {
  name: "BarChart",
  description: "Horizontal labeled bars for comparing a handful of categories, pure HTML/CSS.",
  whenToUse:
    "Comparing 2-8 named quantities: completed tasks, review counts, planned hours. Values render in mono on the right; bars scale to the max (or an explicit max for a known target).",
  whenNotToUse:
    "Time series (Sparkline), more than ~8 categories (DataTable), or parts-of-a-whole storytelling where percentages in a table read better.",
  props: [
    {
      name: "items",
      type: "{ label: string; value: number; display?: string }[]",
      required: true,
      description: "Bars, in display order. `display` overrides the printed value (e.g. \"72.4%\").",
    },
    { name: "max", type: "number", description: "Scale ceiling. Defaults to the largest value." },
    { name: "unit", type: "string", description: "Suffix appended when `display` is absent." },
    { name: "note", type: "string", description: "Small italic footnote under the chart." },
  ],
  example: `<BarChart
  max={20}
  note="Completed checklist items by review stage, sample counts"
  items={[
    { label: "outline", value: 14 },
    { label: "draft", value: 11 },
    { label: "examples", value: 8 },
  ]}
/>`,
};

export default function BarChart({
  items,
  max,
  unit = "",
  note,
}: {
  items: { label: string; value: number; display?: string }[];
  max?: number;
  unit?: string;
  note?: string;
}) {
  const ceiling = max ?? Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="barchart" role="list">
      {items.map((item) => (
        <div className="barchart-row" role="listitem" key={item.label}>
          <span className="barchart-label">{item.label}</span>
          <span className="barchart-track">
            <span
              className="barchart-fill"
              style={{ width: `${Math.max(0, Math.min(100, (item.value / ceiling) * 100))}%` }}
            />
          </span>
          <span className="barchart-value">{item.display ?? `${item.value}${unit}`}</span>
        </div>
      ))}
      {note && <div className="barchart-note">{note}</div>}
    </div>
  );
}
