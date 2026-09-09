import type { ComponentMeta } from "../lib/types.ts";

export const meta: ComponentMeta = {
  name: "Sources",
  description: "Numbered reference list with wire-style counters, for the foot of a digest.",
  whenToUse:
    "End every digest that makes factual claims with one. Give each item the piece's title, the publication in `source`, and the url. Use `note` for access caveats (paywalled, primary document, sample).",
  whenNotToUse: "Inline citations — link prose directly and reserve this for the foot.",
  props: [
    {
      name: "items",
      type: "{ title: string; url?: string; source?: string; note?: string }[]",
      required: true,
      description: "References in citation order.",
    },
  ],
  example: `<Sources
  items={[
    { title: "Project review outline", url: "https://example.com/review-outline", source: "sample project", note: "illustrative reference" },
    { title: "Decision notes", url: "https://example.com/decision-notes", source: "sample project" },
  ]}
/>`,
};

export default function Sources({
  items,
}: {
  items: { title: string; url?: string; source?: string; note?: string }[];
}) {
  return (
    <ol className="sources">
      {items.map((item, i) => (
        <li key={i}>
          {item.url ? (
            <a className="sources-title" href={item.url} target="_blank" rel="noreferrer">
              {item.title}
            </a>
          ) : (
            <span className="sources-title">{item.title}</span>
          )}
          {item.source && <span className="sources-origin"> — {item.source}</span>}
          {item.note && <span className="sources-note"> ({item.note})</span>}
        </li>
      ))}
    </ol>
  );
}
