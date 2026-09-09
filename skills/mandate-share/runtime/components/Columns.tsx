import type { CSSProperties, ReactNode } from "react";
import type { ComponentMeta } from "../lib/types.ts";

export const meta: ComponentMeta = {
  name: "Columns",
  description: "Side-by-side grid that stacks on small screens. Each direct child is one column.",
  whenToUse:
    "Parallel briefs: alternative plans, open questions, before and after. Wrap each column's markdown in a plain <div> with blank lines around the content (see example — MDX parses markdown inside JSX when separated by blank lines).",
  whenNotToUse: "Sequential reading content — columns break reading order on mobile where they stack.",
  props: [
    {
      name: "n",
      type: "2 | 3 | 4",
      default: "2",
      description: "Column count on wide screens. 3-4 columns want layout: wide or full in frontmatter.",
    },
  ],
  example: `<Columns>
  <div>
    ### Current draft

    The overview and supporting notes appear on separate pages.
  </div>
  <div>
    ### Proposed revision

    The overview links each review question to its supporting detail.
  </div>
</Columns>`,
};

export default function Columns({ n = 2, children }: { n?: 2 | 3 | 4; children: ReactNode }) {
  return (
    <div className="columns" style={{ "--cols": n } as CSSProperties}>
      {children}
    </div>
  );
}
