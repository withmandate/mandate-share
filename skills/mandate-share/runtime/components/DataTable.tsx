import type { ReactNode } from "react";
import type { ComponentMeta } from "../lib/types.ts";

export const meta: ComponentMeta = {
  name: "DataTable",
  description: "Structured table from column specs and row objects, with per-column alignment.",
  whenToUse:
    "Dense reference data: task lists, review counts, delivery schedules. Use `align: 'right'` for every numeric column — it switches to tabular mono. For simple 2-3 column prose tables, plain markdown tables also work.",
  whenNotToUse: "Anything with one row (StatRow) or where the shape matters more than values (BarChart, Sparkline).",
  props: [
    {
      name: "columns",
      type: "{ key: string; label: string; align?: 'left' | 'right' | 'center' }[]",
      required: true,
      description: "Column order, header labels, alignment.",
    },
    {
      name: "rows",
      type: "Record<string, ReactNode>[]",
      required: true,
      description: "Row objects keyed by column key. Values may include JSX like <Badge>.",
    },
    { name: "caption", type: "string", description: "Small caps caption above the table." },
    { name: "dense", type: "boolean", default: "false", description: "Tighter padding for big tables." },
  ],
  example: `<DataTable
  caption="review checklist, sample counts"
  columns={[
    { key: "stage", label: "stage" },
    { key: "complete", label: "complete", align: "right" },
    { key: "remaining", label: "remaining", align: "right" },
  ]}
  rows={[
    { stage: "outline", complete: 14, remaining: 2 },
    { stage: "draft", complete: 11, remaining: 5 },
    { stage: "examples", complete: 8, remaining: 3 },
  ]}
/>`,
};

export default function DataTable({
  columns,
  rows,
  caption,
  dense = false,
}: {
  columns: { key: string; label: string; align?: "left" | "right" | "center" }[];
  rows: Record<string, ReactNode>[];
  caption?: string;
  dense?: boolean;
}) {
  return (
    <div className={dense ? "datatable dense" : "datatable"}>
      <table>
        {caption && <caption>{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} data-align={c.align ?? "left"}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c.key} data-align={c.align ?? "left"}>
                  {row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
