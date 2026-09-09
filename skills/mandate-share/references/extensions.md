# Store components

Read `STORE/.mandate-share/COMPONENTS.md` before adding an extension. Prefer an existing component or composition when it serves the page. A new component belongs in `STORE/components/Name.tsx`, never in the installed runtime. The store survives skill and runtime updates.

Each file exports a default function and a `meta` object. `meta.name` must match its filename and must not collide with a built-in component. The build validates required metadata and renders `meta.example`; an invalid export or example fails clearly.

```tsx
import type { ReactNode } from "react";

export const meta = {
  name: "ReviewNote",
  description: "A short review note with a label.",
  whenToUse: "A brief comment beside a draft decision.",
  props: [{ name: "label", type: "string", description: "The note label." }],
  example: '<ReviewNote label="Draft">Illustrative review text.</ReviewNote>',
};

export default function ReviewNote({ label = "Review", children }: { label?: string; children?: ReactNode }) {
  return <aside style={{ borderLeft: "2px solid var(--accent)", paddingLeft: "1rem" }}><strong>{label}</strong><div>{children}</div></aside>;
}
```

Use the runtime's React dependency through ordinary `react` imports; the store needs no dependency installation. Extensions render at build time. Keep them pure and self-contained: native HTML such as `details` or anchors supports useful interaction without a client bundle. Inline SVG and styles can use theme variables including `--ink`, `--paper-raised`, `--accent`, `--rule`, `--serif`, `--sans`, and `--mono`; do not edit the bundled stylesheet for store-specific work.

Build after editing the component, read its updated catalog entry, and preview a page that exercises its intended props. Inspect light/dark appearance and print behavior when those matter to the page. Component code runs locally with the user's filesystem access; inspect code from untrusted sources before building it.
