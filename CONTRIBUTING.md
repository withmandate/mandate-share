# Working on Mandate Share

The installable skill includes its runtime under `skills/mandate-share/`. User pages, access settings, credentials, and generated output belong in external stores. Use synthetic examples and temporary store/cache/configuration directories when developing.

Use Node.js 22.20+ and npm:

```sh
npm ci --prefix skills/mandate-share/runtime
npm test
npm run typecheck
npm run check:package
npm run test:install
```

Run the source CLI with `npm run cli -- help`. The installation proof uses disposable homes and external fixture stores; it must preserve the actual user’s installed skills and content. Meaningful changes to access, privacy, installation, or publication require regressions through the real command and HTTP paths. Reader changes need desktop/mobile and keyboard checks in both light and dark modes.

Before installing from a developed checkout, run `node scripts/prepare-local-install.mjs` and give its returned `sourcePath` to `npx skills add` with explicit agent targets. The skills installer otherwise copies ignored files such as `runtime/node_modules`. Save the helper’s `originalSource` as the source for future updates, and remove the temporary copy after installation.

The public package uses an explicit file allowlist. Update it when adding or removing distributable source, then run the package check and refresh dependency notices after dependency changes. The check examines reachable Git history as well as the working tree; private files do not belong in either.

Keep the skill entry point short. Put conditional setup, password, publishing, and authoring details in the relevant reference. Verify commands against the installed copy, and describe actual behavior rather than planned features.

Publication freezes a concrete store, target, Worker and file inventory. A dry-run proves compilation; only a real HTTP check proves live behavior. Never use an existing user destination as a test fixture. See [release checks](skills/mandate-share/references/release-checks.md).
