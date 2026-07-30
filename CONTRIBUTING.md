# Contributing to SendPlug

Small, focused improvements are welcome.

## Before opening a pull request

1. Open an issue first for behavior changes or new features.
2. Keep the change limited to one clear problem.
3. Never commit Gmail App Passwords, API tokens, environment files, databases, or production data.
4. Preserve the Gmail-only SMTP boundary and account ownership checks.

## Validate locally

```bash
bun install
npm install --prefix web
bun run test
bun run typecheck
npm run build --prefix web
```

For PostgreSQL integration work, use the disposable Compose stack documented in [README.md](README.md). Include a regression test for non-trivial logic.

## Pull requests

Describe what changed, why it was needed, and how you tested it. Do not include generated build output or unrelated formatting changes.

Security reports belong in the private process documented in [SECURITY.md](SECURITY.md), not in public issues.
