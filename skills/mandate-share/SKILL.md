---
name: mandate-share
description: Keep, find, update, preview, and share MDX or HTML artifacts in the user’s own library. Use when the user wants to save or revisit a briefing, project update, explanation, or HTML page, share a link, or use Mandate Share. Pages are private by default, with optional Cloudflare publishing.
---

# Mandate Share

Help the user keep and revisit an artifact library across Codex and Claude Code. Create or import pages, find existing work, and update it in place. Check local rendering yourself and complete authorized sharing with a verified live link. Operate the commands for the user and explain only the choices they need to make. This skill includes its runtime and needs Node.js 22.20+ with npm.

For first use, a missing command, Cloudflare connection, or an update, read [setup](references/setup.md). Setup installs `mandate-share`; until it is available, resolve `scripts/run.mjs` relative to this installed `SKILL.md` and invoke it with Node by absolute path. The runtime restores locked dependencies into its own cache. Never install dependencies or store pages inside the skill.

Select one external store, the folder holding a library: use `store list`, the configured default when unambiguous, or the user’s named store with `--store NAME`. Keep that selection throughout the operation. To find existing work, run `list --store NAME` and inspect the matching source. Keep an existing page’s slug to preserve its link, and preserve its access and password choices on updates unless the user explicitly changes them. Tool updates preserve stores and existing pages.

**Private is the fallback without sharing consent.** Honor an explicit saved sharing preference in the user’s or agent’s profile when it applies to the selected store and task, such as unlisted links or a named password profile. A current explicit request takes precedence. “Share this” or “publish this” alone does not choose password-free access, homepage listing, or search indexing. A private page needs a default or page password before publication. Read [privacy](references/privacy.md) to apply an audience choice; never make pages public to get past a failed build or publication check.

Read only the workflow needed:

- Create or edit MDX: [authoring](references/mdx.md). Build the store, read its component catalog, then author in `digests/`.
- Host existing HTML unchanged: [raw HTML](references/raw-html.md).
- Set a default, per-page, or named password, or let the user type it in their browser: [passwords](references/passwords.md).
- Publish, update, or remove live pages: [publishing](references/publishing.md).
- Choose appearance or customize the reader: [themes](references/themes.md).
- Add a store component: [extensions](references/extensions.md).

After changes, build and preview the selected store. Use the returned URL; never assume a port. Inspect rendering and the relevant locked/unlocked/source routes. Local preview is agent QA; the user need not open it before authorized publication. When the configured destination and task or standing publication authorization cover the exact selected-store inventory, follow [publishing](references/publishing.md) through publication and live verification. Authorization for one page does not cover unrelated files bundled from the store.

The user can tell you a password or say “Let me enter it myself.” For the latter, explain that the local password screen keeps the value out of chat, then open it in their browser and let them type, confirm, and choose Save password. Do not inspect the field, clipboard, or request body. Saving is local; publish the authorized change for readers to receive it. Let them enter that password for the live page check too. Report the live link when published, source location, sharing choice, and any unfinished verification. Published pages work without the publisher’s computer.

MDX and custom components execute locally during the build; inspect untrusted material before using it. MDX pages include their source for reuse. Raw HTML keeps its scripts and original bytes. Those scripts can read other pages the visitor has unlocked on the same site; follow the [HTML trust boundary](references/raw-html.md#review-active-html) before hosting it.
