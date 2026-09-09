import type { ComponentMeta } from "../lib/types.ts";

type WireframeTone = "neutral" | "safety" | "evidence" | "reference";

type WireframeBlock = {
  label: string;
  detail?: string;
  size?: "short" | "medium" | "tall";
  tone?: WireframeTone;
  collapsed?: boolean;
};

type DesktopWireframe = {
  navPosition: "left" | "top" | "right" | "none";
  navItems?: string[];
  current?: string;
  blocks: WireframeBlock[];
};

type MobileWireframe = {
  control?: string;
  blocks: WireframeBlock[];
};

export const meta: ComponentMeta = {
  name: "ResponsiveWireframe",
  description:
    "Matched desktop and mobile page wireframes for comparing responsive information-architecture directions.",
  whenToUse:
    "Comparing 2-4 page concepts where hierarchy, navigation position, responsive order, and local disclosure matter more than finished visual styling.",
  whenNotToUse:
    "Pixel-level design reviews, interaction prototypes, or a single settled layout that reads more clearly as prose or a Flow.",
  props: [
    {
      name: "title",
      type: "string",
      required: true,
      description: "Concept name shown above the matched views.",
    },
    {
      name: "recommended",
      type: "boolean",
      default: "false",
      description: "Adds a restrained recommended marker.",
    },
    {
      name: "desktop",
      type: "{ navPosition: 'left' | 'top' | 'right' | 'none'; navItems?: string[]; current?: string; blocks: WireframeBlock[] }",
      required: true,
      description: "Desktop navigation placement and ordered content blocks.",
    },
    {
      name: "mobile",
      type: "{ control?: string; blocks: WireframeBlock[] }",
      required: true,
      description: "Mobile current-section control and ordered content blocks.",
    },
  ],
  example: `<ResponsiveWireframe
  title="Project review"
  recommended
  desktop={{
    navPosition: "left",
    navItems: ["Overview", "Scope", "Progress", "Questions", "Reference"],
    current: "Questions",
    blocks: [
      { label: "Project summary", size: "medium" },
      { label: "Risks & open questions", size: "tall", tone: "safety" },
      { label: "Completed review items", size: "tall", tone: "evidence" },
      { label: "Supporting notes", tone: "reference", collapsed: true },
    ],
  }}
  mobile={{
    control: "Open questions · Jump",
    blocks: [
      { label: "Project summary", size: "medium" },
      { label: "Risks & open questions", size: "tall", tone: "safety" },
      { label: "Completed review items", size: "tall", tone: "evidence" },
      { label: "Supporting notes", tone: "reference", collapsed: true },
    ],
  }}
/>`,
};

export default function ResponsiveWireframe({
  title,
  recommended = false,
  desktop,
  mobile,
}: {
  title: string;
  recommended?: boolean;
  desktop: DesktopWireframe;
  mobile: MobileWireframe;
}) {
  return (
    <figure className="responsive-wireframe">
      <figcaption className="responsive-wireframe-caption">
        <span>{title}</span>
        {recommended ? (
          <span className="responsive-wireframe-recommended">recommended</span>
        ) : null}
      </figcaption>
      <div className="responsive-wireframe-pair">
        <div className="responsive-wireframe-view" data-device="desktop">
          <FrameLabel device="desktop" width="1440" />
          <div
            className="responsive-wireframe-desktop-shell"
            data-nav-position={desktop.navPosition}
          >
            {desktop.navPosition !== "none" ? (
              <WireframeNav
                items={desktop.navItems ?? []}
                current={desktop.current}
              />
            ) : null}
            <div className="responsive-wireframe-page">
              <WireframeBlocks blocks={desktop.blocks} />
            </div>
          </div>
        </div>
        <div className="responsive-wireframe-view" data-device="mobile">
          <FrameLabel device="mobile" width="390" />
          <div className="responsive-wireframe-mobile-shell">
            {mobile.control ? (
              <div className="responsive-wireframe-mobile-control">
                <span>{mobile.control}</span>
                <span aria-hidden="true">⌄</span>
              </div>
            ) : null}
            <div className="responsive-wireframe-page">
              <WireframeBlocks blocks={mobile.blocks} />
            </div>
          </div>
        </div>
      </div>
    </figure>
  );
}

function FrameLabel({ device, width }: { device: string; width: string }) {
  return (
    <div className="responsive-wireframe-frame-label">
      <span>{device}</span>
      <span>{width}px</span>
    </div>
  );
}

function WireframeNav({
  items,
  current,
}: {
  items: string[];
  current?: string;
}) {
  return (
    <div className="responsive-wireframe-nav" aria-label="Wireframe navigation">
      <span className="responsive-wireframe-nav-label">on this page</span>
      {items.map((item) => (
        <span
          key={item}
          className="responsive-wireframe-nav-item"
          data-current={item === current ? "true" : undefined}
        >
          {item}
        </span>
      ))}
    </div>
  );
}

function WireframeBlocks({ blocks }: { blocks: WireframeBlock[] }) {
  return (
    <div className="responsive-wireframe-blocks">
      {blocks.map((block, index) => (
        <div
          key={`${block.label}-${index}`}
          className="responsive-wireframe-block"
          data-size={block.size ?? "short"}
          data-tone={block.tone ?? "neutral"}
          data-collapsed={block.collapsed ? "true" : undefined}
        >
          <span className="responsive-wireframe-block-label">
            {block.collapsed ? "▸ " : ""}
            {block.label}
          </span>
          {block.detail ? (
            <span className="responsive-wireframe-block-detail">
              {block.detail}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
