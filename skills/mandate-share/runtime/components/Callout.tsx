import type { ReactNode } from "react";
import type { ComponentMeta } from "../lib/types.ts";

export const meta: ComponentMeta = {
  name: "Callout",
  description: "Tinted aside box in four kinds: note, insight, warn, success.",
  whenToUse:
    "Editorial asides that should not interrupt the main flow: `insight` for analysis and why-it-matters, `note` for context, `warn` for caveats and disclaimers, `success` for confirmed good news.",
  whenNotToUse:
    "The opening summary (TLDR) or quotations (PullQuote). More than two per digest section starts to shout.",
  props: [
    {
      name: "kind",
      type: "'note' | 'insight' | 'warn' | 'success'",
      default: "note",
      description: "Visual tone and default label.",
    },
    { name: "title", type: "string", description: "Overrides the label (defaults to the kind)." },
  ],
  example: `<Callout kind="insight" title="review note">
  The draft puts the decision and supporting material on one page.
  Reviewers can follow each question to the section that explains it.
</Callout>`,
};

export default function Callout({
  kind = "note",
  title,
  children,
}: {
  kind?: "note" | "insight" | "warn" | "success";
  title?: string;
  children: ReactNode;
}) {
  return (
    <aside className="callout" data-kind={kind}>
      <div className="callout-title">{title ?? kind}</div>
      <div className="callout-body">{children}</div>
    </aside>
  );
}
