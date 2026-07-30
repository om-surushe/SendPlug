# Security policy

## Supported version

Security fixes are applied to the current `main` release. Self-hosters should run a reviewed revision and keep Bun, Python rollback dependencies, container images, the TLS proxy, and the host patched.

## Report a vulnerability

Report suspected vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/om-surushe/SendPlug/security/advisories/new). Do not open a public issue, test against other users, access unrelated data, or disrupt a service. Include the affected revision, impact, and reproduction steps. An acknowledgement is expected within seven days; no bounty is promised.

## Security boundaries

- Email/password signup and login work without OAuth. WorkOS AuthKit is optional account authentication; it does not grant mailbox access.
- Gmail delivery supports App Passwords over SMTP only. SendPlug does not request Gmail OAuth/API scopes. App Passwords cross the API over operator-provided HTTPS, are decrypted in API/worker memory when needed, and are encrypted at rest. This is not end-to-end encryption.
- API tokens are sender-scoped, revocable, shown once, and stored as keyed hashes. A raw token remains a bearer credential.
- PostgreSQL stores account and delivery state. Redis stores queues, auth/rate-limit state, and worker heartbeats. The VM operator, reverse proxy, databases, mounted secrets, logs, process memory, and backups are trusted boundaries.
- Compose publishes only the API on loopback. A maintained reverse proxy must terminate TLS, overwrite `X-Real-IP`, and must not expose PostgreSQL or Redis.
- Redis `noeviction` prevents silent queue eviction, but exhaustion can make sends unavailable. Persistent volumes are not backups.
- `sent` means Gmail accepted the SMTP transaction, not inbox delivery, opening, or reading.

## If a secret is exposed

1. Rotate API tokens manually with overlap: create and deploy a replacement, verify its use, then revoke the old token.
2. Revoke an exposed Gmail App Password at Google, replace it in SendPlug, and test the sender.
3. Rotate recovery and session secrets during maintenance; a session-secret change signs users out.
4. A token-pepper change invalidates every existing API token; plan downtime and reissue them all.
5. There is no online credential-key re-encryption. Replacing it makes stored sender ciphertext unreadable until credentials are re-entered. If the key and database leaked together, revoke every App Password.
6. Preserve evidence, determine the exposure window, and fix the cause before restoration.

See [the cutover runbook](docs/operations/cutover.md) for backups, rollback, and reconciliation.
