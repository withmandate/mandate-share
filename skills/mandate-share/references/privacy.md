# Access, homepage listing, and search

A page starts private. Explicit sharing consent is stored separately in the external store’s `access/sharing.json`. The presence of a password always keeps the effective page private.

| Choice | Access | Homepage | Search |
| --- | --- | --- | --- |
| Private | Shared password required; publication stops if absent | Hidden | No-index |
| Unlisted | Anyone with the link | Hidden | No-index |
| Public | Anyone | Listed, latest update first | No-index unless separately opted in |

Do not infer public consent from a request to share, host, or publish. Ask for a missing default/page password or use the previously saved default. An unlisted URL is discoverable if passed along; a no-index directive asks crawlers not to index it and does not restrict access.

Use an explicit command only when the user requests the corresponding audience change:

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
