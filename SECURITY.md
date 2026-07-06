# Security Policy

TransLay is designed around a strict privacy rule: user document text, translated text, comments, and speaker notes must not be persisted as plaintext in PostgreSQL, Redis, logs, or other durable storage.

## Supported Versions

This repository is in its first public open-source transition. Security fixes should target the current `main` branch unless a maintainer explicitly creates a release branch.

## Reporting A Vulnerability

Please report security issues privately. Do not open a public issue for vulnerabilities that involve authentication, authorization, secrets, data retention, document-content exposure, payment flows, or cloud deployment isolation.

Preferred reporting path:

- Use GitHub Security Advisories for this repository when available.
- If advisories are not enabled on your fork, contact the maintainer through the public support address configured by that fork.

When reporting, include:

- A concise description of the vulnerability.
- Affected component, such as Apps Script add-on, control plane, worker, SQL migrations, Redis usage, Firebase Hosting, or Cloud Run deployment.
- Minimal reproduction steps using sanitized data.
- Whether the issue can expose document text, translated text, speaker notes, comments, OAuth tokens, secrets, GCP identifiers, or billing records.

Do not include:

- Real user document content.
- OAuth tokens.
- Service account keys.
- Database passwords or dumps.
- Customer data.
- Real production GCP project identifiers.

## Security Expectations For Forks

Before deploying a fork:

- Replace every placeholder in `.env.example`, `.firebaserc.example`, `firebase.json`, Cloud Build files, Apps Script manifest, and add-on constants.
- Keep real `.env`, `.firebaserc`, `.clasp.json`, `.clasprc.json`, service account keys, database dumps, and generated API payloads out of Git.
- Keep Cloud Run worker private and invoke it only through Cloud Tasks OIDC.
- Keep KMS enabled for production-like host OAuth token encryption.
- Confirm logs do not contain source slide text, translated text, speaker notes, comments, or OAuth tokens.
- Run `npm run security:secrets` before public pushes.
