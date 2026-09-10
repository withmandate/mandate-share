# Themes and reading appearance

Generated MDX pages, the public homepage, and the missing-page screen start with **Clarity** and **System** mode, which follows device appearance. A small **Appearance** button at the top right of a sticky bar opens the Theme selector and Light, Dark, and System buttons. Reader choices apply immediately and carry across navigation, reloads, and tabs on the same browser origin (scheme, host, and port) where browser storage is available. Close with the same button, Escape, or a click outside. The page remains readable without JavaScript or storage.

| Theme | Style |
| --- | --- |
| Clarity | Clear sans-serif type, neutral surfaces, blue accents. The default. |
| Ledger | Warm paper and generous serif text. |
| Fieldnotes | Green accents, humanist type, softer shapes. |
| Blueprint | Technical blue, monospace headings, square details. |

The thin line beneath the bar measures reading progress through the article. It reaches the end before the footer and adapts when content expands. The public homepage and missing-page screen offer appearance controls without article progress. Printing omits the bar and uses a light palette.

The reader’s saved theme and mode take precedence over the defaults. Changing only the mode keeps the current theme. MDX frontmatter still accepts `theme: clarity`, `ledger`, `fieldnotes`, or `blueprint`, but that field does not affect reader appearance. Settings do not change MDX source or access permissions. If browser storage is unavailable, choices work for the current page but cannot persist; clearing stored preferences restores Clarity and System.

Imported HTML keeps its own design. The password prompt follows the device’s appearance; reader preferences apply after authorized content loads. Fonts, CSS, and scripts are local or inline, with no theme/font network requests.

For extensions, use the semantic variables in `runtime/styles/theme.css`; theme names live in `runtime/lib/themes.ts`. Preserve contrast, 44px control targets, visible keyboard focus, mobile fit, reduced-motion behavior, and print fallback. See [extensions](extensions.md).
