import type { ComponentMeta } from "../lib/types.ts";

export const meta: ComponentMeta = {
  name: "Sparkline",
  description: "Tiny inline SVG trend line rendered at build time — no JavaScript in the artifact.",
  whenToUse:
    "Showing the shape of a series next to a number or inside a sentence: weekly review counts, completed tasks, or pages revised. Pair with a Stat or inline in prose.",
  whenNotToUse:
    "When exact values must be readable (DataTable) or when comparing categories (BarChart). No axes are drawn — it communicates shape only.",
  props: [
    { name: "data", type: "number[]", required: true, description: "The series, oldest first. 2+ points." },
    { name: "width", type: "number", default: "140", description: "Rendered width in px." },
    { name: "height", type: "number", default: "32", description: "Rendered height in px." },
    { name: "label", type: "string", description: "Accessible description of the series." },
    { name: "filled", type: "boolean", default: "true", description: "Soft area fill under the line." },
  ],
  example: `Reviews completed each week: <Sparkline data={[18, 21, 17, 24, 26, 23, 29, 31, 28, 35, 34, 38, 41]} label="weekly completed reviews, sample counts" />`,
};

export default function Sparkline({
  data,
  width = 140,
  height = 32,
  label,
  filled = true,
}: {
  data: number[];
  width?: number;
  height?: number;
  label?: string;
  filled?: boolean;
}) {
  const pad = 3;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;

  const x = (i: number) => pad + (data.length < 2 ? w / 2 : (i / (data.length - 1)) * w);
  const y = (v: number) => pad + h - ((v - min) / span) * h;
  const points = data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);

  const last = data[data.length - 1] ?? min;
  const area = `${pad},${pad + h} ${points.join(" ")} ${(pad + w).toFixed(1)},${pad + h}`;

  return (
    <svg
      className="sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label ?? "trend"}
    >
      {label && <title>{label}</title>}
      {filled && <polygon className="sparkline-fill" points={area} />}
      <polyline className="sparkline-line" points={points.join(" ")} />
      <circle className="sparkline-dot" cx={x(data.length - 1)} cy={y(last)} r={2.4} />
    </svg>
  );
}
