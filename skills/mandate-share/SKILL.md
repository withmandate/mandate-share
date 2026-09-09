---
name: mandate-share
description: Keep, find, update, preview, and share MDX or HTML artifacts in the user’s own library. Use when the user wants to save or revisit a briefing, project update, explanation, or HTML page, share a link, or use Mandate Share. Pages are private by default, with optional Cloudflare publishing.
---

# Mandate Share

Help the user keep and revisit an artifact library across Codex and Claude Code. Create or import pages, find existing work, and update it in place. Provide a checked local preview and publish a live link when requested. Operate the commands for the user and explain only the choices they need to make. This skill includes its runtime and needs Node.js 22.20+ with npm.

For first use, a missing command, Cloudflare connection, or an update, read [setup](references/setup.md). Setup installs `mandate-share`; until it is available, resolve `scripts/run.mjs` relative to this installed `SKILL.md` and invoke it with Node by absolute path. The runtime restores locked dependencies into its own cache. Never install dependencies or store pages inside the skill.

Select one external store, the folder holding a library: use `store list`, the configured default when unambiguous, or the user’s named store with `--store NAME`. Keep that selection throughout the operation. To find existing work, run `list --store NAME` and inspect the matching source. Keep the existing page’s slug when updating it to preserve its link and password choices. Tool updates preserve stores and existing pages.

**Pages are private by default.** “Share this” or “publish this” does not request password-free access, homepage listing, or search indexing. A private page needs a default or page password before publication. For an explicit change in audience or discoverability, read [privacy](references/privacy.md). Never make pages public to get past a failed build or publication check.

Read only the workflow needed:

- Create or edit MDX: [authoring](references/mdx.md). Build the store, read its component catalog, then author in `digests/`.
- Host existing HTML unchanged: [raw HTML](references/raw-html.md).
- Set a default, per-page, or named password, or let the user type it in their browser: [passwords](references/passwords.md).
- Publish, update, or remove live pages: [publishing](references/publishing.md).
- Choose appearance or customize the reader: [themes](references/themes.md).
- Add a store component: [extensions](references/extensions.md).

After changes, build and preview the selected store. Use the returned URL; never assume a port. Inspect rendering and the relevant locked/unlocked/source routes. The user can tell you a password or say “Let me enter it myself.” For the latter, open the password screen in their browser and let them type, confirm, and choose Save password. Do not inspect the field, clipboard, or request body. Let them enter that password for the live page check too. Report the working link, source location, sharing choice, and whether publication actually occurred.

MDX and custom components execute locally during the build; inspect untrusted material before using it. MDX pages include their source for reuse. Raw HTML keeps its scripts and original bytes. Those scripts can read other pages the visitor has unlocked on the same site; follow the [HTML trust boundary](references/raw-html.md#review-active-html) before hosting it.
