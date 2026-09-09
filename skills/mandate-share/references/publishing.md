# Review and publish one store

Connect a first destination through the guided [setup](setup.md#connect-cloudflare) flow. It discovers authentication and accounts, reuses or registers the account’s provided address, and saves a store-specific destination. Browser sign-in and verification belong to the user. Provider credentials stay with Wrangler or the user’s protected environment.

## Prepare the page inventory

Select the intended store, build and preview its pages, and resolve any missing private-page passwords. Every private page must have a verifier before publication. Homepage listing and search indexing need explicit consent; see [privacy](privacy.md). Then prepare a release:

```sh
mandate-share plan --store personal
```

The result freezes one store’s assets, access/sharing state, Worker, destination, and configuration. Review the actual pages and files, including other pages already in the store and any removals. Make the destination, password-free pages, homepage entries, and indexing choices clear in ordinary language. Confirmation digests and cache paths are implementation details for the agent to operate.

A comparison uses the last successful local receipt; it is not fresh evidence of what currently exists remotely. A first publication has no earlier local inventory to compare. Guided setup rechecks the provider account and destination before planning or publication.

## Publish the reviewed result

Use existing authorization when it covers the exact destination and changes; otherwise obtain the remaining approval after making the result reviewable. Publish only that candidate:

```sh
mandate-share publish --confirm RETURNED_DIGEST --store personal
```

Changed source, access/sharing state, destination, compiled Worker, or candidate files invalidate confirmation. Prepare and review again after a change. A consumed candidate cannot be replayed. Successful publication records a local receipt; inspect the returned live URL before reporting verification.

Check the homepage for deliberately public pages only. Check an unauthenticated request, an incorrect password, successful authorized access, and direct HTML/MDX routes for protected pages. If the user entered the password themselves, let them open the page with it in their browser. Verify requested removals and updates. Report any unfinished live check rather than inferring it from a deploy command.

## Cloudflare behavior and limits

Every request goes through the Worker so access and search choices cover raw HTML as well as generated pages. Protected and password-free traffic both use the Worker request allowance. Private and unlisted responses use no-index headers; only explicitly indexable public HTML can allow indexing. Source downloads, errors and password prompts remain no-index. Raw HTML bytes are unchanged.

The Free plan currently provides 100,000 Worker requests/day, 10ms CPU per invocation, 20,000 asset files per deployment and 25MiB per file. Share checks generated file sizes/counts and header-rule limits before upload. The password screen performs expensive derivation only in the reader’s browser, then uses a fast Worker check and a signed cookie. Its inline script needs no third-party dependency or additional request; ordinary page files are unchanged.

Start with Free and verify the actual destination, hosting quotas, and complete password flow. Do not prescribe an upgrade for basic passwords or change billing without the user choosing it. [Limits](https://developers.cloudflare.com/workers/platform/limits/), [pricing](https://developers.cloudflare.com/workers/platform/pricing/), [asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/).

The generated Worker limits password submissions to ten attempts per minute for each visitor address and shared password profile. Alternate page URLs and pages using the same saved password share that allowance. Cloudflare's counters are approximate and local to each data center; this slows guessing rather than guaranteeing a global request cap. A throttled reader sees a one-minute retry message. Reading public pages or pages already unlocked does not use the attempt counter. If the limiter is unavailable, new unlocks stop safely. [Worker rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

## Use an existing Cloudflare destination

When the user wants this store to publish to an existing Worker, review its exact account, deployed versions, and address:

```sh
mandate-share setup --adopt --account-id ACCOUNT_ID --worker WORKER_NAME --domain HOSTNAME --store personal
```

Use `--workers-dev` instead of `--domain HOSTNAME` for an existing workers.dev address. Explain what the next publication will replace, then apply the reviewed destination with `setup --adopt --confirm RETURNED_DIGEST --store personal`. This saves consent and local configuration without uploading pages. The Worker and hostname are checked again before publication; configuration alone does not establish ownership. Review the complete store inventory before replacing a live deployment.

## Advanced destination configuration

For an already understood account and destination, explicit local setup remains available:

```sh
mandate-share setup --account-id ACCOUNT_ID --worker my-share-pages --workers-dev --store personal
```

Use `--domain share.example.com` instead of `--workers-dev` for a custom hostname in that account. This path saves local configuration and does not complete guided account/subdomain checks or create DNS. Prefer guided setup for a new user. Independent stores cannot reuse the same account/Worker pair or hostname.

The runtime uses pinned Wrangler from its managed cache, not another project’s configuration. A no-upload dry-run uses isolated fake configuration and proves local compilation only.
