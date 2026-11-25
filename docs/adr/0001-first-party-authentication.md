# 0001: First-party email/password authentication

- Status: Accepted
- Date: 2026-11-25

## Context

Feedback Lab must distinguish a signed-in researcher from a signed-in non-researcher and from a signed-out visitor. Researcher access is granted by a maintainer outside the app; issue #1 does not include public sign-up, in-app role changes, or an identity-provider setup workflow.

The implementation environment had no Cloudflare account, no Cloudflare Access application, no OAuth client, and no deployed identity provider. The app must be fully testable locally and deployable without a vendor-specific identity configuration. At the same time, the authentication boundary must be real enough that HTML routes and direct API requests share the same server-side authorization check.

## Decision

Use first-party email/password authentication backed by D1:

- Users live in `users` with role `researcher` or `member`.
- Passwords are PBKDF2-HMAC-SHA256, 100,000 iterations, a 16-byte salt, and a 32-byte hash, stored as `pbkdf2-sha256$100000$<saltB64>$<hashB64>`. Verification uses a constant-time comparison.
- Sessions are D1 rows. A random 32-byte token is sent in an `HttpOnly`, `SameSite=Lax` cookie; only its SHA-256 hash is stored. Sessions expire after seven days. Cookies are `Secure` on HTTPS.
- Every authenticated POST requires a per-session CSRF token, and a present `Origin` header must match the request origin.
- A maintainer provisions accounts with `scripts/provision-user.mjs`, which generates a password and writes only its hash to D1.
- Researcher authorization is a separate role check from authentication. A signed-in `member` is authenticated but forbidden from assignment and history routes, including direct API calls.

## Consequences

- The application has no dependency on an external identity provider and can run and test in the Workers runtime with only D1.
- Maintainers must provision accounts manually and distribute generated passwords through a secure channel. There is no password reset, rate limiting, MFA, or session-management UI.
- The auth code is application-owned and must be reviewed and hardened before production use. A future migration to Cloudflare Access, OAuth, or another IdP should preserve the separate role check so `member` remains denied.
- Session revocation is per-row in D1. Sign-out deletes the session; there is no global revoke-all action in this issue.
- Read-only historical views and all write routes use the same guard, so authorization cannot be bypassed by calling the API directly.

## Alternatives considered

- **Cloudflare Access**: preferred for a deployed Cloudflare app, but no Access application, policy, team domain, or credentials were available, and local end-to-end tests would still need a bypass. Deferred as a deployment-hardening option.
- **GitHub OAuth**: requires a registered OAuth app and credentials, and couples research access to GitHub accounts. Not available in the environment and not necessary for the prototype.
- **Magic links or email delivery**: requires an email provider and delivery configuration that was unavailable, plus additional token and abuse protections.
- **No authentication / shared password**: would not support two distinct roles or demonstrate the required denial of signed-in non-researchers.

## Follow-up before production

- Add rate limiting and lockout for sign-in.
- Add password reset and account lifecycle procedures.
- Consider MFA or migration to a managed identity provider.
- Add session cleanup for expired rows and a revoke-all-sessions action.
- Reassess CSRF and cookie settings against the final deployed origin and TLS termination.
