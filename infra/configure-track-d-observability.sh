#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ID="${PROJECT_ID:-}"
CONFIG_PATH="${CONFIG_PATH:-${SCRIPT_DIR}/track-d-observability.config.json}"
DASHBOARD_TEMPLATE_PATH="${DASHBOARD_TEMPLATE_PATH:-${SCRIPT_DIR}/track-d-dashboard.json}"
NOTIFICATION_CHANNELS_RAW="${TRACK_D_NOTIFICATION_CHANNELS:-}"
TMP_FILES=()

cleanup() {
  if [[ ${#TMP_FILES[@]} -gt 0 ]]; then
    rm -f "${TMP_FILES[@]}"
  fi
}

trap cleanup EXIT

if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == YOUR_* ]]; then
  echo "Error: set PROJECT_ID explicitly before running this script." >&2
  exit 1
fi

for required_cmd in gcloud python3; do
  if ! command -v "${required_cmd}" >/dev/null 2>&1; then
    echo "Error: ${required_cmd} is required but was not found in PATH." >&2
    exit 1
  fi
done

echo "Applying Track D observability assets..."
echo "  project: ${PROJECT_ID}"
echo "  config: ${CONFIG_PATH}"
echo "  dashboard template: ${DASHBOARD_TEMPLATE_PATH}"
if [[ -n "${NOTIFICATION_CHANNELS_RAW}" ]]; then
  echo "  notification channels: ${NOTIFICATION_CHANNELS_RAW}"
else
  echo "  notification channels: none (policies will be created without delivery channels)"
fi

create_or_update_metric() {
  local metric_name="$1"
  local tmp_config
  tmp_config="$(mktemp)"
  TMP_FILES+=("$tmp_config")
  python3 - "$CONFIG_PATH" "$metric_name" "$tmp_config" <<'PY'
import json
import sys

config_path, metric_name, output_path = sys.argv[1:]
with open(config_path, "r", encoding="utf-8") as fh:
    config = json.load(fh)

metric = next((entry for entry in config["metrics"] if entry["name"] == metric_name), None)
if metric is None:
    raise SystemExit(f"metric not found: {metric_name}")

with open(output_path, "w", encoding="utf-8") as fh:
    json.dump(metric["config"], fh, indent=2)
    fh.write("\n")
PY

  if gcloud logging metrics describe "$metric_name" --project "$PROJECT_ID" >/dev/null 2>&1; then
    echo "Updating log-based metric: ${metric_name}"
    gcloud logging metrics update "$metric_name" \
      --project "$PROJECT_ID" \
      --config-from-file "$tmp_config"
  else
    echo "Creating log-based metric: ${metric_name}"
    gcloud logging metrics create "$metric_name" \
      --project "$PROJECT_ID" \
      --config-from-file "$tmp_config"
  fi

}

metric_names_tmp="$(mktemp)"
TMP_FILES+=("$metric_names_tmp")
python3 - "$CONFIG_PATH" "$metric_names_tmp" <<'PY'
import json
import sys

config_path, output_path = sys.argv[1:]
with open(config_path, "r", encoding="utf-8") as fh:
    config = json.load(fh)

with open(output_path, "w", encoding="utf-8") as fh:
    for metric in config["metrics"]:
        fh.write(metric["name"] + "\n")
PY

while IFS= read -r metric_name; do
  create_or_update_metric "$metric_name"
done <"$metric_names_tmp"

apply_dashboard() {
  local existing_dashboard
  local dashboard_inventory
  dashboard_inventory="$(mktemp)"
  TMP_FILES+=("$dashboard_inventory")
  gcloud monitoring dashboards list \
    --project "$PROJECT_ID" \
    --format=json >"$dashboard_inventory"
  existing_dashboard="$(
    python3 - "$dashboard_inventory" "$CONFIG_PATH" <<'PY'
import json
import sys

inventory_path, config_path = sys.argv[1:]
with open(inventory_path, "r", encoding="utf-8") as fh:
    dashboards = json.load(fh)
with open(config_path, "r", encoding="utf-8") as fh:
    config = json.load(fh)

target = config["dashboardDisplayName"]
for dashboard in dashboards:
    if dashboard.get("displayName") == target:
        print(dashboard.get("name", ""))
        break
PY
  )"
  local tmp_dashboard
  tmp_dashboard="$(mktemp)"
  TMP_FILES+=("$tmp_dashboard")

  if [[ -n "${existing_dashboard}" ]]; then
    local existing_snapshot
    existing_snapshot="$(mktemp)"
    TMP_FILES+=("$existing_snapshot")
    gcloud monitoring dashboards describe "$existing_dashboard" \
      --project "$PROJECT_ID" \
      --format=json >"$existing_snapshot"
    python3 - "$DASHBOARD_TEMPLATE_PATH" "$tmp_dashboard" "$PROJECT_ID" "$existing_dashboard" "$existing_snapshot" <<'PY'
import json
import sys

template_path, output_path, project_id, dashboard_name, existing_path = sys.argv[1:]
with open(template_path, "r", encoding="utf-8") as fh:
    dashboard = json.load(fh)
with open(existing_path, "r", encoding="utf-8") as fh:
    existing = json.load(fh)

dashboard["name"] = dashboard_name
dashboard["etag"] = existing.get("etag", "")

with open(output_path, "w", encoding="utf-8") as fh:
    json.dump(dashboard, fh, indent=2)
    fh.write("\n")
PY
    echo "Updating dashboard: ${existing_dashboard}"
    gcloud monitoring dashboards update "$existing_dashboard" \
      --project "$PROJECT_ID" \
      --config-from-file "$tmp_dashboard"
  else
    python3 - "$DASHBOARD_TEMPLATE_PATH" "$tmp_dashboard" "$PROJECT_ID" "$CONFIG_PATH" <<'PY'
import json
import sys

template_path, output_path, project_id, config_path = sys.argv[1:]
with open(template_path, "r", encoding="utf-8") as fh:
    dashboard = json.load(fh)
with open(config_path, "r", encoding="utf-8") as fh:
    config = json.load(fh)

dashboard["name"] = f"projects/{project_id}/dashboards/{config['dashboardId']}"

with open(output_path, "w", encoding="utf-8") as fh:
    json.dump(dashboard, fh, indent=2)
    fh.write("\n")
PY
    echo "Creating dashboard: $(python3 - "$CONFIG_PATH" <<'PY'
import json
import sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    config = json.load(fh)
print(config["dashboardDisplayName"])
PY
)"
    gcloud monitoring dashboards create \
      --project "$PROJECT_ID" \
      --config-from-file "$tmp_dashboard"
  fi

}

apply_dashboard

ACCESS_TOKEN="$(gcloud auth print-access-token)"
ACCESS_TOKEN="$ACCESS_TOKEN" python3 - "$CONFIG_PATH" "$PROJECT_ID" "$NOTIFICATION_CHANNELS_RAW" <<'PY'
import copy
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

config_path, project_id, raw_channels = sys.argv[1:]
access_token = os.environ["ACCESS_TOKEN"]
channels = [item.strip() for item in raw_channels.split(",") if item.strip()]

with open(config_path, "r", encoding="utf-8") as fh:
    config = json.load(fh)

headers = {
    "Authorization": f"Bearer {access_token}",
    "Content-Type": "application/json; charset=utf-8",
}

def request(method: str, url: str, payload=None):
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            data = resp.read()
            return json.loads(data.decode("utf-8")) if data else {}
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")
        raise SystemExit(f"{method} {url} failed: {err.code} {detail}") from err

def list_alert_policies():
    base = f"https://monitoring.googleapis.com/v3/projects/{project_id}/alertPolicies"
    policies = []
    page_token = None
    while True:
        params = {}
        if page_token:
            params["pageToken"] = page_token
        url = base
        if params:
            url = f"{base}?{urllib.parse.urlencode(params)}"
        data = request("GET", url)
        policies.extend(data.get("alertPolicies", []))
        page_token = data.get("nextPageToken")
        if not page_token:
            return policies

existing_by_display_name = {
    policy.get("displayName"): policy
    for policy in list_alert_policies()
    if policy.get("displayName")
}

base_url = f"https://monitoring.googleapis.com/v3/projects/{project_id}/alertPolicies"

for policy in config["alertPolicies"]:
    payload = copy.deepcopy(policy)
    if channels:
        payload["notificationChannels"] = channels

    existing = existing_by_display_name.get(payload["displayName"])
    if existing is not None:
        payload["name"] = existing["name"]
        if existing.get("etag"):
            payload["etag"] = existing["etag"]
        update_mask = ",".join([
            "display_name",
            "combiner",
            "enabled",
            "severity",
            "user_labels",
            "documentation",
            "conditions",
            "notification_channels",
        ])
        request(
            "PATCH",
            f"https://monitoring.googleapis.com/v3/{existing['name']}?updateMask={urllib.parse.quote(update_mask, safe=',')}",
            payload,
        )
        print(f"Updated alert policy: {payload['displayName']}")
    else:
        request("POST", base_url, payload)
        print(f"Created alert policy: {payload['displayName']}")
PY

echo "Track D observability assets are configured."
