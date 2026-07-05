<p align="center">
  <img src="apps/addon/assets/TransLay-logo_128px.png" alt="TransLay logo" width="96" height="96" />
</p>

<h1 align="center">TransLay</h1>

<p align="center">
  High-fidelity Google Slides™ translation with LLM quality, layout preservation, and privacy-first self-hosting.
</p>

TransLay is a self-hosted Google Slides™ translation system. It was built for one difficult product goal: translate an entire presentation with LLM-level quality while keeping the original slide design, layout, formatting, spacing, and visual rhythm as close to the source deck as possible.

The current implementation focuses on Google Slides™. Google Docs™ and Google Sheets™ are visible in parts of the product model and UI, but they are not production-supported yet.

## Project Status

This repository is in open-source transition.

TransLay was originally developed as a closed-source commercial product intended for a Google Workspace Marketplace launch. The product goal was to let a user open a Slides deck and start translation directly from the current deck, without making them search Drive through a separate file picker for every translation task.

During Marketplace preparation, the permission and review path pushed the product toward a `drive.file`-style file-grant flow. That flow is safer in some Marketplace review contexts, but it also changes the user experience: instead of starting from the deck already open on screen, the user must locate and grant access to files through Drive-oriented selection. For this product, that extra file-picking step made the core workflow slower and less direct.

For that reason, the Marketplace launch was stopped and the project is being opened as a self-hosted project instead. This does not lower the privacy or security target. From the beginning, TransLay was designed around least practical privilege, zero document-content persistence, and strict separation between the add-on, control plane, worker, model provider, database, and cache.

Because the project was not originally planned as open source, some historical commits may not read like a public project history. The public repository is sanitized, and future maintenance should follow open-source expectations: no private operational notes, no production identifiers, no secrets, no private deployment data, and issue/PR based collaboration.

The project is released under the Apache License 2.0. See `LICENSE`.

## What TransLay Does

TransLay translates Google Slides™ decks while trying to preserve the original slide experience, not just the plain text.

Core capabilities implemented in the current codebase:

- Translate the current slide, the entire presentation, or a custom page range such as `1,3,5-7`.
- Append translated slides after the originals in the same presentation.
- Create a new translated presentation without using Drive REST copy or a Drive file picker.
- Translate visible slide body text and speaker notes.
- Preserve rich text structure, including paragraphs, runs, bullets, font families, font sizes, text style roles, and table cell text.
- Extract transform-aware text box geometry so fitting logic works from actual slide-space constraints instead of only raw element sizes.
- Preserve repeated spaces and hard line breaks for body placeholders where those details affect visual layout.
- Use full-deck context to improve terminology consistency across slides.
- Build glossary candidates from repeated deck terms.
- Use a layout-semantics pass to infer visual roles, line-wrapping intent, and scale-sync groups.
- Apply a fit pass that can scale text and tighten paragraph spacing when translated text would overflow.
- Validate that translated output appears to match the requested target language for supported scripts.
- Support preset target languages plus short natural-language target language input.
- Preview quota impact before submitting a job.
- Offer partial translation when available quota is lower than the full selected range.
- Show progress, warnings, output links, and copyable task IDs in the sidebar.
- Support cooperative pause, resume, and cancel paths in the control plane and worker pipeline.
- Route model calls through a provider abstraction. Vertex AI Gemini is implemented; Gemma/GPU routing is represented as a future extension point.

Preset target languages currently include:

English, Portuguese, Spanish, French, German, Italian, Dutch, Swedish, Russian, Arabic, Greek, Hebrew, Simplified Chinese, Traditional Chinese, Japanese, Korean, and Klingon.

Custom language input is intentionally constrained. It is meant for short language or dialect names such as `Thai`, `Hindi`, `Brazilian Portuguese`, or `Mexican Spanish`, not arbitrary instructions.

## Privacy And Security Model

The central privacy rule is:

**TransLay must not persist user document text, translated text, comments, or notes as plaintext in PostgreSQL, Redis, logs, or other durable storage.**

Important security properties in the current codebase:

- The add-on talks only to the control plane API.
- The add-on does not talk directly to PostgreSQL, Redis, Cloud Tasks, Vertex AI, or worker internals.
- The add-on manifest requests Google Slides™ presentation access and does not request a Google Drive™ scope.
- Translation jobs store operational metadata, quota state, status, warnings, billing counters, and output identifiers, not source or translated document text.
- Source document titles were explicitly removed from long-term job persistence.
- Raw LLM output persistence was removed from the database schema.
- Development-only LLM debug capture is disabled in production-like environments.
- Host OAuth access tokens are encrypted with Cloud KMS in production-like environments and purged when jobs reach terminal states.
- Worker task requests are authenticated with Cloud Tasks OIDC tokens in production.
- Redis is used for short-lived auth cache, progress, rate limits, pause/cancel signals, and session-like state.
- Prompt-injection defenses wrap user-authored slide content as opaque data, scan source nodes for risky instructions, and reject model output that echoes prompt-control markers.
- Rate limits are split across global, authenticated read, and authenticated write buckets.

Current Apps Script scopes:

```json
[
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/script.external_request",
  "https://www.googleapis.com/auth/script.container.ui",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile"
]
```

Why the full `presentations` scope is used:

- The add-on must read and write the active Slides presentation.
- The add-on can create a new user-owned presentation through `SlidesApp.create`.
- The worker writes translated content back through Google Slides™ APIs using the user's authorization context.
- The project intentionally avoids `drive.file`, Drive Picker, and Drive REST copy in the current no-Drive workflow.

This is the smallest practical permission shape for the current "start from the open deck" workflow. If you fork TransLay and prefer a file-picker model, you can redesign the authorization layer around Drive file grants, but that is a different product tradeoff.

## Architecture

```text
Google Slides™ sidebar
        |
        | Apps Script UrlFetchApp
        v
Control plane on Cloud Run
        |
        | Cloud Tasks
        v
Worker on Cloud Run
        |
        | Vertex AI Gemini
        v
Google Slides™ API write-back

Shared services:
- PostgreSQL for users, subscriptions, quota, job metadata, warnings, and accounting state
- Redis for hot state, progress, auth cache, rate limits, pause/cancel signals, and short-lived sessions
- Cloud KMS for encrypting host OAuth tokens in production-like environments
- Optional Firebase Hosting landing page for commercial/billing pages
```

The original commercial version also includes a landing page, pricing page, subscription portal, Paddle billing integration, credit/refund flows, and legal pages. For open-source or personal use, the landing page is optional. Not deploying the landing page does not prevent the add-on from translating Slides, as long as the add-on can reach the control plane API.

## Repository Layout

```text
apps/addon/                 Apps Script add-on and sidebar UI
apps/control-plane/         Cloud Run API service for auth, entitlement, jobs, billing, and task creation
apps/worker/                Cloud Run worker that executes translation pipeline stages
packages/shared-config/     Environment loading, KMS helpers, runtime configuration
packages/shared-contracts/  API contracts, job status types, provider contracts
packages/shared-domain/     Language, quota, range, entitlement, and request validation logic
infra/sql/                  PostgreSQL migrations and migrator container
infra/                      GCP helper scripts, Redis specs, observability helpers
server/                     Optional static landing, legal, pricing, billing, and support pages
tests/                      Cross-package and add-on regression tests
```

## Before You Deploy

Read this section carefully. TransLay is not a browser-only extension. It is a multi-service system.

You need:

- A Google account.
- A Google Cloud project with billing enabled.
- A terminal on macOS, Linux, or WSL.
- Git.
- Node.js 22 or newer.
- npm.
- The Google Cloud CLI (`gcloud`).
- Access to create Cloud Run services, Cloud SQL, Memorystore Redis, Cloud Tasks, Artifact Registry, Secret Manager, and Cloud KMS resources.
- An Apps Script project managed with `clasp`.
- A Vertex AI-enabled project that can call the configured Gemini model.
- Optional: Firebase CLI if you want to deploy the landing page.
- Optional: Paddle account if you want production billing and subscription flows.

The code currently still contains commercial billing paths. In `NODE_ENV=production`, the control plane requires Paddle and Google web client configuration. If you only want a private personal deployment without billing, you have two choices:

1. Use a private `NODE_ENV=development` deployment for experimentation, protected by your own GCP access controls. Do not expose this as a public service.
2. Patch the billing gates before production deployment so billing can be disabled cleanly.

A proper open-source cleanup should eventually add an explicit `BILLING_ENABLED=false` mode. That is not finished in the current HEAD.

## Quick Local Build Check

This only verifies that the TypeScript services build. It does not deploy the add-on or translate a real deck.

```bash
git clone https://github.com/YOUR_GITHUB_ACCOUNT/TransLay.git
cd TransLay

npm ci

npm run build --workspace=@translay/shared-contracts
npm run build --workspace=@translay/shared-domain
npm run build --workspace=@translay/shared-config
npm run build --workspace=@translay/control-plane
npm run build --workspace=@translay/worker
```

If `npm ci` fails, check that you are using Node.js 22 or newer:

```bash
node --version
npm --version
```

## Deployment Guide

The following guide uses GCP-managed infrastructure:

- Cloud Run for the control plane.
- Cloud Run for the worker.
- Cloud SQL for PostgreSQL.
- Memorystore for Redis.
- Cloud Tasks for asynchronous pipeline execution.
- Artifact Registry and Cloud Build for container images.
- Secret Manager for secrets.
- Cloud KMS for host OAuth token encryption.
- Apps Script for the Google Slides™ sidebar.
- Optional Firebase Hosting for the landing page.

The commands use placeholders. Replace every value beginning with `your-` and every `YOUR_...` placeholder with your own values.

For a shorter sanitized setup checklist, see `docs/setup.md`.

### Step 1: Choose Names

Open a terminal and set these variables. They make the later commands easier to copy.

```bash
export PROJECT_ID="your-gcp-project-id"
export REGION="us-central1"
export AR_REPO="sample-artifacts"

export CONTROL_PLANE_SERVICE="sample-control-plane"
export WORKER_SERVICE="sample-worker"
export TASK_QUEUE="sample-translate"

export SQL_INSTANCE="sample-postgres"
export DB_NAME="translay"
export DB_USER="translay_app"

export REDIS_INSTANCE="sample-redis"
export VPC_CONNECTOR="sample-vpc"

export KMS_LOCATION="global"
export KMS_KEYRING="translay"
export KMS_KEY="host-oauth"

export DOMAIN="translay.example.com"
```

If you do not own a custom domain yet, you can initially use the Cloud Run URL for API testing. For production-like browser and landing flows, a stable HTTPS domain is strongly recommended.

Tell `gcloud` which project to use:

```bash
gcloud config set project "$PROJECT_ID"
```

### Step 2: Enable GCP APIs

Enable the APIs TransLay needs:

```bash
gcloud services enable \
  aiplatform.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  cloudkms.googleapis.com \
  cloudtasks.googleapis.com \
  compute.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  redis.googleapis.com \
  run.googleapis.com \
  script.googleapis.com \
  secretmanager.googleapis.com \
  serviceusage.googleapis.com \
  slides.googleapis.com \
  sqladmin.googleapis.com
```

If you plan to use Firebase Hosting for the landing page, also enable:

```bash
gcloud services enable firebase.googleapis.com firebasehosting.googleapis.com
```

### Step 3: Create Artifact Registry

Artifact Registry stores the container images built by Cloud Build.

```bash
gcloud artifacts repositories create "$AR_REPO" \
  --repository-format=docker \
  --location="$REGION" \
  --description="TransLay container images"
```

If the repository already exists, this command may fail with an "already exists" message. That is safe; continue.

If Cloud Build later fails when pushing images, grant Artifact Registry write access to the Cloud Build service account:

```bash
export PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
export CLOUDBUILD_SA="$PROJECT_NUMBER@cloudbuild.gserviceaccount.com"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$CLOUDBUILD_SA" \
  --role="roles/artifactregistry.writer"
```

### Step 4: Create Service Accounts

Create three service accounts:

- Control plane service account.
- Worker service account.
- Cloud Tasks invoker service account.

```bash
gcloud iam service-accounts create sample-control-plane \
  --display-name="TransLay control plane"

gcloud iam service-accounts create sample-worker \
  --display-name="TransLay worker"

gcloud iam service-accounts create sample-task-invoker \
  --display-name="TransLay Cloud Tasks invoker"
```

Set their email addresses:

```bash
export CONTROL_PLANE_SA="sample-control-plane@$PROJECT_ID.iam.gserviceaccount.com"
export WORKER_SA="sample-worker@$PROJECT_ID.iam.gserviceaccount.com"
export TASK_INVOKER_SA="sample-task-invoker@$PROJECT_ID.iam.gserviceaccount.com"
```

Grant project-level roles:

```bash
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$CONTROL_PLANE_SA" \
  --role="roles/cloudsql.client"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$CONTROL_PLANE_SA" \
  --role="roles/cloudtasks.enqueuer"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$CONTROL_PLANE_SA" \
  --role="roles/secretmanager.secretAccessor"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$WORKER_SA" \
  --role="roles/cloudsql.client"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$WORKER_SA" \
  --role="roles/cloudtasks.enqueuer"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$WORKER_SA" \
  --role="roles/secretmanager.secretAccessor"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$WORKER_SA" \
  --role="roles/aiplatform.user"
```

Allow the control plane and worker to create Cloud Tasks that mint OIDC tokens as the task invoker service account:

```bash
gcloud iam service-accounts add-iam-policy-binding "$TASK_INVOKER_SA" \
  --member="serviceAccount:$CONTROL_PLANE_SA" \
  --role="roles/iam.serviceAccountUser"

gcloud iam service-accounts add-iam-policy-binding "$TASK_INVOKER_SA" \
  --member="serviceAccount:$WORKER_SA" \
  --role="roles/iam.serviceAccountUser"
```

### Step 5: Create PostgreSQL

Create a Cloud SQL PostgreSQL instance:

```bash
gcloud sql instances create "$SQL_INSTANCE" \
  --database-version=POSTGRES_16 \
  --region="$REGION" \
  --tier=db-f1-micro \
  --storage-size=10GB
```

Create the database:

```bash
gcloud sql databases create "$DB_NAME" \
  --instance="$SQL_INSTANCE"
```

Create a database password without printing it to your shell history:

```bash
read -s -p "Choose a database password: " DB_PASSWORD
echo
```

Create the database user:

```bash
gcloud sql users create "$DB_USER" \
  --instance="$SQL_INSTANCE" \
  --password="$DB_PASSWORD"
```

Store the password in Secret Manager:

```bash
printf "%s" "$DB_PASSWORD" | gcloud secrets create sample-db-password \
  --replication-policy=automatic \
  --data-file=-
```

Get the Cloud SQL connection name:

```bash
export INSTANCE_CONNECTION_NAME="$(gcloud sql instances describe "$SQL_INSTANCE" --format='value(connectionName)')"
echo "$INSTANCE_CONNECTION_NAME"
```

The value should look like:

```text
your-gcp-project-id:us-central1:sample-postgres
```

### Step 6: Create Redis

Create a small Memorystore Redis instance:

```bash
gcloud redis instances create "$REDIS_INSTANCE" \
  --region="$REGION" \
  --tier=basic \
  --size=1
```

Get the Redis private IP:

```bash
export REDIS_HOST="$(gcloud redis instances describe "$REDIS_INSTANCE" \
  --region="$REGION" \
  --format='value(host)')"

echo "$REDIS_HOST"
```

Cloud Run needs VPC access to reach Memorystore:

```bash
gcloud compute networks vpc-access connectors create "$VPC_CONNECTOR" \
  --region="$REGION" \
  --network=default \
  --range=10.8.0.0/28
```

If you already have a connector, reuse it and set `VPC_CONNECTOR` to that connector's name.

### Step 7: Create Cloud KMS Key

Create a key ring and key for host OAuth token encryption:

```bash
gcloud kms keyrings create "$KMS_KEYRING" \
  --location="$KMS_LOCATION"

gcloud kms keys create "$KMS_KEY" \
  --location="$KMS_LOCATION" \
  --keyring="$KMS_KEYRING" \
  --purpose=encryption
```

Set the full key name:

```bash
export KMS_KEY_NAME="projects/$PROJECT_ID/locations/$KMS_LOCATION/keyRings/$KMS_KEYRING/cryptoKeys/$KMS_KEY"
```

Grant the control plane encrypt access and the worker decrypt access:

```bash
gcloud kms keys add-iam-policy-binding "$KMS_KEY" \
  --location="$KMS_LOCATION" \
  --keyring="$KMS_KEYRING" \
  --member="serviceAccount:$CONTROL_PLANE_SA" \
  --role="roles/cloudkms.cryptoKeyEncrypter"

gcloud kms keys add-iam-policy-binding "$KMS_KEY" \
  --location="$KMS_LOCATION" \
  --keyring="$KMS_KEYRING" \
  --member="serviceAccount:$WORKER_SA" \
  --role="roles/cloudkms.cryptoKeyDecrypter"
```

### Step 8: Create Runtime Secrets

Create a session secret:

```bash
openssl rand -base64 48 | gcloud secrets create sample-session-secret \
  --replication-policy=automatic \
  --data-file=-
```

For production mode, the control plane also requires Paddle and Google web client values. If you do not have them yet, do not deploy the control plane as public production until you either configure billing or patch billing out.

Production billing secrets:

```bash
printf "%s" "replace-with-paddle-client-token" | gcloud secrets create sample-billing-client-token \
  --replication-policy=automatic \
  --data-file=-

printf "%s" "replace-with-paddle-api-key" | gcloud secrets create sample-billing-api-key \
  --replication-policy=automatic \
  --data-file=-

printf "%s" "replace-with-paddle-webhook-secret" | gcloud secrets create sample-billing-webhook-secret \
  --replication-policy=automatic \
  --data-file=-
```

Do not commit real values to this repository. Do not put real values in README, issue comments, screenshots, or terminal logs.

### Step 9: Run Database Migrations

The migration code lives in `infra/sql`.

For a beginner-friendly local migration path, use Cloud SQL Auth Proxy. Install it using Google's official Cloud SQL Auth Proxy instructions, then start it in one terminal:

```bash
cloud-sql-proxy "$INSTANCE_CONNECTION_NAME" --port 5432
```

Leave that terminal open.

Open a second terminal in the repository root:

```bash
cd infra/sql
npm ci

export DB_HOST="127.0.0.1"
export DB_PORT="5432"
export DB_NAME="translay"
export DB_USER="translay_app"
export DB_PASSWORD="$DB_PASSWORD"

npm run migrate
npm run migrate:status
```

Expected result:

- `npm run migrate` applies pending `.sql` files.
- `npm run migrate:status` shows all migrations as applied.

If migration fails, do not keep retrying blindly. Check:

- Is `cloud-sql-proxy` still running?
- Is `DB_PASSWORD` set in the second terminal?
- Does the Cloud SQL instance show `RUNNABLE`?
- Does the database user match `DB_USER`?

### Step 10: Create Cloud Tasks Queue

From the repository root:

```bash
PROJECT_ID="$PROJECT_ID" LOCATION="$REGION" QUEUE_NAME="$TASK_QUEUE" \
  bash infra/configure-cloud-tasks-queue.sh
```

This creates or updates the queue with the baseline dispatch and retry settings used by the worker pipeline.

### Step 11: Build Worker Image

From the repository root:

```bash
export IMAGE_TAG="manual-$(date +%Y%m%d-%H%M%S)"

gcloud builds submit . \
  --config cloudbuild-worker.yaml \
  --substitutions "_REGION=$REGION,_REPOSITORY=$AR_REPO,_IMAGE_TAG=$IMAGE_TAG"
```

This builds:

```text
$REGION-docker.pkg.dev/$PROJECT_ID/$AR_REPO/worker:$IMAGE_TAG
```

### Step 12: Deploy Worker

The worker needs to know its own final Cloud Run URL in production. The easiest first-time path is:

1. Deploy once in private development mode so Cloud Run creates a URL.
2. Read the URL.
3. Update the service with production-like settings.

Initial private deploy:

```bash
gcloud run deploy "$WORKER_SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --image="$REGION-docker.pkg.dev/$PROJECT_ID/$AR_REPO/worker:$IMAGE_TAG" \
  --service-account="$WORKER_SA" \
  --no-allow-unauthenticated \
  --add-cloudsql-instances="$INSTANCE_CONNECTION_NAME" \
  --vpc-connector="$VPC_CONNECTOR" \
  --vpc-egress=private-ranges-only \
  --set-env-vars="NODE_ENV=development,GCP_PROJECT_ID=$PROJECT_ID,GCP_REGION=$REGION,DB_HOST=/cloudsql/$INSTANCE_CONNECTION_NAME,DB_PORT=5432,DB_NAME=$DB_NAME,DB_USER=$DB_USER,REDIS_HOST=$REDIS_HOST,REDIS_PORT=6379" \
  --set-secrets="DB_PASSWORD=sample-db-password:latest,SESSION_SECRET=sample-session-secret:latest" \
  --quiet
```

Read the generated URL:

```bash
export WORKER_URL="$(gcloud run services describe "$WORKER_SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --format='value(status.url)')"

export CLOUD_TASKS_AUDIENCE="$WORKER_URL/tasks/translate"
echo "$WORKER_URL"
```

Update the worker to production-like settings:

```bash
gcloud run services update "$WORKER_SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --service-account="$WORKER_SA" \
  --add-cloudsql-instances="$INSTANCE_CONNECTION_NAME" \
  --vpc-connector="$VPC_CONNECTOR" \
  --vpc-egress=private-ranges-only \
  --concurrency=1 \
  --max-instances=50 \
  --min-instances=0 \
  --set-env-vars="NODE_ENV=production,GCP_PROJECT_ID=$PROJECT_ID,GCP_REGION=$REGION,DB_HOST=/cloudsql/$INSTANCE_CONNECTION_NAME,DB_PORT=5432,DB_NAME=$DB_NAME,DB_USER=$DB_USER,REDIS_HOST=$REDIS_HOST,REDIS_PORT=6379,WORKER_URL=$WORKER_URL,CLOUD_TASKS_AUDIENCE=$CLOUD_TASKS_AUDIENCE,CLOUD_TASKS_INVOKER_SA=$TASK_INVOKER_SA,CLOUD_TASKS_QUEUE_NAME=$TASK_QUEUE,CLOUD_TASKS_LOCATION=$REGION,KMS_KEY_NAME=$KMS_KEY_NAME,VERTEX_LOCATION=global" \
  --set-secrets="DB_PASSWORD=sample-db-password:latest,SESSION_SECRET=sample-session-secret:latest" \
  --quiet
```

Allow the Cloud Tasks invoker service account to call the worker:

```bash
gcloud run services add-iam-policy-binding "$WORKER_SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --member="serviceAccount:$TASK_INVOKER_SA" \
  --role="roles/run.invoker"
```

Verify:

```bash
curl "$WORKER_URL/health"
```

The worker health endpoint is public only if your Cloud Run IAM allows the caller. If you used `--no-allow-unauthenticated`, direct `curl` may return an auth error. That is expected. Use Cloud Run logs to confirm the service is healthy.

### Step 13: Build Control Plane Image

From the repository root:

```bash
export IMAGE_TAG="manual-$(date +%Y%m%d-%H%M%S)"

gcloud builds submit . \
  --config cloudbuild-control-plane.yaml \
  --substitutions "_REGION=$REGION,_REPOSITORY=$AR_REPO,_IMAGE_TAG=$IMAGE_TAG"
```

### Step 14: Deploy Control Plane

If you are deploying in production mode, set these values first:

```bash
export LANDING_GOOGLE_WEB_CLIENT_ID="your-google-web-client-id.apps.googleusercontent.com"
export PADDLE_PRICE_ID_PRO_MONTHLY="replace-with-paddle-price-id"
export PADDLE_PRICE_ID_PRO_YEARLY="replace-with-paddle-price-id"
export PADDLE_PRICE_ID_CREDITS_SLIDES="replace-with-paddle-price-id"
```

Deploy:

```bash
gcloud run deploy "$CONTROL_PLANE_SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --image="$REGION-docker.pkg.dev/$PROJECT_ID/$AR_REPO/control-plane:$IMAGE_TAG" \
  --service-account="$CONTROL_PLANE_SA" \
  --allow-unauthenticated \
  --add-cloudsql-instances="$INSTANCE_CONNECTION_NAME" \
  --vpc-connector="$VPC_CONNECTOR" \
  --vpc-egress=private-ranges-only \
  --set-env-vars="NODE_ENV=production,GCP_PROJECT_ID=$PROJECT_ID,GCP_REGION=$REGION,DB_HOST=/cloudsql/$INSTANCE_CONNECTION_NAME,DB_PORT=5432,DB_NAME=$DB_NAME,DB_USER=$DB_USER,REDIS_HOST=$REDIS_HOST,REDIS_PORT=6379,WORKER_URL=$WORKER_URL,CLOUD_TASKS_AUDIENCE=$CLOUD_TASKS_AUDIENCE,CLOUD_TASKS_INVOKER_SA=$TASK_INVOKER_SA,CLOUD_TASKS_QUEUE_NAME=$TASK_QUEUE,CLOUD_TASKS_LOCATION=$REGION,KMS_KEY_NAME=$KMS_KEY_NAME,PRODUCTION_DOMAIN=$DOMAIN,LANDING_GOOGLE_WEB_CLIENT_ID=$LANDING_GOOGLE_WEB_CLIENT_ID,PADDLE_PRICE_ID_PRO_MONTHLY=$PADDLE_PRICE_ID_PRO_MONTHLY,PADDLE_PRICE_ID_PRO_YEARLY=$PADDLE_PRICE_ID_PRO_YEARLY,PADDLE_PRICE_ID_CREDITS_SLIDES=$PADDLE_PRICE_ID_CREDITS_SLIDES" \
  --set-secrets="DB_PASSWORD=sample-db-password:latest,SESSION_SECRET=sample-session-secret:latest,PADDLE_CLIENT_TOKEN=sample-billing-client-token:latest,PADDLE_API_KEY=sample-billing-api-key:latest,PADDLE_WEBHOOK_SECRET=sample-billing-webhook-secret:latest" \
  --quiet
```

Read the URL:

```bash
export CONTROL_PLANE_URL="$(gcloud run services describe "$CONTROL_PLANE_SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --format='value(status.url)')"

echo "$CONTROL_PLANE_URL"
```

Check health:

```bash
curl "$CONTROL_PLANE_URL/api/health"
```

If health is not OK, inspect logs:

```bash
gcloud run services logs read "$CONTROL_PLANE_SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --limit=100
```

### Step 15: Configure The Add-on API URL

Edit these files:

```text
apps/addon/src/server/constants.gs
apps/addon/appsscript.json
```

In `apps/addon/src/server/constants.gs`, replace:

```js
var API_BASE_URL = 'https://translay.example.com/api';
var PORTAL_BASE_URL = 'https://translay.example.com';
```

With either your custom domain:

```js
var API_BASE_URL = 'https://translay.example.com/api';
var PORTAL_BASE_URL = 'https://translay.example.com';
```

Or, for a first private test, the Cloud Run control plane URL:

```js
var API_BASE_URL = 'https://YOUR_CONTROL_PLANE_RUN_URL/api';
var PORTAL_BASE_URL = 'https://YOUR_CONTROL_PLANE_RUN_URL';
```

In `apps/addon/appsscript.json`, update `urlFetchWhitelist`:

```json
"urlFetchWhitelist": [
  "https://translay.example.com/"
]
```

Or for Cloud Run URL testing:

```json
"urlFetchWhitelist": [
  "https://YOUR_CONTROL_PLANE_RUN_URL/"
]
```

Keep the trailing slash.

### Step 16: Create And Push The Apps Script Project

Install `clasp`:

```bash
npm install -g @google/clasp
```

Enable the Apps Script API for your account:

```text
Open https://script.google.com/home/usersettings
Turn on the Apps Script API.
```

Log in:

```bash
clasp login
```

Create a standalone Apps Script project for the add-on:

```bash
cd apps/addon
clasp create "TransLay" --type standalone
```

This creates a local `.clasp.json` file. Do not commit it. It contains your private Apps Script project ID.

Push the add-on source:

```bash
clasp push
```

Open the Apps Script editor:

```bash
clasp open-script
```

### Step 17: Test The Unpublished Editor Add-on

This follows Google's Editor Add-on test deployment flow.

In the Apps Script editor:

1. Click `Deploy`.
2. Click `Test deployments`.
3. Next to `Select type`, click the settings icon.
4. Select `Editor add-on`.
5. Click `Create new test` or `Add test`.
6. Choose `Latest Code`.
7. Choose the authorization state you want to test.
8. Under `Test document`, select a Google Slides™ presentation.
9. Save the test.
10. Run the saved test.
11. Open or refresh the selected Slides presentation.
12. Look for the `TransLay` add-on menu.
13. Click `Open TransLay`.

Official references:

- Google `clasp` guide: https://developers.google.com/apps-script/guides/clasp
- Google Editor Add-on testing guide: https://developers.google.com/workspace/add-ons/how-tos/testing-editor-addons

When you first run the add-on, Google will ask you to authorize the Apps Script scopes. Confirm that the authorization screen does not request Drive access.

### Step 18: Run A Translation Smoke Test

Create a small Google Slides™ file with 2 or 3 slides. Use simple text boxes first.

In the TransLay sidebar:

1. Confirm the document name is shown.
2. Select a target language.
3. Choose `Current slide`.
4. Choose `Append translated slides after originals`.
5. Click `Translate`.
6. Confirm the task starts.
7. Wait for progress to finish.
8. Confirm a translated slide appears after the original.

Then test:

- `Entire presentation`.
- `Custom pages`, for example `1,3`.
- `Create a new presentation`.
- A slide with speaker notes.
- A slide with bullet lists.
- A slide with table cell text.
- Cancel before translation starts.
- Cancel after one slide has translated.

Check Cloud Run logs if anything fails:

```bash
gcloud run services logs read "$CONTROL_PLANE_SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --limit=100

gcloud run services logs read "$WORKER_SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --limit=100
```

Logs must not contain source slide text or translated text. If you see document content in logs, treat it as a security bug.

## Optional Landing Page

The `server/` directory contains the original commercial landing page, pricing, success, support, terms, and privacy pages.

For the open-source release, I kept the billing-related code paths in the repository, but removed my own account-specific information and production billing configuration. If you need these flows, give the relevant code to your coding assistant and ask it to analyze the current billing implementation, then guide you through setting up your own provider account, secrets, price IDs, webhook, and deployment configuration. I will not spend more README space on those commercial-account setup details here.

For personal use, you can skip Firebase Hosting entirely and point the add-on directly at the Cloud Run control plane API. Translation does not depend on the landing page.

Deploy the landing page only if you want:

- A public homepage.
- Pricing pages.
- Subscription and credit purchase flows.
- Legal/support pages.
- `/api/*` proxying from the same domain to the control plane.

If you deploy it, update:

```text
firebase.json
.firebaserc.example
server/js/*
server/i18n.js
server/*.html
```

Copy `.firebaserc.example` to `.firebaserc` locally, then replace all placeholders, support email addresses, legal text, payment settings, and domain references with your own values before publishing. Do not commit your real `.firebaserc`.

## Development Notes

Run service builds from the repository root:

```bash
npm ci
npm run build --workspace=@translay/shared-contracts
npm run build --workspace=@translay/shared-domain
npm run build --workspace=@translay/shared-config
npm run build --workspace=@translay/control-plane
npm run build --workspace=@translay/worker
```

Run the control plane locally:

```bash
cd apps/control-plane
npm run dev
```

Run the worker locally:

```bash
cd apps/worker
npm run dev
```

For local worker-only development, unsigned Cloud Tasks requests are allowed only when:

```text
NODE_ENV=development
ALLOW_UNSIGNED_TASKS=true
CLOUD_TASKS_AUDIENCE is empty
CLOUD_TASKS_INVOKER_SA is empty
```

Do not use that setup for a public deployment.

## Current Limitations

- Google Slides™ is the only supported host today. Docs and Sheets are still in development.
- The deployment is not one-click.
- Production mode still assumes the original commercial billing stack is configured.
- The landing page is optional but still present in the repository.
- The current add-on is intended for self-hosting and unpublished/internal testing, not Marketplace distribution.
- The public repository includes Apache-2.0 licensing, security policy, contributing guidance, example environment configuration, and secret scanning configuration.
- Forks still need to replace placeholders with their own deployment values before running real infrastructure.

## Security Checklist For Forks

Before publishing your fork or deploying a public instance:

- Do not commit `.env`, `.clasp.json`, `.clasprc.json`, service account keys, database dumps, or generated API payloads.
- Do not hard-code GCP project IDs, project numbers, Cloud SQL instance names, Redis IPs, OAuth client IDs, or private domains.
- Keep KMS enabled for production-like host OAuth token encryption.
- Keep `DEBUG_CAPTURE_LLM_OUTPUTS=false` in production-like environments.
- Keep `ALLOW_UNSIGNED_TASKS=false` outside local development.
- Confirm Cloud Run worker is not publicly invokable.
- Confirm Cloud Tasks uses an OIDC token and a dedicated invoker service account.
- Confirm logs do not contain slide source text, translated text, speaker notes, comments, or OAuth tokens.
- Run secret scanning before every public push.

Example staged secret scan:

```bash
npm run security:secrets:staged
```

Example full working-tree scan:

```bash
npm run security:secrets
```

For private vulnerability reports, see `SECURITY.md`.

## License

TransLay is licensed under the Apache License 2.0. See `LICENSE`.

Third-party dependencies retain their own licenses. See `THIRD_PARTY_NOTICES.md`
for highlighted dependency notices, including the current BlueOak-1.0.0
transitive packages.

## Issues And Feature Requests

Bug reports, feature requests, deployment questions, and security hardening suggestions are welcome through GitHub Issues.

When filing a bug, include:

- What you were trying to do.
- Whether the issue happened in the add-on, control plane, worker, database migration, or landing page.
- The job/task ID if the sidebar showed one.
- Sanitized logs with no document content, no tokens, and no secrets.
- Steps to reproduce with a small sample deck when possible.

Do not include private slide content, OAuth tokens, database passwords, service account keys, real customer data, or production GCP identifiers in public issues.

## Trademark Notice

Google Slides™, Google Docs™, Google Sheets™, Google Drive™, Google Workspace™, Apps Script, Cloud Run, Cloud SQL, Cloud Tasks, Vertex AI, and Gemini are trademarks or products of Google LLC. TransLay is not affiliated with, endorsed by, or sponsored by Google.
