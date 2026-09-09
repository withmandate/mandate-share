# Mandate Share

An artifact library for Codex and Claude Code: keep, find, update, preview, and share pages. Runtime source lives in `skills/mandate-share/runtime`; the skill and bootstrap are packaged beside it. User content, credentials, publisher state, and generated output live in external stores.

Use the root package scripts to test, typecheck, verify packaging, and run the CLI. Public source contains synthetic examples only. Never write ordinary content or credential state into the installed tool. All commands resolve one explicitly selected or configured default store.

Contributor branch and release authority comes from the caller's task; task branches use `codex/`. Preserve unrelated user files.
