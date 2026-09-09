# Passwords and saved choices

The user can tell you a password or say “Let me enter it myself.” If they tell you, use it without repeating it back; it may remain in the chat. Never put the value in command arguments, generated pages, source control, or ordinary logs.

Suggest a long, unique shared passphrase for the library or intended audience. Everyone who receives it can open the pages using that password.

When they want to type it themselves, run the command for their chosen password:

```sh
mandate-share password --default
mandate-share password briefing
mandate-share password --profile client-review
```

The command returns a URL and waits. Open that address in the user’s browser. Let them type and confirm the password, choose **Save password**, and wait for the saved result. Do not inspect the field, clipboard, or request body. This keeps the password out of chat.

The browser hashes the password and sends only its verification record to a temporary endpoint tied to the chosen change. Software with full access to the same computer can still inspect it; this flow keeps the value out of the conversation.

Use a page’s full published URL instead of its slug when convenient. It must resolve to a page in a registered store; the command never fetches an arbitrary remote URL to guess where it belongs. Pass `--store NAME` for a named store. The screen shows the library and password being changed.

Add `--terminal` for hidden terminal input, or `--stdin` when passing a chat-supplied password through an appropriate protected input channel. Do not construct a shell command containing the password. Empty, oversized, or malformed password input fails rather than silently removing protection.

## Defaults, profiles, and page overrides

The default applies automatically to newly encountered private pages. A name such as `client-review` identifies a reusable password profile, not a user account. List saved profiles with `password --list`, then assign one:

```sh
mandate-share password briefing --use-profile client-review
```

Page overrides persist through content updates. Defaults, named choices, and bindings live in private store configuration so a new agent session can find them. The tool stores salted password verification records instead of reusable plaintext. It can apply a saved profile again, but cannot reveal its original password; copied profile verifiers share their salt. Cookie-signing keys are separate and bind access to the store and page.

Changing a default or named profile affects future assignments. To change existing pages, show the affected pages and use an explicit list:

```sh
mandate-share password --rotate-profile client-review briefing project-update
```

That applies the profile’s current verifier to the selected pages. One page accepts one active password; multiple recipient-specific passwords for the same page are outside this model. Anyone with the shared password can open the page.

Saving a password is local. An existing live page changes only after a reviewed publication. Verify the live page after that publication. If the user entered the password themselves, let them open the live page with it; do not recover the password through browser automation.

## Reader unlocks

A published site works without the publisher’s computer. Cloudflare sends a small password screen containing native Web Crypto code only when a page is locked. Derivation runs in the visitor’s browser on submit; the Worker checks the submitted proof with a fast hash and issues a signed cookie. Public and authenticated page responses gain no unlock script, package or extra request. JavaScript and a current HTTPS-capable browser are required to unlock; there is no server-side password-derivation fallback.

The submitted proof is a password-equivalent credential within its shared profile. Send it only over HTTPS and never retain it in logs, browser storage, generated content or the saved profile. Saved verification records contain a second hash; they are not the value the browser submits. Profile sharing remains intentional, while cookies remain bound to each store and page.

Page cookies do not isolate unlocked content from scripts on the same site. Review the [HTML trust boundary](raw-html.md#review-active-html) when hosting active HTML alongside protected pages.

## Open access

To remove protection, follow [privacy](privacy.md) and explicitly select an unlisted link or a public page. Removing a password does not implicitly grant search indexing. Private pages without a password fail publication.
