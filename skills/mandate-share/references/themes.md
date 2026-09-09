# Themes and reading appearance

Generated pages have a small **Appearance** button at the top right of a sticky bar. It opens the Theme selector and Light, Dark, and System buttons. Choices apply immediately and persist where browser storage is available. Close with the same button, Escape, or a click outside. The page remains readable without JavaScript or storage.

| Theme | Style |
| --- | --- |
| Clarity | Clear sans-serif type, neutral surfaces, blue accents. The default. |
| Ledger | Warm paper and generous serif text. |
| Fieldnotes | Green accents, humanist type, softer shapes. |
| Blueprint | Technical blue, monospace headings, square details. |

The thin line beneath the bar measures reading progress through the article. It reaches the end before the footer and adapts when content expands. The public homepage and missing-page screen offer appearance controls without article progress. Printing omits the bar and uses a light palette.

Set an author’s initial theme in MDX frontmatter:

```yaml
theme: ledger
```

Allowed values are `clarity`, `ledger`, `fieldnotes`, and `blueprint`. The reader’s saved theme takes precedence. A mode-only choice preserves the author’s theme; System follows device appearance. Settings do not change MDX source or access permissions.

Imported HTML keeps its own design. The password prompt follows the device’s appearance; reader preferences apply after authorized content loads. Fonts, CSS, and scripts are local or inline, with no theme/font network requests.

For extensions, use the semantic variables in `runtime/styles/theme.css`; theme names live in `runtime/lib/themes.ts`. Preserve contrast, 44px control targets, visible keyboard focus, mobile fit, reduced-motion behavior, and print fallback. See [extensions](extensions.md).
