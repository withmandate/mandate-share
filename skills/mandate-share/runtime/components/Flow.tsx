import { Fragment } from "react";
import type { ComponentMeta } from "../lib/types.ts";

export const meta: ComponentMeta = {
  name: "Flow",
  description:
    "Linear process diagram: labeled boxes joined by accent arrows, vertical or horizontal.",
  whenToUse:
    "Sequential pipelines and lifecycles with 3-6 stages: build pipelines, request paths, deploy flows. `direction=\"across\"` suits short labels; it stacks vertically on small screens.",
  whenNotToUse:
    "Dated chronologies (Timeline) or branching graphs with multiple paths — this renders a single linear chain.",
  props: [
    {
      name: "steps",
      type: "{ title: string; detail?: string }[]",
      required: true,
      description: "Stages in order. `detail` is a small muted line under the title.",
    },
    {
      name: "direction",
      type: "'down' | 'across'",
      default: "'down'",
      description:
        "'down' chains boxes vertically; 'across' lays them in a row (stacks to vertical on narrow viewports).",
    },
  ],
  example: `<Flow
  steps={[
    { title: "outline", detail: "State the question, scope, and expected result." },
    { title: "draft", detail: "Write the proposal and add supporting examples." },
    { title: "review", detail: "Collect comments and resolve open questions." },
    { title: "publish", detail: "Share the approved page and record the next review." },
  ]}
/>`,
};

export default function Flow({
  steps,
  direction = "down",
}: {
  steps: { title: string; detail?: string }[];
  direction?: "down" | "across";
}) {
  return (
    <div className="flow" data-direction={direction}>
      {steps.map((step, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="flow-arrow" aria-hidden="true" />}
          <div className="flow-step">
            <span className="flow-title">{step.title}</span>
            {step.detail && <span className="flow-detail">{step.detail}</span>}
          </div>
        </Fragment>
      ))}
    </div>
  );
}
