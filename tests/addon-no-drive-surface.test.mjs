import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

function extractFunctionBody(source, functionName, nextFunctionName) {
  const start = source.indexOf(`function ${functionName}`);
  const end = source.indexOf(`function ${nextFunctionName}`, start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return source.slice(start, end);
}

const SOURCE_EXTENSIONS = new Set([".gs", ".html", ".json"]);

async function listSourceFiles(dirUrl) {
  const entries = await readdir(dirUrl, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const childUrl = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dirUrl);
    if (entry.isDirectory()) {
      files.push(...await listSourceFiles(childUrl));
    } else if (SOURCE_EXTENSIONS.has(getPathExtension(entry.name))) {
      files.push(childUrl);
    }
  }
  return files;
}

function getPathExtension(fileName) {
  const index = fileName.lastIndexOf(".");
  return index === -1 ? "" : fileName.slice(index);
}

test("No-Drive manifest has no Drive scopes or file-scope entry surface", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../apps/addon/appsscript.json", import.meta.url), "utf8")
  );
  assert.deepEqual(manifest.urlFetchWhitelist, ["https://your-domain.example.com/"]);
  assert.ok(manifest.oauthScopes.includes("https://www.googleapis.com/auth/presentations"));
  assert.equal(
    manifest.oauthScopes.some((scope) => scope === "https://www.googleapis.com/auth/drive" || scope === "https://www.googleapis.com/auth/drive.file"),
    false
  );
  assert.equal(Object.hasOwn(manifest, "addOns"), false);
});

test("Sidebar production surface has no Google Picker dependency", async () => {
  const html = await readFile(
    new URL("../apps/addon/src/sidebar/index.html", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(html, /google\.picker|PickerBuilder|getPresentationPickerConfig|openPresentationAccessPicker/);
  assert.doesNotMatch(html, /requestFileScopeForActiveDocument|onFileScopeGrantedTrigger/);
});

test("Sidebar production submission uses user OAuth readiness and omits drive_access", async () => {
  const html = await readFile(
    new URL("../apps/addon/src/sidebar/index.html", import.meta.url),
    "utf8"
  );
  const executeTranslateSubmission = extractFunctionBody(
    html,
    "executeTranslateSubmission",
    "handleResubmit"
  );

  assert.match(executeTranslateSubmission, /\.ensureCurrentPresentationReadyForUserOauthJob\(\)/);
  assert.doesNotMatch(executeTranslateSubmission, /ensureCurrentPresentationWorkerAccess/);
  assert.doesNotMatch(executeTranslateSubmission, /jobRequest\.drive_access/);
  assert.doesNotMatch(executeTranslateSubmission, /sourceWorkerPermissionId|targetWorkerPermissionId/);
  assert.doesNotMatch(executeTranslateSubmission, /registerPreparedCleanupForSubmission/);
  assert.doesNotMatch(executeTranslateSubmission, /worker permission id/);
});

test("Sidebar no-Drive flow has no Drive cleanup UI or retry hooks", async () => {
  const html = await readFile(
    new URL("../apps/addon/src/sidebar/index.html", import.meta.url),
    "utf8"
  );

  assert.match(html, /function executeTranslateSubmission/);
  assert.match(html, /function submitJob/);
  assert.match(html, /function showSubmissionError/);
  assert.doesNotMatch(html, /function showCreateNewFileSubmissionFailure/);
  assert.doesNotMatch(html, /The new presentation was created, but the translation job was not started/);
  assert.doesNotMatch(html, /You can open the created presentation below/);
  assert.doesNotMatch(html, /No usage was consumed/);
  const submitJob = extractFunctionBody(html, "submitJob", "_scheduleNextPoll");
  assert.match(submitJob, /showSubmissionError\(jobRequest, 'Usage quota exceeded/);
  assert.match(submitJob, /showSubmissionError\(jobRequest, 'A translation job is already in progress/);
  assert.doesNotMatch(submitJob, /showSubmissionError\(\s*jobRequest,\s*'This translation has already been submitted/);
  assert.match(submitJob, /showDuplicateAction\(\s*'This translation has already been submitted/);
  const executeTranslateSubmission = extractFunctionBody(
    html,
    "executeTranslateSubmission",
    "handleResubmit"
  );
  assert.match(executeTranslateSubmission, /if \(outputMode === 'create_new_file' && jobRequest\.target_document_id\)/);
  assert.doesNotMatch(executeTranslateSubmission, /The submission was no longer active before the job could start/);
  assert.doesNotMatch(html, /cleanup-action|cleanupAction|cleanupRetryBtn|Remove temporary access/);
  assert.doesNotMatch(html, /cleanupPreparedSubmission|registerPreparedCleanupForSubmission/);
  assert.doesNotMatch(html, /retryPendingDriveCleanup|retryJobDriveCleanup|retryTerminalDriveCleanup/);
  assert.doesNotMatch(html, /registerPreparedDriveCleanup|clearPreparedDriveCleanup/);
  assert.doesNotMatch(html, /cleanupPreparedTranslationSubmission/);
  assert.doesNotMatch(html, /cleanupRecoveryInFlight|pendingCleanupJobId|pendingPreparedCleanup/);
  assert.doesNotMatch(html, /sourceWorkerPermissionId|targetWorkerPermissionId/);
  assert.doesNotMatch(html, /Temporary file moved to Trash/);
});

test("Host context production target preparation uses SlidesApp instead of Drive REST copy", async () => {
  const source = await readFile(
    new URL("../apps/addon/src/server/host_context.gs", import.meta.url),
    "utf8"
  );
  assert.match(source, /function createPresentationCopyWithSlidesApp_/);
  assert.match(source, /SlidesApp\.create/);
  assert.match(source, /\.appendSlide\(/);
  assert.match(source, /\.saveAndClose\(/);
  assert.match(source, /SlidesApp\.openById/);
  assert.doesNotMatch(source, /copyPresentationFile\(/);
  assert.doesNotMatch(source, /grantWorkerAccess\(/);
});

test("Add-on production source has no drive.file or Drive API implementation surface", async () => {
  const manifestUrl = new URL("../apps/addon/appsscript.json", import.meta.url);
  const sourceFiles = await listSourceFiles(new URL("../apps/addon/src/", import.meta.url));
  const files = [manifestUrl, ...sourceFiles];
  assert.ok(sourceFiles.some((file) => file.pathname.endsWith("/src/server/host_context.gs")));
  assert.ok(sourceFiles.some((file) => file.pathname.endsWith("/src/sidebar/index.html")));
  const forbidden = [
    /\bcleanupPreparedTranslationSubmission\b/,
    /\bclearPreparedDriveCleanup\b/,
    /\bcopyPresentationFile\b/,
    /\bDriveApp\b/,
    /\bdrive\.file\b/,
    /drive\/v3/,
    /google\.picker/,
    /\bgrantWorkerAccess\b/,
    /onFileScopeGrantedTrigger/,
    /\bPickerBuilder\b/,
    /\bregisterPreparedDriveCleanup\b/,
    /requestFileScopeForActiveDocument/,
    /\bretryJobDriveCleanup\b/,
    /\bretryPendingDriveCleanup\b/,
    /Round 2 Probe/,
    /\brevokeWorkerPermission\b/,
    /\btransLayRound2Probe[A-Za-z0-9_]*\b/,
    /\btrashDriveFile\b/,
    /\bWORKER_SERVICE_ACCOUNT_EMAIL\b/,
  ];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const label = decodeURIComponent(file.pathname);
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, label + " must not match " + pattern);
    }
  }
});
