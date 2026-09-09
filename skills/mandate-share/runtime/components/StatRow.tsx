import type { ReactNode } from "react";
import type { ComponentMeta } from "../lib/types.ts";

export const meta: ComponentMeta = {
  name: "StatRow",
  description: "Hairline grid wrapper that lays out 2-5 Stat blocks responsively.",
  whenToUse:
    "Always wrap multiple adjacent Stats in one of these — it renders them as a single ruled grid, the signature data treatment of the theme.",
  whenNotToUse: "A single Stat can stand alone without it.",
  props: [],
  example: `<StatRow>
  <Stat value="68%" label="checklist complete" trend="up" delta="+4pt" />
  <Stat value="24" label="reviewed pages" hint="sample counts" />
</StatRow>`,
};

export default function StatRow({ children }: { children: ReactNode }) {
  return <div className="stat-row">{children}</div>;
}
