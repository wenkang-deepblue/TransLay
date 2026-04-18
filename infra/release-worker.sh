#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PROJECT_ID="${PROJECT_ID:-YOUR_GCP_PROJECT_ID}"
REGION="${REGION:-us-central1}"
REPOSITORY="${REPOSITORY:-translay-repo}"
SERVICE_NAME="${SERVICE_NAME:-YOUR_WORKER_SERVICE}"
QUEUE_NAME="${QUEUE_NAME:-YOUR_CLOUD_TASKS_QUEUE}"
IMAGE_TAG="${IMAGE_TAG:-worker-$(date +%Y%m%d-%H%M%S)}"

echo "Releasing worker with Track D runtime baseline..."
echo "  project: ${PROJECT_ID}"
echo "  region: ${REGION}"
echo "  repository: ${REPOSITORY}"
echo "  service: ${SERVICE_NAME}"
echo "  queue: ${QUEUE_NAME}"
echo "  image tag: ${IMAGE_TAG}"

gcloud builds submit "${WORKSPACE_ROOT}" \
  --config "${WORKSPACE_ROOT}/cloudbuild-worker.yaml" \
  --substitutions "_IMAGE_TAG=${IMAGE_TAG}"

gcloud run deploy "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --image "${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/worker:${IMAGE_TAG}" \
  --quiet

PROJECT_ID="${PROJECT_ID}" REGION="${REGION}" SERVICE_NAME="${SERVICE_NAME}" \
  "${SCRIPT_DIR}/configure-worker-runtime.sh"

PROJECT_ID="${PROJECT_ID}" LOCATION="${REGION}" QUEUE_NAME="${QUEUE_NAME}" \
  "${SCRIPT_DIR}/configure-cloud-tasks-queue.sh"

echo "Verifying worker runtime..."
gcloud run services describe "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --format='yaml(spec.template.metadata.annotations,spec.template.spec.containerConcurrency,status.latestReadyRevisionName)'

echo "Verifying Cloud Tasks queue..."
gcloud tasks queues describe "${QUEUE_NAME}" \
  --project "${PROJECT_ID}" \
  --location "${REGION}" \
  --format='yaml(rateLimits.maxConcurrentDispatches,rateLimits.maxDispatchesPerSecond,retryConfig.maxAttempts,retryConfig.minBackoff,retryConfig.maxBackoff,state)'

echo "Worker release completed."
