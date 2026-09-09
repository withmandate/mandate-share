import type { ReactNode } from "react";
import type { ComponentMeta } from "../lib/types.ts";

export const meta: ComponentMeta = {
  name: "PullQuote",
  description: "Large italic quotation between heavy rules, with small-caps attribution.",
  whenToUse:
    "One striking quote per digest that earns the visual weight — a reviewer's observation or a project principle. Keep it under ~30 words.",
  whenNotToUse:
    "Routine quotations (markdown blockquote) or multi-paragraph excerpts (Collapse with a blockquote inside).",
  props: [
    { name: "by", type: "string", description: "Who said it." },
    { name: "role", type: "string", description: "Affiliation or title, shown after the name." },
  ],
  example: `<PullQuote by="Design reviewer" role="Illustrative project review">
  Keep the decision beside the material that supports it, so the next
  reader can understand the proposal without reconstructing the conversation.
</PullQuote>`,
};

export default function PullQuote({
  by,
  role,
  children,
}: {
  by?: string;
  role?: string;
  children: ReactNode;
}) {
  return (
    <figure className="pullquote">
      <blockquote>{children}</blockquote>
      {by && (
        <figcaption>
          <b>{by}</b>
          {role ? ` · ${role}` : ""}
        </figcaption>
      )}
    </figure>
  );
}
