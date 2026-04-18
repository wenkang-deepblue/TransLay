#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-YOUR_GCP_PROJECT_ID}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-YOUR_WORKER_SERVICE}"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "Error: gcloud is required but was not found in PATH." >&2
  exit 1
fi

# Track D fixed runtime baseline. Do not override these via environment variables.
WORKER_CONCURRENCY="1"
WORKER_MAX_INSTANCES="50"
WORKER_MIN_INSTANCES="2"

echo "Updating Cloud Run worker runtime parameters..."
echo "  project: ${PROJECT_ID}"
echo "  region: ${REGION}"
echo "  service: ${SERVICE_NAME}"
echo "  concurrency: ${WORKER_CONCURRENCY}"
echo "  max instances: ${WORKER_MAX_INSTANCES}"
echo "  min instances: ${WORKER_MIN_INSTANCES}"

gcloud run services update "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --concurrency "${WORKER_CONCURRENCY}" \
  --max-instances "${WORKER_MAX_INSTANCES}" \
  --min-instances "${WORKER_MIN_INSTANCES}" \
  --quiet

gcloud run services describe "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --format='yaml(spec.template.metadata.annotations,spec.template.spec.serviceAccountName,spec.template.spec.containerConcurrency)'

echo "Worker runtime parameters updated."
