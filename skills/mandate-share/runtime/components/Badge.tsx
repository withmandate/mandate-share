import type { ReactNode } from "react";
import type { ComponentMeta } from "../lib/types.ts";

export const meta: ComponentMeta = {
  name: "Badge",
  description: "Small inline mono label with a toned outline — sharp corners, no pill.",
  whenToUse:
    "Inline status and classification: <Badge tone=\"warn\">needs review</Badge>, task stages, draft labels, decisions. Works inside sentences, table cells, and story kickers.",
  whenNotToUse: "Long text (it is uppercase mono) or as a link substitute.",
  props: [
    {
      name: "tone",
      type: "'neutral' | 'accent' | 'good' | 'bad' | 'warn'",
      default: "neutral",
      description: "Outline and text color.",
    },
  ],
  example: `The outline is <Badge tone="good">ready</Badge> while the examples
still <Badge tone="warn">need review</Badge>, and the scope remains <Badge tone="neutral">unchanged</Badge>.`,
};

export default function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "accent" | "good" | "bad" | "warn";
  children: ReactNode;
}) {
  return (
    <span className="badge" data-tone={tone}>
      {children}
    </span>
  );
}
