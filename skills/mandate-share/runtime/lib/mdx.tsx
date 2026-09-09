import { evaluate } from "@mdx-js/mdx";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as runtime from "react/jsx-runtime";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdxFrontmatter from "remark-mdx-frontmatter";
import type { Frontmatter } from "./types.ts";

/** Baseline element overrides applied to every digest. */
const baseComponents = {
  // External links open in a new tab; in-page anchors do not.
  a: (props: Record<string, unknown>) => {
    const href = typeof props.href === "string" ? props.href : "";
    const external = /^[a-z]+:/i.test(href);
    return (
      <a
        {...props}
        target={external ? "_blank" : undefined}
        rel={external ? "noreferrer" : undefined}
      />
    );
  },
};

/**
 * Compiles MDX source and renders it to static HTML (no client framework,
 * no hydration — interactivity comes from native elements like <details>).
 * Components resolve by name from the registry map; digests never import.
 */
export async function renderMdx(
  source: string,
  components: Record<string, ComponentType<Record<string, unknown>>>,
): Promise<{ frontmatter: Frontmatter; html: string }> {
  const mod = await evaluate(source, {
    ...runtime,
    remarkPlugins: [remarkGfm, remarkFrontmatter, remarkMdxFrontmatter],
  } as Parameters<typeof evaluate>[1]);

  const frontmatter = ((mod as Record<string, unknown>).frontmatter ?? {}) as Frontmatter;
  const html = renderToStaticMarkup(
    createElement(mod.default, { components: { ...baseComponents, ...components } }),
  );
  return { frontmatter, html };
}
