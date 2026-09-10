# Install, connect, and update

Help the user choose agents, a folder for their library, and sharing preferences, then guide browser sign-in for publishing. Reuse explicit preferences already saved in their user or agent profile when applicable. Operate the tooling for them. Save and reuse completed steps; do not start another store or site when they ask to finish setup.

## Install for the chosen agents

Ask which agents they want: the current agent only, or Codex and Claude Code together. Use explicit agent IDs and the requested global/project scope. Never use `--all`, a wildcard agent, or an unqualified noninteractive install. For Codex and Claude Code globally:

```sh
npx skills add withmandate/mandate-share --skill mandate-share --global --agent codex claude-code
```

Use only the selected IDs. Omit `--global` for a project installation. Add `--yes` only after the source, skill, agents, and scope are resolved. The installer may use a shared canonical skill folder plus links; do not create additional agent-specific folders yourself. A new session may be needed for discovery.

For a local checkout, first run `node /absolute/checkout/scripts/prepare-local-install.mjs`. Install the returned `sourcePath` with the same explicit skill/agent/scope options. The helper copies only the repository’s declared public files, excluding development dependencies and stray local files that the skills installer would otherwise copy. Keep `originalSource` as the installation source in the command metadata, then remove the exact temporary `sourcePath` after installation; the installed skill has its own copy. Do not use a developed checkout directly as the installer input.

Check Node.js 22.20+ and npm. Resolve the installed `SKILL.md` through the actual installation result or agent catalog. Run its helper by absolute path; for example, after selecting both agents globally:

```sh
node /absolute/installed/mandate-share/scripts/install-command.mjs --agents codex,claude-code --scope global
```

For a local-source installation add `--source /absolute/checkout`. For project scope also supply `--project-root /absolute/project`. The helper installs a copied npm command wrapper into a stable user-local directory, records the selected skill and installation choices, and maintains an owned PATH entry. Use its returned command path immediately if the current process has not refreshed PATH. No sudo or separate npm registry package is needed.

The helper refuses an unrelated command or an unexpected installed-skill switch. Inspect a conflict before changing anything; `--use-this-skill` selects a different Share installation only when that is intended. `--status` reads the saved installation choices. `--prefix` and `--no-path` support isolated tests or an explicitly chosen command location.

## One folder, then a password

Follow the user’s stated folder conventions when choosing a library location. Run `mandate-share setup`; with no store, it returns a fallback suggestion. Adapt that suggestion to the user’s layout and initialize the chosen folder:

```sh
mandate-share setup --path /absolute/pages-folder
```

The first store is named `personal` and becomes the default. Use `--store NAME` with `--path` to create or resume a named store. The folder must be empty or initialized, and separate from the tool, cache, configuration, and other stores. Routine work uses the default; explicit named-store work carries `--store NAME` throughout.

Pages start private unless an explicit request or applicable saved sharing preference selects another audience; follow [privacy](privacy.md). For password protection, reuse the chosen saved profile or suggest a long, unique shared passphrase. The user can tell you the password or say “Let me enter it myself.” For the latter, run `mandate-share password --default` and explain that its returned URL is a local setup screen that keeps the value out of chat. Open it in their browser, let them type, confirm, and choose Save password, then wait for the saved result; follow [passwords](passwords.md). Saving is local and needs publication to reach readers. Skipping a default leaves private pages unpublished until they receive a page password or the user explicitly chooses open access. Do not turn a missing password into public consent.

## Connect Cloudflare

`setup` checks the current authentication and selected store. Respond to its state:

- `login-required`: explain that Cloudflare will host their published pages. Run `mandate-share setup --login`; the official browser flow handles sign-in, account creation, verification, and authorization. Keep account credentials out of chat.
- `choose-account`: show the returned account names and ask which to use. Pass its returned ID through `setup --account-id ID`; the user need not find or type it.
- `ready`: explain the proposed site address and actions. Setup reuses an existing account address, proposes a name only if one is absent, and avoids replacing an unrelated Worker. Apply the concrete setup within the user’s authorization using `setup --confirm DIGEST`. If Cloudflare requires a dashboard step, open the returned onboarding URL and guide it, then resume setup.
- `configured`: the destination is ready for a sample. It is not yet a live-verification result.

Optional `--worker` or `--subdomain` lets the user choose a proposed name before confirmation. Do not rename an existing account subdomain. A custom domain is an optional advanced setup, not a first-run requirement; see [publishing](publishing.md).

During sign-in, recommend [two-factor authentication for the Cloudflare account](https://developers.cloudflare.com/fundamentals/account/account-security/2fa/), which controls the published site. Let the user manage account authentication in Cloudflare; keep recovery codes out of chat and the library.

Use Cloudflare Free for normal setup. The password screen performs derivation in the visitor’s browser, and the Worker performs a fast final check. Read the current [publishing limits](publishing.md#cloudflare-behavior-and-limits) and verify the live password flow. Do not require a paid account for basic protection, remove protection to fit a limit, or change billing without the user choosing it.

Create a harmless sample and preview it yourself. Make the page, protection setting, and destination reviewable without requiring the user to open the local preview. Follow [publishing](publishing.md) through publication and live checks when the task or standing authorization covers the exact store inventory. If the user entered the password themselves, let them open the live page with it in their browser. Finish with the live link, pages folder, and saved sharing preference. Published pages work without the publisher’s computer. Report an unfinished step accurately and retain completed work.

## Updates

When asked to update Share, read the installed helper’s `--status` result. Reuse its source, selected agents, and scope. If that metadata is unavailable, resolve the intended agents and scope before proceeding. Inspect any locally modified skill before replacement. Update just this skill by repeating the explicit installation, for example:

```sh
npx skills add withmandate/mandate-share --skill mandate-share --global --agent codex claude-code --yes
```

Substitute the recorded source and agent IDs; use the recorded project directory and omit `--global` for project scope. If the source is a local checkout, run its clean-copy helper again and use the new temporary `sourcePath` for add while preserving the original checkout in metadata. Re-read the updated skill, rerun its command installer with the same choices, and check `mandate-share version` and `status`. If the installer moved the selected skill, verify that move before using `--use-this-skill`. Remove only the temporary source copy when finished.

Repeat the explicit `skills add` command to preserve the chosen targets; do not substitute a bulk skill update. [Installer documentation](https://github.com/vercel-labs/skills#options)

Tool updates do not publish pages. Source, private password profiles, sharing choices, components, and provider settings remain in the external store. Existing pages retain their passwords. A page without explicit sharing consent defaults to private.

## Storage and repair

The external store contains `digests/`, `raw/`, `access/`, and `components/`. Its ignored `.mandate-share/` contains private defaults, provider settings, preview state, generated output, and release candidates. Optional Git backup uses a separate private content repository; inspect its inventory before pushing.

The configuration registry normally lives at `~/.config/mandate-share`, replaceable runtime caches at `~/.cache/mandate-share`. `MANDATE_SHARE_HOME` and `MANDATE_SHARE_CACHE` override them for isolated work. The installed skill may be read-only. A failed dependency restore never activates a partial cache; repair only the specific cache named by the error, never a pages folder. Inspect lock ownership before removing an abandoned lock.

Updates can return a new preview URL. Preview servers retire themselves when a replacement takes over their store’s registry. Use the returned URL and verify its selected store. Never stop a process based on an unchecked saved PID.
