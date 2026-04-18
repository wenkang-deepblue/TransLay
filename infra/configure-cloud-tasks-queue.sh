#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-YOUR_GCP_PROJECT_ID}"
LOCATION="${LOCATION:-us-central1}"
QUEUE_NAME="${QUEUE_NAME:-YOUR_CLOUD_TASKS_QUEUE}"

# Track D fixed queue baseline. Do not override these via environment variables.
# This script only owns the mutable flags explicitly set below. Cloud Tasks
# fields without matching gcloud flags (for example maxBurstSize) are not reset
# by `queues update`, so a brand-new queue or an explicit delete/recreate is
# still required if you need a perfectly clean baseline.
MAX_CONCURRENT_DISPATCHES="50"
MAX_DISPATCHES_PER_SECOND="5"
MAX_ATTEMPTS="5"
MIN_BACKOFF="10s"
MAX_BACKOFF="600s"

echo "Ensuring Cloud Tasks queue parameters..."
echo "  project: ${PROJECT_ID}"
echo "  location: ${LOCATION}"
echo "  queue: ${QUEUE_NAME}"
echo "  max concurrent dispatches: ${MAX_CONCURRENT_DISPATCHES}"
echo "  max dispatches/sec: ${MAX_DISPATCHES_PER_SECOND}"
echo "  max attempts: ${MAX_ATTEMPTS}"
echo "  min backoff: ${MIN_BACKOFF}"
echo "  max backoff: ${MAX_BACKOFF}"
echo "  note: update only covers the explicit mutable flags in this script"

if gcloud tasks queues describe "${QUEUE_NAME}" \
  --project "${PROJECT_ID}" \
  --location "${LOCATION}" >/dev/null 2>&1; then
  gcloud tasks queues update "${QUEUE_NAME}" \
    --project "${PROJECT_ID}" \
    --location "${LOCATION}" \
    --max-concurrent-dispatches "${MAX_CONCURRENT_DISPATCHES}" \
    --max-dispatches-per-second "${MAX_DISPATCHES_PER_SECOND}" \
    --max-attempts "${MAX_ATTEMPTS}" \
    --min-backoff "${MIN_BACKOFF}" \
    --max-backoff "${MAX_BACKOFF}" \
    --quiet
else
  gcloud tasks queues create "${QUEUE_NAME}" \
    --project "${PROJECT_ID}" \
    --location "${LOCATION}" \
    --max-concurrent-dispatches "${MAX_CONCURRENT_DISPATCHES}" \
    --max-dispatches-per-second "${MAX_DISPATCHES_PER_SECOND}" \
    --max-attempts "${MAX_ATTEMPTS}" \
    --min-backoff "${MIN_BACKOFF}" \
    --max-backoff "${MAX_BACKOFF}" \
    --quiet
fi

echo "Cloud Tasks queue parameters are configured."
