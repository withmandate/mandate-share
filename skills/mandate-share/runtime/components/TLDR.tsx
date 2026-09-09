import type { ReactNode } from "react";
import type { ComponentMeta } from "../lib/types.ts";

export const meta: ComponentMeta = {
  name: "TLDR",
  description: "Boxed key-takeaways summary, designed to sit at the top of a digest.",
  whenToUse:
    "Open every digest with one, right after the frontmatter. 3-6 bullets, each a complete standalone takeaway a reader could quote.",
  whenNotToUse:
    "Mid-document summaries (use a Callout) or anything longer than ~6 bullets (tighten the writing instead).",
  props: [
    {
      name: "title",
      type: "string",
      default: "tl;dr",
      description: "Label shown above the bullets.",
    },
  ],
  example: `<TLDR>
- The sample draft now keeps the proposal and review questions on one page.
- Supporting examples appear beside the decisions they help explain.
- The next review will check whether readers can find the details they need.
</TLDR>`,
};

export default function TLDR({
  title = "tl;dr",
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <aside className="tldr">
      <span className="tldr-label">{title}</span>
      {children}
    </aside>
  );
}
