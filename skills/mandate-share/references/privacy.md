# Access, homepage listing, and search

A page starts private. Explicit sharing consent is stored separately in the external store’s `access/sharing.json`. The presence of a password always keeps the effective page private.

| Choice | Access | Homepage | Search |
| --- | --- | --- | --- |
| Private | Shared password required; publication stops if absent | Hidden | No-index |
| Unlisted | Anyone with the link | Hidden | No-index |
| Public | Anyone | Listed, latest update first | No-index unless separately opted in |

Apply the user’s explicit audience choice, including a saved preference in their user or agent profile when its scope covers this store and task. For example, a saved unlisted preference can guide new pages; it does not grant homepage listing or search indexing. Preserve existing pages’ access and passwords on updates unless explicitly changed. Without applicable consent, keep the page private and use a saved password or obtain the missing password. A request to share, host, or publish alone does not choose open access. An unlisted URL is discoverable if passed along; a no-index directive asks crawlers not to index it and does not restrict access.

Use the command matching the explicit request or applicable saved preference:

```sh
mandate-share sharing briefing --private
mandate-share sharing briefing --unlisted
mandate-share sharing briefing --public
mandate-share sharing briefing --public --indexable
```

The latter three remove an existing password, so explain that consequence when making the choice concrete. `--public` alone lists the page but does not allow search indexing. `--public --no-index` keeps it listed while turning indexing off. Changes need publication to affect the live site. Removing search permission cannot retract copies already held by a crawler or reader.

The homepage excludes private and unlisted titles, summaries, and links. The default homepage is empty. Local `list` is an author tool and can show all pages; never publish its output as a directory without the user’s request.

Access and search rules cover clean URLs, `.html`, and `.mdx` source routes. Source downloads, password prompts, and errors always carry no-index headers. Raw HTML stays byte-for-byte unchanged; the hosting gate supplies its response headers. Recheck wrong/correct password access, direct sources, and the homepage after a privacy change.

The generated `robots.txt` permits crawlers to request URLs so they can read those no-index responses. Blocking crawling would hide the directive and can leave an externally linked URL in search results. Password protection still controls access to private content. [Google’s no-index guidance](https://developers.google.com/search/docs/crawling-indexing/block-indexing).
