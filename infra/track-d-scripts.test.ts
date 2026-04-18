import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readWorkspaceFile(relativePath: string): Promise<string> {
  return readFile(path.join(WORKSPACE_ROOT, relativePath), "utf8");
}

test("configure-worker-runtime.sh pins Track D worker concurrency settings", async () => {
  const script = await readWorkspaceFile("infra/configure-worker-runtime.sh");

  assert.match(script, /WORKER_CONCURRENCY="1"/);
  assert.match(script, /WORKER_MAX_INSTANCES="50"/);
  assert.match(script, /WORKER_MIN_INSTANCES="2"/);
  assert.match(script, /--concurrency "\$\{WORKER_CONCURRENCY\}"/);
  assert.match(script, /--max-instances "\$\{WORKER_MAX_INSTANCES\}"/);
  assert.match(script, /--min-instances "\$\{WORKER_MIN_INSTANCES\}"/);
});

test("configure-cloud-tasks-queue.sh pins Track D queue settings", async () => {
  const script = await readWorkspaceFile("infra/configure-cloud-tasks-queue.sh");

  assert.match(script, /MAX_CONCURRENT_DISPATCHES="50"/);
  assert.match(script, /MAX_DISPATCHES_PER_SECOND="5"/);
  assert.match(script, /MAX_ATTEMPTS="5"/);
  assert.match(script, /MIN_BACKOFF="10s"/);
  assert.match(script, /MAX_BACKOFF="600s"/);
  assert.match(script, /gcloud tasks queues update/);
  assert.match(script, /gcloud tasks queues create/);
  assert.match(script, /--max-concurrent-dispatches "\$\{MAX_CONCURRENT_DISPATCHES\}"/);
  assert.match(script, /--max-dispatches-per-second "\$\{MAX_DISPATCHES_PER_SECOND\}"/);
  assert.match(script, /maxBurstSize/);
  assert.match(script, /update only covers the explicit mutable flags/);
});

test("release-worker.sh binds deploy and Track D runtime sync together", async () => {
  const script = await readWorkspaceFile("infra/release-worker.sh");

  assert.match(script, /gcloud builds submit/);
  assert.match(script, /--project "\$\{PROJECT_ID\}"/);
  assert.match(script, /cloudbuild-worker\.yaml/);
  assert.match(script, /--service-account "\$\{WORKER_SERVICE_ACCOUNT\}"/);
  assert.match(script, /gcloud run deploy "\$\{SERVICE_NAME\}"/);
  assert.match(script, /configure-worker-runtime\.sh/);
  assert.match(script, /configure-cloud-tasks-queue\.sh/);
  assert.match(script, /gcloud run services describe "\$\{SERVICE_NAME\}"/);
  assert.match(script, /gcloud tasks queues describe "\$\{QUEUE_NAME\}"/);
});

test("Track D observability assets define required metrics and alerts", async () => {
  const script = await readWorkspaceFile("infra/configure-track-d-observability.sh");
  const configRaw = await readWorkspaceFile("infra/track-d-observability.config.json");
  const dashboardRaw = await readWorkspaceFile("infra/track-d-dashboard.json");
  const config = JSON.parse(configRaw) as {
    metrics: Array<{ name: string }>;
    alertPolicies: Array<{ displayName: string }>;
  };
  const dashboard = JSON.parse(dashboardRaw) as {
    displayName: string;
    gridLayout: {
      widgets: Array<{
        title?: string;
        xyChart?: {
          dataSets?: Array<{
            timeSeriesQuery?: {
              timeSeriesFilter?: {
                filter?: string;
              };
            };
          }>;
        };
        timeSeriesTable?: {
          dataSets?: Array<{
            timeSeriesQuery?: {
              timeSeriesFilter?: {
                filter?: string;
              };
            };
          }>;
        };
      }>;
    };
  };

  assert.match(script, /gcloud logging metrics (create|update)/);
  assert.match(script, /gcloud monitoring dashboards (create|update)/);
  assert.match(script, /TRACK_D_NOTIFICATION_CHANNELS/);
  assert.doesNotMatch(script, /\breadarray\b/);
  assert.match(script, /\bpython3\b/);
  assert.match(script, /\btrap cleanup EXIT\b/);
  assert.match(script, /ACCESS_TOKEN="\$ACCESS_TOKEN" python3/);
  assert.match(script, /PATCH/);

  const metricNames = new Set(config.metrics.map((metric) => metric.name));
  assert.ok(metricNames.has("translay_track_d_slides_budget_attempt_total"));
  assert.ok(metricNames.has("translay_track_d_slides_budget_throttled_total"));
  assert.ok(metricNames.has("translay_track_d_vertex_budget_attempt_total"));
  assert.ok(metricNames.has("translay_track_d_vertex_budget_throttled_total"));
  assert.ok(metricNames.has("translay_track_d_job_terminal_total"));
  assert.ok(metricNames.has("translay_track_d_fallback_triggered_total"));
  assert.ok(metricNames.has("translay_track_d_token_source_selected_total"));
  assert.ok(metricNames.has("translay_track_d_global_inflight_distribution"));

  const alertDisplayNames = new Set(
    config.alertPolicies.map((policy) => policy.displayName)
  );
  assert.ok(alertDisplayNames.has("TransLay Track D - Slides 429 rate > 5% (5m)"));
  assert.ok(alertDisplayNames.has("TransLay Track D - Global in-flight jobs > 45 (10m)"));
  assert.ok(alertDisplayNames.has("TransLay Track D - SA fallback ratio > 30% (1h)"));

  assert.equal(dashboard.displayName, "TransLay Track D Overview");

  const dashboardFilters = dashboard.gridLayout.widgets.flatMap((widget) => {
    const xyFilters = (widget.xyChart?.dataSets ?? []).flatMap((dataSet) => {
      const filter = dataSet.timeSeriesQuery?.timeSeriesFilter?.filter;
      return filter ? [filter] : [];
    });
    const tableFilters = (widget.timeSeriesTable?.dataSets ?? []).flatMap((dataSet) => {
      const filter = dataSet.timeSeriesQuery?.timeSeriesFilter?.filter;
      return filter ? [filter] : [];
    });
    return [...xyFilters, ...tableFilters];
  });

  assert.ok(
    dashboardFilters.some((filter) =>
      filter.includes("logging.googleapis.com/user/translay_track_d_global_inflight_distribution")
    )
  );

  for (const filter of dashboardFilters) {
    const metricTypeMatch = filter.match(/logging\.googleapis\.com\/user\/([A-Za-z0-9_]+)/);
    if (!metricTypeMatch) {
      continue;
    }
    assert.ok(
      metricNames.has(metricTypeMatch[1]!),
      `dashboard references unknown metric: ${metricTypeMatch[1]}`
    );
  }
});
