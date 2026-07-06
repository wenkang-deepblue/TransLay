# Self-Hosted Setup Guide

This guide is the sanitized public setup companion for TransLay. It intentionally contains placeholders only. Replace every `YOUR_...`, `your-...`, and `translay.example.com` value before deploying.

## Configuration Files

Use these files as templates:

- `.env.example` for runtime environment variables.
- `.firebaserc.example` for Firebase project selection.
- `firebase.json` for optional Firebase Hosting and `/api/*` proxying.
- `cloudbuild-control-plane.yaml`, `cloudbuild-worker.yaml`, and `cloudbuild-sql-migrator.yaml` for container builds.
- `apps/addon/appsscript.json` and `apps/addon/src/server/constants.gs` for Apps Script URL allowlisting and API base URLs.

Do not commit the local files created from those templates if they contain real deployment identifiers or secrets.

## Required Services

TransLay expects these managed services in a self-hosted GCP deployment:

- Cloud Run control plane.
- Cloud Run worker.
- Cloud Tasks queue.
- Cloud SQL PostgreSQL.
- Memorystore Redis.
- Artifact Registry.
- Secret Manager.
- Cloud KMS.
- Vertex AI.
- Apps Script project for the Google Slides™ add-on.
- Optional Firebase Hosting for the public landing and legal pages.

## Minimal Build Check

From the repository root:

```bash
npm ci
npm run build --workspace=@translay/shared-contracts
npm run build --workspace=@translay/shared-domain
npm run build --workspace=@translay/shared-config
npm run build --workspace=@translay/control-plane
npm run build --workspace=@translay/worker
```

## Deployment Checklist

1. Create a GCP project with billing enabled.
2. Enable the APIs listed in `README.md`.
3. Create service accounts for the control plane, worker, and Cloud Tasks invoker.
4. Create Cloud SQL PostgreSQL and run `infra/sql` migrations.
5. Create Memorystore Redis and a VPC connector for Cloud Run.
6. Create a Cloud KMS key for host OAuth token encryption.
7. Store database, session, and optional billing values in Secret Manager.
8. Build worker and control-plane images with your own Artifact Registry repository.
9. Deploy the worker as a private Cloud Run service.
10. Configure Cloud Tasks to invoke the worker with OIDC.
11. Deploy the control plane.
12. Update the Apps Script manifest and constants to point at your control plane URL.
13. Push the add-on with `clasp push`.
14. Test the unpublished Editor add-on against a small sanitized Slides deck.

## Safety Checks Before Public Pushes

Run:

```bash
npm run security:secrets
```

Also confirm:

- `git status --short` does not include `.env`, `.firebaserc`, `.clasp.json`, `.clasprc.json`, service account keys, or database dumps.
- Logs from smoke tests do not contain slide source text, translated text, speaker notes, comments, OAuth tokens, or provider raw output.
- The worker has no public `allUsers` or `allAuthenticatedUsers` invoker binding.
- `ALLOW_UNSIGNED_TASKS=false` outside isolated local development.

## Apps Script Notes

The add-on is intended for self-hosted and unpublished/internal testing in this public transition state. The current manifest avoids Drive scopes and uses the Slides presentation scope for the open-deck workflow.

Before running `clasp push`, edit:

```text
apps/addon/appsscript.json
apps/addon/src/server/constants.gs
```

Use your own HTTPS control plane URL or custom domain, and keep the trailing slash in `urlFetchWhitelist`.
