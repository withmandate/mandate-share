# Verify a release

Run the package check, tests, and typecheck against the source being released. Verify a disposable installation and update with explicit agent targets, external stores, preserved passwords, private defaults, and opt-in homepage/search behavior. Compile the Worker without uploading it, then report live publication checks separately.

Before publishing source, review the public-file allowlist, every reachable Git revision, the proposed license, and source/dependency notices. Confirm that examples are synthetic and that no content, verifier record, credential, account default, private machine path, or sibling dependency entered the package. The repository's `check:package` command checks the current tree, index, and reachable revisions; rerun it after the final commit.

Use the packaged bootstrap in the installation check. Confirm that only the selected agents receive the skill and that both can use the intended store when both were selected. Have a fresh agent follow the installed skill; directory inspection alone does not demonstrate that workflow.

Use a dedicated synthetic store and destination for live testing. After its inventory is authorized and uploaded, inspect anonymous access, wrong and correct passwords, direct HTML/MDX sources, homepage visibility, and an update at the real URL. A dry-run and a local publication receipt do not replace those checks.

Record the source revision, checks performed, selected installation targets, and any verification gaps. Keep credentials, password records, and private account details out of public release notes. Source publication and live page publication require their respective authorization.
