# Source and dependency notes

Mandate Share is MIT licensed. Its source includes the page renderer, components, styles, and publishing tools.

The repository contains authored source and its lockfile. Runtime dependencies are restored from their published packages into a private machine-local cache, where their license and notice files remain. They are not vendored into the public source tree. The generated Worker embeds the access gate and store-specific private context; it does not bundle the MDX renderer or Wrangler.

| Direct package | Declared license |
| --- | --- |
| `@mdx-js/mdx`, `react`, `react-dom` | MIT |
| `remark-frontmatter`, `remark-gfm`, `remark-mdx-frontmatter` | MIT |
| `@types/node`, `@types/react`, `@types/react-dom` | MIT |
| `tsx`, `esbuild` | MIT |
| `typescript` | Apache-2.0 |
| `wrangler` | MIT OR Apache-2.0 |

Scoped npm overrides pin `toml@4.2.0` beneath `remark-mdx-frontmatter@5.2.0` for the [recursion](https://github.com/advisories/GHSA-82x6-q7mm-w9cf) and [prototype-pollution](https://github.com/advisories/GHSA-v5mp-jgw5-2x6j) fixes, and `sharp@0.35.4` beneath `miniflare@5.20260825.0-alpha` for its [libheif security fixes](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c). Review these overrides when upgrading their parent packages.

[The package inventory](license-inventory.json) records installed direct and transitive package versions, declared licenses, and top-level license/notice filenames. Generate it again with `node scripts/license-inventory.mjs > skills/mandate-share/references/license-inventory.json` after restoring a changed lockfile. Platform-specific optional packages vary by host. On macOS ARM64, Wrangler includes `@img/sharp-libvips-darwin-arm64` under LGPL-3.0-or-later as a separately installed cache dependency; no binary is copied into this source package. Retain applicable upstream notices if a distribution vendors dependencies or bundles third-party code. The inventory supports that review and is not a legal clearance claim.

Built-in page styling uses system fonts and inline graphics. No downloaded font or image asset is included in the public package. Example pages and component examples contain synthetic material; example-domain links are placeholders.
