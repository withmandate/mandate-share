# Host existing HTML unchanged

Import a complete UTF-8 HTML document into the selected store:

```sh
mandate-share import "/absolute/input/page.html" --slug project-brief --title "Project brief" --store personal
```

The page starts private. A saved default applies to new private pages; otherwise assign a password before publication. To make an unlisted password-free link or list it publicly, follow [privacy](privacy.md). Import metadata alone does not authorize open access. Titles and summaries live outside the HTML, in `raw/manifest.json`, preserving the file’s bytes.

Omit `--slug` to allocate a random available slug. Slugs use lowercase letters, digits, and hyphens, with at most 80 characters. Keep a slug when updating its URL:

```sh
mandate-share import "/absolute/input/revised-page.html" --slug project-brief --store personal
mandate-share preview project-brief --store personal
```

An update preserves existing access and sharing choices. A slug owned by MDX cannot be replaced with HTML. Self-contained HTML travels best; relative assets are not imported automatically. The hosting gate applies access and no-index headers without modifying the file’s design or bytes.

## Review active HTML

Host HTML whose scripts you have reviewed and trust. Pages at the same site address share a browser origin: a script in one page can fetch and read other pages that visitor has already unlocked there. `HttpOnly` hides cookie values from scripts but still lets the browser send them with those requests. A separate page password does not isolate its content from other scripts on that site after the visitor unlocks it.

When content needs that separation, use separate stores published at different site addresses. A second folder or a different URL path on the same site is not browser isolation. Check scripts and their external dependencies when importing or updating HTML.
