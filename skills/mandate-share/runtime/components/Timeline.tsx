import type { ComponentMeta } from "../lib/types.ts";

export const meta: ComponentMeta = {
  name: "Timeline",
  description: "Vertical ruled timeline of dated events with diamond markers.",
  whenToUse:
    "Chronologies: project milestones, review rounds, or a delivery schedule. 3-8 events reads best.",
  whenNotToUse:
    "Undated lists (plain markdown) or two-event sequences (just write a sentence).",
  props: [
    {
      name: "items",
      type: "{ date: string; title: string; detail?: string }[]",
      required: true,
      description: "Events in chronological order. `date` is freeform text (\"week 1\", \"round 2\", \"day 3\").",
    },
  ],
  example: `<Timeline
  items={[
    { date: "week 1", title: "Outline agreed", detail: "The sample team defines scope and three review questions." },
    { date: "week 2", title: "First draft reviewed", detail: "Comments identify missing examples and unclear sections." },
    { date: "week 3", title: "Revised page ready" },
  ]}
/>`,
};

export default function Timeline({
  items,
}: {
  items: { date: string; title: string; detail?: string }[];
}) {
  return (
    <ol className="timeline">
      {items.map((item, i) => (
        <li key={i}>
          <span className="timeline-date">{item.date}</span>
          <span className="timeline-title">{item.title}</span>
          {item.detail && <span className="timeline-detail">{item.detail}</span>}
        </li>
      ))}
    </ol>
  );
}
