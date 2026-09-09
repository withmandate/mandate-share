import type { ReactNode } from "react";
import type { ComponentMeta } from "../lib/types.ts";

export const meta: ComponentMeta = {
  name: "Collapse",
  description: "Native <details> disclosure — collapsed depth that works with zero JavaScript.",
  whenToUse:
    "Optional depth that would bloat the scan: full methodology, raw spec tables, long source excerpts. The artifact stays skimmable; the detail stays shippable.",
  whenNotToUse:
    "Anything essential to the digest's argument — closed content is invisible content. Never hide the TLDR or key numbers.",
  props: [
    { name: "summary", type: "string", required: true, description: "The always-visible clickable label." },
    { name: "open", type: "boolean", default: "false", description: "Start expanded." },
  ],
  example: `<Collapse summary="how the sample review works">
  Three reviewers read each page with the same checklist. They mark unclear
  sections, compare their notes, and record the changes needed before approval.
</Collapse>`,
};

export default function Collapse({
  summary,
  open = false,
  children,
}: {
  summary: string;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="collapse" open={open || undefined}>
      <summary>{summary}</summary>
      <div className="collapse-body">{children}</div>
    </details>
  );
}
