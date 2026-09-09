# Author and update MDX

Run `status --store NAME` to obtain the selected store's paths, then `build --store NAME`. Read `STORE/.mandate-share/COMPONENTS.md`; it contains validated component names, props, use cases, and examples. Components are registered automatically, so ordinary pages need no imports.

Write a source file under `STORE/digests/SLUG.mdx`. Use lowercase letters, digits, and hyphens, starting alphanumeric, with no trailing hyphen and at most 80 characters. `index`, `404`, and `robots` are reserved. Keep the filename when updating a page to preserve its URL. Raw HTML and MDX cannot share a slug in the same store.

```mdx
---
title: "A sample project brief"
date: "2026-01-01"
topic: guide
summary: "Illustrative content for a local preview."
layout: narrow
sample: true
---

<Callout kind="note" title="Sample content">These details are illustrative.</Callout>

<TLDR>
- The prototype is ready for a local review.
- The next step is to collect feedback on its navigation.
</TLDR>

## Review scope

Write the explanation in ordinary Markdown. Add components when they help the reader compare or understand the material.
```

`title` is required. `layout` can be `narrow`, `wide`, or `full`; `topic` labels the subject (`ai`, `longevity`, `finance`, `world`, or `guide`). Optional `theme` chooses `clarity`, `ledger`, `fieldnotes`, or `blueprint`; see [themes](themes.md) for reader controls and defaults. Set `sample: true` for illustrative claims, keep private sharing as the default. Frontmatter does not grant public access or homepage consent; use the explicit [privacy](privacy.md) workflow for that.

Use `<StatRow>` and `<Stat>` for a few measurements, `<DataTable>` for comparisons, `<Callout>` for an aside, and `<Collapse>` for optional detail. Consult the catalog for exact props. Preformat numeric values as strings. MDX parses braces as expressions and JSX uses `className`; escape literal braces in prose when necessary. Keep embedded assets local or inline if the exported HTML must work offline.

For sourced material, preserve attribution and link claims to the user's material or verified sources. Add `<Sources items={[{ title: "Source title", url: "https://example.com/source" }]} />` when a reference list helps. The example URL is a placeholder, not evidence.

```sh
mandate-share check "/absolute/store/digests/brief.mdx" --store personal
mandate-share build --store personal
mandate-share preview brief --store personal
```

Importing a prepared MDX file is also supported: `import /absolute/input/brief.mdx --slug brief --store personal`. Its frontmatter controls title, summary, and appearance; HTML-only listing flags are rejected for MDX. An import with an existing MDX slug replaces that source and preserves password state.

Built MDX produces `STORE/.mandate-share/dist/SLUG.html` and `SLUG.mdx`. The HTML embeds the source in a `script` element with type `text/mdx` for later reuse. An authorized reader can retrieve that source, so it must contain only the material intended for readers. Protection of the hosted URL does not encrypt an HTML file handed directly to someone.
