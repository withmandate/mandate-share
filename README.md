# Mandate Share

**Your artifact library, across Codex and Claude Code.**

Keep briefings, project updates, explanations, and HTML tools in a library you own. Ask your agent to find something you made earlier, revise it, or turn new material into a readable page with diagrams, tables, code, and expandable detail. Share a link when you’re ready, with a password by default.

Your library lives in a folder on your computer. Codex and Claude Code can work with the same files and saved settings, so you can return to a page from either agent. Published pages live in your own Cloudflare account and remain available when your computer is closed.

## Get started with your agent

Copy this into your coding agent:

```text
Install Mandate Share from withmandate/mandate-share on GitHub and set up my artifact library.

First ask where I want the skill: this agent only, or both Codex and Claude Code. Install globally for the agents I choose using:
npx skills add withmandate/mandate-share --skill mandate-share --global --agent <chosen-agent-ids>
Use codex and/or claude-code as appropriate. Do not install into every agent.

Read the installed skill, check Node.js 22.20+, install the mandate-share command, and suggest a folder for my library. Walk me through Cloudflare sign-in and help me set a default password. If I say “Let me enter it myself,” open the password screen in my browser.

Keep pages private, off my homepage, and out of search indexing unless I explicitly choose otherwise. Create a sample, show me its contents and destination before publishing, and check the live link and password protection.
```

Your agent handles the commands and configuration. You choose the agents, accept or change the suggested folder, sign into Cloudflare, and set your password. If setup is interrupted, ask the agent to finish; it resumes from the remaining step.

Requires **Node.js 22.20+ and npm**. Your agent installs Share’s other dependencies and its command. You can keep working entirely through the agent.

## What to ask for

- “Find the project update I made for my client last week.”
- “Turn this discussion into a briefing I can send to a teammate.”
- “Make a visual explanation of how this project works.”
- “Host this HTML file and keep its design.”
- “Use the password I saved as client-review.”
- “Update the briefing and keep the same link and password.”
- “Make this page public and show it on my homepage.”

You can keep work locally and return to it later. When you ask to publish, your agent previews the result, explains what will be published, and checks the live link.

## Private by default

Every page starts private. A private page needs a password before it can be published; skipping password setup never makes it open to everyone. Private pages do not appear on your site’s homepage.

| Sharing choice | Who can open it? | On your homepage? |
| --- | --- | --- |
| **Private** · default | People with the shared password | No |
| **Unlisted link** · opt in | Anyone with the link | No |
| **Public page** · opt in | Anyone | Yes |

Search indexing is a separate opt-in for public pages. Share sends no-index instructions by default, including for source downloads. An unlisted link or a no-index instruction is not a password lock; choose Private when access should be restricted.

Your public homepage lists only the pages you deliberately make public, most recently updated first. It stays empty until you choose something to list.

## Passwords your way

Tell your agent the password, or say **“Let me enter it myself.”** Your agent opens the password screen in your browser. Type and confirm your password, then choose **Save password**. When you enter it this way, the password stays out of chat.

Choose a long, unique shared passphrase. Keep a default for new pages, give one page a different password, or save a reusable choice named `client-review`. These choices persist across agent sessions. To change a page, name it or give your agent its published link; the screen shows what you are changing.

Visitors use a normal password box in a current browser with JavaScript enabled. The small unlock script appears only on the password screen; public pages and already-unlocked pages load no extra password code or package.

Share saves password verification records so it can reuse a saved choice without retaining or revealing the original password. Anyone with that password can open its pages. Changing the default affects future pages; ask explicitly to change existing pages too. Changes are saved locally, so ask your agent to publish them when updating a live page. [Password commands and hidden terminal entry](skills/mandate-share/references/passwords.md).

## Your library, your Cloudflare account

Start with one folder for your library. Share calls it a **store**: your files, private settings, and one publishing destination. Updating the skill preserves it. Later, ask for another store to separate personal and client work, or a separate private Git repository for backups.

Your agent walks you through Cloudflare account creation or sign-in, finds your account, and configures a site. Protect that account with two-factor authentication. Use Cloudflare’s provided address first; a custom domain can come later. You do not need to find account IDs or edit hosting configuration.

Start on **Cloudflare Free**, including password-protected sharing. Its allowance is **100,000 Worker requests per day**, **20,000 asset files per deployment**, and **25MiB per file**. Share routes requests through a Worker to enforce access and search preferences, so its traffic uses that allowance. HTML and downloadable source count as separate files. Share checks file capacity before upload, and your agent verifies the live link. Basic password protection does not require a paid plan. [Cloudflare pricing](https://developers.cloudflare.com/workers/platform/pricing/) · [Limits](https://developers.cloudflare.com/workers/platform/limits/) · [Asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)

## Comfortable to read

Choose **Clarity**, **Ledger**, **Fieldnotes**, or **Blueprint**, each with light and dark modes. A small Appearance button at the top right holds the settings and remembers the reader’s choice. A thin line in the sticky bar shows progress through the article. Imported HTML keeps its original design.

Review imported HTML before hosting it: its scripts can read other pages a visitor has unlocked on the same site. Use separate stores at different site addresses when that content needs isolation. [HTML guidance](skills/mandate-share/references/raw-html.md#review-active-html).

## Get updates

Ask your agent:

```text
Update only the mandate-share skill from withmandate/mandate-share. Keep my existing agent selection and installation scope, refresh its command if needed, and check the installed version. Preserve my page folders, passwords, and publishing settings.
```

The agent follows the [update instructions](skills/mandate-share/references/setup.md#updates). Updating the tool does not publish pages or change their passwords.

<details>
<summary>Install it yourself, or use a local checkout</summary>

For Codex and Claude Code, globally:

```sh
npx skills add withmandate/mandate-share --skill mandate-share --global --agent codex claude-code
```

Keep just the agent ID you want. Omit `--global` for installation in the current project. Then ask that agent to read Mandate Share and complete setup, including its command.

To work from source on your computer:

```sh
git clone https://github.com/withmandate/mandate-share.git
cd mandate-share
node scripts/prepare-local-install.mjs
```

Have your agent install the returned `sourcePath` with the same `npx skills add` options above, then finish setup. This clean copy keeps development dependencies and untracked files out of the installed skill. The agent remembers the original checkout for updates; your pages still belong in their own folder. [Skills installer options](https://github.com/vercel-labs/skills#options)

</details>

## Working on Mandate Share

Use a local checkout to change the skill, renderer, themes, or publishing behavior. See [CONTRIBUTING.md](CONTRIBUTING.md) for development and verification.

[MIT licensed](LICENSE) · [Source and dependency notices](skills/mandate-share/references/notices.md)
