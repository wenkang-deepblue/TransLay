#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-}"
REPOSITORY="${REPOSITORY:-}"
SERVICE_NAME="${SERVICE_NAME:-}"
QUEUE_NAME="${QUEUE_NAME:-}"
CLOUDBUILD_CONFIG="${WORKSPACE_ROOT}/cloudbuild-worker.yaml"
WORKER_SERVICE_ACCOUNT="${WORKER_SERVICE_ACCOUNT:-}"
GIT_SHA="$(git -C "${WORKSPACE_ROOT}" rev-parse --short HEAD 2>/dev/null || echo "nogit")"
IMAGE_TAG="${IMAGE_TAG:-worker-$(date +%Y%m%d-%H%M%S)-${GIT_SHA}}"

require_env() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "${value}" || "${value}" == YOUR_* ]]; then
    echo "Error: set ${name} explicitly before running this script." >&2
    exit 1
  fi
}

require_env PROJECT_ID
require_env REGION
require_env REPOSITORY
require_env SERVICE_NAME
require_env QUEUE_NAME
require_env WORKER_SERVICE_ACCOUNT

if ! command -v gcloud >/dev/null 2>&1; then
  echo "Error: gcloud is required but was not found in PATH." >&2
  exit 1
fi

if [[ ! -f "${CLOUDBUILD_CONFIG}" ]]; then
  echo "Error: cloud build config not found at ${CLOUDBUILD_CONFIG}" >&2
  exit 1
fi

echo "Releasing worker with Track D runtime baseline..."
echo "  project: ${PROJECT_ID}"
echo "  region: ${REGION}"
echo "  repository: ${REPOSITORY}"
echo "  service: ${SERVICE_NAME}"
echo "  queue: ${QUEUE_NAME}"
echo "  service account: ${WORKER_SERVICE_ACCOUNT}"
echo "  image tag: ${IMAGE_TAG}"

gcloud builds submit "${WORKSPACE_ROOT}" \
  --project "${PROJECT_ID}" \
  --config "${CLOUDBUILD_CONFIG}" \
  --substitutions "_IMAGE_TAG=${IMAGE_TAG}"

gcloud run deploy "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --image "${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/worker:${IMAGE_TAG}" \
  --service-account "${WORKER_SERVICE_ACCOUNT}" \
  --no-allow-unauthenticated \
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

echo "Verifying worker invoker IAM..."
WORKER_IAM="$(gcloud run services get-iam-policy "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --format='json(bindings)')"
echo "${WORKER_IAM}"
if echo "${WORKER_IAM}" | grep -q '"allUsers"\|"allAuthenticatedUsers"'; then
  echo "Error: worker service still exposes a public invoker binding." >&2
  exit 1
fi

echo "Verifying Cloud Tasks queue..."
gcloud tasks queues describe "${QUEUE_NAME}" \
  --project "${PROJECT_ID}" \
  --location "${REGION}" \
  --format='yaml(rateLimits.maxConcurrentDispatches,rateLimits.maxDispatchesPerSecond,retryConfig.maxAttempts,retryConfig.minBackoff,retryConfig.maxBackoff,state)'

echo "Worker release completed."
