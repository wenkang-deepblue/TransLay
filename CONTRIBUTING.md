# Contributing To TransLay

Thanks for helping improve TransLay. This project handles user documents, OAuth tokens, cloud infrastructure, and billing-adjacent state, so contributions need to keep privacy and deployment safety first.

## Ground Rules

- Code, identifiers, and comments should be written in English.
- Do not commit secrets, private GCP identifiers, OAuth client secrets, service account keys, `.env`, `.firebaserc`, `.clasp.json`, `.clasprc.json`, database dumps, or generated API payloads.
- Do not add logging of source document text, translated text, speaker notes, comments, OAuth tokens, or provider raw output.
- Do not add dependencies with licenses outside Apache-2.0, MIT, BSD-style licenses, ISC, or BlueOak-1.0.0 without maintainer approval.
- Keep the add-on isolated from PostgreSQL, Redis, Cloud Tasks internals, model providers, and worker internals.
- Keep worker execution authenticated through Cloud Tasks OIDC in production-like environments.

## Development Setup

1. Install Node.js 22 or newer.
2. Run `npm ci` from the repository root.
3. Copy `.env.example` to your local `.env` files as needed and replace placeholders.
4. Build the shared packages and services:

```bash
npm run build --workspace=@translay/shared-contracts
npm run build --workspace=@translay/shared-domain
npm run build --workspace=@translay/shared-config
npm run build --workspace=@translay/control-plane
npm run build --workspace=@translay/worker
```

## Before Opening A Pull Request

- Run the relevant build or tests for the component you changed.
- Run `npm run security:secrets`.
- Confirm that any screenshots, fixtures, or logs are sanitized.
- Update documentation when changing setup, security posture, APIs, migrations, or deployment behavior.

## Security Issues

Report vulnerabilities privately. See `SECURITY.md`.

## License

Unless explicitly stated otherwise, contributions are accepted under the Apache License 2.0. Third-party dependencies retain their own licenses; see `THIRD_PARTY_NOTICES.md`.
