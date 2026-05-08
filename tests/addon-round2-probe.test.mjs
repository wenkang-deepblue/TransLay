import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function loadRound2ProbeContext(overrides = {}) {
  const probeSource = await readFile(
    new URL("../apps/addon/src/server/round2_probe.gs", import.meta.url),
    "utf8"
  );
  const context = {
    console: {
      log() {},
      warn() {},
      error() {},
    },
    Utilities: {
      getUuid() {
        return "uuid-1";
      },
    },
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(name) {
            if (name === "TRANSLAY_ROUND2_PROBE_ENABLED") return "true";
            if (name === "TRANSLAY_ROUND2_PROBE_ALLOWED_EMAILS") return "probe@example.com";
            return null;
          },
        };
      },
    },
    Session: {
      getActiveUser() {
        return {
          getEmail() {
            return "probe@example.com";
          },
        };
      },
    },
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(probeSource, context);
  return context;
}

test("Round 2 probe is server-disabled unless script properties and user allowlist match", async () => {
  const context = await loadRound2ProbeContext({
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty() {
            return null;
          },
        };
      },
    },
    Session: {
      getActiveUser() {
        return {
          getEmail() {
            return "probe@example.com";
          },
        };
      },
    },
  });
  installSourceSlides(context);

  assert.equal(context.transLayRound2ProbeIsEnabled(), false);
  assert.throws(
    () => context.transLayRound2ProbeActiveSlidesContext(),
    /Round 2 Probe is disabled/
  );
});

function createResponse(code, body) {
  return {
    getResponseCode() {
      return code;
    },
    getContentText() {
      return body === undefined ? "" : JSON.stringify(body);
    },
  };
}

function extractFunctionBody(source, functionName, nextFunctionName) {
  const start = source.indexOf(`function ${functionName}`);
  const end = source.indexOf(`function ${nextFunctionName}`, start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return source.slice(start, end);
}

function createSlide(objectId) {
  return {
    getObjectId() {
      return objectId;
    },
  };
}

function installSourceSlides(context, slides = [createSlide("slide-1"), createSlide("slide-2")]) {
  context.SlidesApp = {
    getActivePresentation() {
      return {
        getId() {
          return "source-doc";
        },
        getName() {
          return "Source deck";
        },
        getSelection() {
          return {
            getCurrentPage() {
              return slides[1] || slides[0];
            },
          };
        },
        getSlides() {
          return slides;
        },
      };
    },
  };
}

test("Round 2 active Slides context probe reads only SlidesApp context", async () => {
  const context = await loadRound2ProbeContext();
  installSourceSlides(context);
  context.UrlFetchApp = {
    fetch() {
      throw new Error("Round 2 Probe must not call UrlFetchApp for active context");
    },
  };

  const result = context.transLayRound2ProbeActiveSlidesContext();

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: true,
    probe: "Round 2 Probe",
    documentId: "source-doc",
    documentName: "Source deck",
    slideCount: 2,
    currentPageObjectId: "slide-2",
    oneSlideRangeExpression: "2",
  });
});

test("Round 2 SlidesApp target probe copies source slides without Drive or worker sharing", async () => {
  const context = await loadRound2ProbeContext();
  const sourceSlides = [createSlide("slide-1"), createSlide("slide-2")];
  const targetSlides = [];
  const blankSlide = {
    remove() {
      const index = targetSlides.indexOf(blankSlide);
      if (index !== -1) targetSlides.splice(index, 1);
    },
  };
  targetSlides.push(blankSlide);
  const appendedFrom = [];
  const target = {
    getId() {
      return "target-doc";
    },
    getUrl() {
      return "https://docs.google.com/presentation/d/target-doc/edit";
    },
    getSlides() {
      return targetSlides;
    },
    appendSlide(slide) {
      appendedFrom.push(slide.getObjectId());
      targetSlides.push(createSlide("copy-" + slide.getObjectId()));
    },
    saveAndClose() {
      this.closed = true;
    },
  };
  context.SlidesApp = {
    getActivePresentation() {
      return {
        getId() {
          return "source-doc";
        },
        getName() {
          return "Source deck";
        },
        getSelection() {
          return {
            getCurrentPage() {
              return sourceSlides[0];
            },
          };
        },
        getSlides() {
          return sourceSlides;
        },
      };
    },
    create(name) {
      assert.equal(name, "Source deck (TransLay round 2 probe)");
      return target;
    },
    openById(id) {
      assert.equal(id, "target-doc");
      return target;
    },
  };
  context.UrlFetchApp = {
    fetch() {
      throw new Error("Round 2 Probe must not call Drive REST for target creation");
    },
  };

  const result = context.transLayRound2ProbeCreateTargetWithSlidesApp();

  assert.equal(result.targetId, "target-doc");
  assert.equal(result.targetSlideCount, 2);
  assert.equal(result.oneSlideRangeExpression, "1");
  assert.deepEqual(appendedFrom, ["slide-1", "slide-2"]);
});

test("Round 2 append job probe omits drive_access and worker permission ids", async () => {
  const requests = [];
  const context = await loadRound2ProbeContext({
    createJob(jobRequest) {
      requests.push(JSON.parse(JSON.stringify(jobRequest)));
      return { job_id: "job-1", status: "queued" };
    },
  });
  installSourceSlides(context);

  const result = context.transLayRound2ProbeSubmitAppendJob();

  assert.equal(result.jobId, "job-1");
  assert.equal(result.driveAccessOmitted, true);
  assert.equal(requests.length, 1);
  assert.equal(Object.hasOwn(requests[0], "drive_access"), false);
  assert.equal(requests[0].output_mode, "append_in_file");
  assert.equal(requests[0].range_mode, "custom");
  assert.equal(requests[0].range_expression, "2");
  assert.match(requests[0].idempotency_key, /^round2_probe_append_in_file_/);
});

test("Round 2 user OAuth failure probe sends an invalid user token and omits drive_access", async () => {
  const fetches = [];
  const context = await loadRound2ProbeContext({
    API_BASE_URL: "https://api.example.test",
  });
  installSourceSlides(context);
  context.UrlFetchApp = {
    fetch(url, request) {
      fetches.push({
        url,
        method: request.method,
        authorization: request.headers.Authorization,
        payload: JSON.parse(request.payload),
      });
      return createResponse(401, {
        error: "UNAUTHENTICATED",
        message: "Invalid token",
      });
    },
  };

  const result = context.transLayRound2ProbeUserOauthFailureBehavior();

  assert.equal(result.ok, true);
  assert.equal(result.expectedFailure, true);
  assert.equal(result.jobWasAccepted, false);
  assert.equal(result.httpStatus, 401);
  assert.equal(result.driveAccessOmitted, true);
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, "https://api.example.test/jobs");
  assert.equal(fetches[0].authorization, "Bearer translay-round-2-probe-invalid-user-oauth-token");
  assert.equal(Object.hasOwn(fetches[0].payload, "drive_access"), false);
});

test("Round 2 manifest has no Drive scopes or file-scope entry surface", async () => {
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

test("Round 2 probe UI exposes exactly the temporary probe actions", async () => {
  const html = await readFile(
    new URL("../apps/addon/src/sidebar/index.html", import.meta.url),
    "utf8"
  );
  const expectedActions = [
    "Round 2 Probe: Probe active Slides context",
    "Round 2 Probe: Probe create target with SlidesApp",
    "Round 2 Probe: Submit probe append job",
    "Round 2 Probe: Submit probe create-new-file job",
    "Round 2 Probe: Probe user-OAuth failure behavior",
  ];
  for (const action of expectedActions) {
    assert.match(html, new RegExp(action.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(html, /\.round2-probe-panel\s*\{[\s\S]*?display:\s*none;/);
  assert.match(html, /\.round2-probe-panel\.visible\s*\{[\s\S]*?display:\s*block;/);
  assert.match(html, /refreshRound2ProbeAvailability/);
  assert.match(html, /transLayRound2ProbeIsEnabled/);
  assert.match(html, /transLayRound2ProbeActiveSlidesContext/);
  assert.match(html, /transLayRound2ProbeCreateTargetWithSlidesApp/);
  assert.match(html, /transLayRound2ProbeSubmitAppendJob/);
  assert.match(html, /transLayRound2ProbeSubmitCreateNewFileJob/);
  assert.match(html, /transLayRound2ProbeUserOauthFailureBehavior/);
});

test("Round 2 probe server source does not call Drive or worker sharing helpers", async () => {
  const source = await readFile(
    new URL("../apps/addon/src/server/round2_probe.gs", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /DriveApp/);
  assert.doesNotMatch(source, /driveApiRequest|grantWorkerAccess|revokeWorkerPermission|WORKER_SERVICE_ACCOUNT_EMAIL/);
  assert.doesNotMatch(source, /google\.picker|PickerBuilder|requestFileScopeForActiveDocument|CardService/);
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
  assert.match(html, /function showCreateNewFileSubmissionFailure/);
  assert.match(html, /The new presentation was created, but the translation job was not started/);
  assert.doesNotMatch(html, /No usage was consumed/);
  const submitJob = extractFunctionBody(html, "submitJob", "_scheduleNextPoll");
  assert.match(submitJob, /showSubmissionError\(jobRequest, 'Usage quota exceeded/);
  assert.match(submitJob, /showSubmissionError\(jobRequest, 'A translation job is already in progress/);
  assert.match(submitJob, /showSubmissionError\(\s*jobRequest,\s*'This translation has already been submitted/);
  const executeTranslateSubmission = extractFunctionBody(
    html,
    "executeTranslateSubmission",
    "handleResubmit"
  );
  assert.match(executeTranslateSubmission, /if \(outputMode === 'create_new_file' && jobRequest\.target_document_id\)/);
  assert.match(executeTranslateSubmission, /The submission was no longer active before the job could start/);
  assert.doesNotMatch(html, /cleanup-action|cleanupAction|cleanupRetryBtn|Remove temporary access/);
  assert.doesNotMatch(html, /cleanupPreparedSubmission|registerPreparedCleanupForSubmission/);
  assert.doesNotMatch(html, /retryPendingDriveCleanup|retryJobDriveCleanup|retryTerminalDriveCleanup/);
  assert.doesNotMatch(html, /registerPreparedDriveCleanup|clearPreparedDriveCleanup/);
  assert.doesNotMatch(html, /cleanupPreparedTranslationSubmission/);
  assert.doesNotMatch(html, /cleanupRecoveryInFlight|pendingCleanupJobId|pendingPreparedCleanup/);
  assert.doesNotMatch(html, /sourceWorkerPermissionId|targetWorkerPermissionId/);
  assert.doesNotMatch(html, /Temporary file moved to Trash/);
  assert.match(html, /A previous temporary access cleanup is still pending/);
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
