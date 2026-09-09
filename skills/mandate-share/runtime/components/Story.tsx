import type { ReactNode } from "react";
import type { ComponentMeta } from "../lib/types.ts";

export const meta: ComponentMeta = {
  name: "Story",
  description: "One digest item: kicker line (tag, source, time), headline, and a short dek.",
  whenToUse:
    "The core unit of a digest. Stack several in a row under a section heading — they separate themselves with hairlines. Keep the body to 1-3 sentences of why-it-matters.",
  whenNotToUse:
    "Standalone analysis paragraphs (plain markdown) or quotes (PullQuote). Do not nest charts inside a Story body; place them between stories.",
  props: [
    { name: "title", type: "string", required: true, description: "The headline." },
    { name: "url", type: "string", description: "Makes the headline a link." },
    { name: "source", type: "string", description: "Publication or origin, shown in the kicker." },
    { name: "tag", type: "string", description: "Short category label, e.g. review, planning." },
    { name: "time", type: "string", description: "Recency hint, e.g. 2h ago, week 2." },
  ],
  example: `<Story
  title="The project team combines review notes into one shared page"
  url="https://example.com/project-review"
  source="sample project"
  tag="review"
  time="week 2"
>
  The revised page keeps open questions beside the relevant examples.
  Reviewers can add comments in one place before the next planning session.
</Story>`,
};

export default function Story({
  title,
  url,
  source,
  tag,
  time,
  children,
}: {
  title: string;
  url?: string;
  source?: string;
  tag?: string;
  time?: string;
  children?: ReactNode;
}) {
  return (
    <article className="story">
      {(tag || source || time) && (
        <div className="story-kicker">
          {tag && (
            <span className="badge" data-tone="accent">
              {tag}
            </span>
          )}
          {source && <span>{source}</span>}
          {time && <span>{time}</span>}
        </div>
      )}
      <h3 className="story-title">
        {url ? (
          <a href={url} target="_blank" rel="noreferrer">
            {title}
          </a>
        ) : (
          title
        )}
      </h3>
      {children && <div className="story-body">{children}</div>}
    </article>
  );
}
