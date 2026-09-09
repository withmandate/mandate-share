import type { ComponentType } from "react";
import type { SharingVisibility } from "./privacy-core.ts";
import type { Theme } from "./themes.ts";

/** Describes one prop of a digest component, for the generated catalog. */
export interface PropSpec {
  name: string;
  type: string;
  required?: boolean;
  default?: string;
  description: string;
}

/**
 * Self-documenting metadata every component must export as `meta`.
 * The build validates it, compile-tests `example`, and regenerates
 * COMPONENTS.md from it — drop a file in components/ and it is registered.
 */
export interface ComponentMeta {
  /** Must match the filename (Stat.tsx -> "Stat"). This is the MDX tag name. */
  name: string;
  /** One sentence: what it renders. */
  description: string;
  /** When an author/agent should reach for it. */
  whenToUse: string;
  /** Common misuses, and what to use instead. */
  whenNotToUse?: string;
  props: PropSpec[];
  /** A complete MDX snippet. The build renders it — a broken example fails the build. */
  example: string;
}

/** Digest frontmatter schema (YAML between --- fences at the top of a .mdx file). */
export interface Frontmatter {
  title?: string;
  /** ISO date, quoted in YAML: date: "2026-06-12" (Date objects are tolerated). */
  date?: string | Date;
  /** Topic label: ai | longevity | finance | world | guide. */
  topic?: string;
  /** Initial visual theme; a reader's saved selection takes precedence. */
  theme?: Theme;
  /** One-line dek shown under the headline and on the index. */
  summary?: string;
  /** Mark true when content is illustrative rather than sourced fact. */
  sample?: boolean;
  /**
   * Hide this page from the gallery index. The file still builds and deploys
   * and is reachable by its URL — "unlisted", not access-controlled.
   */
  unlisted?: boolean;
  /**
   * Page width: narrow (default, readable digest column), wide (dashboards,
   * comparisons), full (codebase visuals and diagrams using the whole screen).
   */
  layout?: "narrow" | "wide" | "full";
}

export interface RegistryEntry {
  meta: ComponentMeta;
  component: ComponentType<Record<string, unknown>>;
  file: string;
}

export interface PageInfo {
  slug: string;
  /** "digest" = compiled from MDX; "raw" = a verbatim HTML passthrough page. */
  kind: "digest" | "raw";
  fm: Frontmatter;
  /** Effective consent and protection state; listing metadata is not permission. */
  visibility: SharingVisibility;
  indexable: boolean;
  protected: boolean;
  updatedAt: string;
  /** True unless deliberately public and password-free. */
  unlisted: boolean;
  htmlBytes: number;
  /** Present for digests only — raw pages have no MDX source. */
  mdxBytes?: number;
}
