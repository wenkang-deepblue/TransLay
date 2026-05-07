import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function loadProbeContext() {
  const driveApiSource = await readFile(
    new URL("../apps/addon/src/server/drive_api.gs", import.meta.url),
    "utf8"
  );
  const probeSource = await readFile(
    new URL("../apps/addon/src/server/file_scope_probe.gs", import.meta.url),
    "utf8"
  );
  const context = {
    console: {
      info() {},
      log() {},
      warn() {},
      error() {},
    },
    getGoogleToken() {
      return "user-token";
    },
  };
  vm.createContext(context);
  vm.runInContext(driveApiSource, context);
  vm.runInContext(probeSource, context);
  return context;
}

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

function createRawResponse(code, text) {
  return {
    getResponseCode() {
      return code;
    },
    getContentText() {
      return text;
    },
  };
}

test("Drive file-scope preflight records successful Drive REST access to the active deck", async () => {
  const context = await loadProbeContext();
  const fetches = [];
  context.UrlFetchApp = {
    fetch(url, request) {
      fetches.push({ url, method: request.method, authorization: request.headers.Authorization });
      return createResponse(200, {
        id: "active-deck",
        mimeType: "application/vnd.google-apps.presentation",
        capabilities: {
          canEdit: true,
          canCopy: true,
          canShare: false,
        },
      });
    },
  };

  const result = context.runTransLayDriveFileScopePreflight_({
    slides: {
      id: "active-deck",
      title: "Golden Gate Bridge",
      addonHasFileScopePermission: true,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.activeDocumentId, "active-deck");
  assert.equal(result.activeDocumentTitle, "Golden Gate Bridge");
  assert.equal(result.activeDocumentIdSource, "event.slides");
  assert.equal(result.eventHasFileScopePermission, true);
  assert.equal(result.returnedDocumentId, "active-deck");
  assert.equal(result.idMatchesActive, true);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.mimeType, "application/vnd.google-apps.presentation");
  assert.equal(result.canEdit, true);
  assert.equal(result.canCopy, true);
  assert.equal(result.canShare, false);
  assert.deepEqual(fetches, [
    {
      url: "https://www.googleapis.com/drive/v3/files/active-deck?supportsAllDrives=true&fields=id,mimeType,capabilities(canEdit,canCopy,canShare)",
      method: "get",
      authorization: "Bearer user-token",
    },
  ]);
});

test("Drive file-scope preflight preserves Drive API failure status and reason", async () => {
  const context = await loadProbeContext();
  context.UrlFetchApp = {
    fetch() {
      return createResponse(403, {
        error: {
          status: "PERMISSION_DENIED",
          errors: [{ reason: "insufficientFilePermissions" }],
          message: "The user does not have sufficient permissions.",
        },
      });
    },
  };

  const result = context.runTransLayDriveFileScopePreflight_({
    slides: {
      id: "active-deck",
      addonHasFileScopePermission: true,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.activeDocumentId, "active-deck");
  assert.equal(result.returnedDocumentId, null);
  assert.equal(result.idMatchesActive, false);
  assert.equal(result.httpStatus, 403);
  assert.equal(result.driveStatus, "PERMISSION_DENIED");
  assert.equal(result.driveReason, "insufficientFilePermissions");
  assert.equal(result.message, "The user does not have sufficient permissions.");
});

test("Drive file-scope preflight preserves Drive API 404 notFound failure", async () => {
  const context = await loadProbeContext();
  context.UrlFetchApp = {
    fetch() {
      return createResponse(404, {
        error: {
          status: "NOT_FOUND",
          errors: [{ reason: "notFound" }],
          message: "File not found.",
        },
      });
    },
  };

  const result = context.runTransLayDriveFileScopePreflight_({
    slides: {
      id: "missing-deck",
      addonHasFileScopePermission: true,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.activeDocumentId, "missing-deck");
  assert.equal(result.httpStatus, 404);
  assert.equal(result.driveStatus, "NOT_FOUND");
  assert.equal(result.driveReason, "notFound");
  assert.equal(result.message, "File not found.");
});

test("Drive file-scope preflight reports invalid Drive API JSON as a normalized failure", async () => {
  const context = await loadProbeContext();
  context.UrlFetchApp = {
    fetch() {
      return createRawResponse(500, "<html>not json</html>");
    },
  };

  const result = context.runTransLayDriveFileScopePreflight_({
    slides: {
      id: "active-deck",
      addonHasFileScopePermission: true,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.activeDocumentId, "active-deck");
  assert.equal(result.httpStatus, 500);
  assert.equal(result.driveStatus, "INVALID_JSON");
  assert.equal(result.driveReason, "INVALID_JSON");
  assert.equal(result.message, "Drive API response was not valid JSON.");
});

test("Drive file-scope preflight reports UrlFetch failures before receiving an HTTP response", async () => {
  const context = await loadProbeContext();
  context.UrlFetchApp = {
    fetch() {
      throw new Error("No permission to call UrlFetchApp.fetch");
    },
  };

  const result = context.runTransLayDriveFileScopePreflight_({
    slides: {
      id: "active-deck",
      addonHasFileScopePermission: true,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.activeDocumentId, "active-deck");
  assert.equal(result.httpStatus, null);
  assert.equal(result.driveReason, "url_fetch_failed");
  assert.equal(result.message, "No permission to call UrlFetchApp.fetch");
});

test("Drive file-scope preflight reports missing event file scope before using Drive REST", async () => {
  const context = await loadProbeContext();
  context.UrlFetchApp = {
    fetch() {
      throw new Error("Drive REST should not run without an active file ID");
    },
  };

  const result = context.runTransLayDriveFileScopePreflight_({
    slides: {
      addonHasFileScopePermission: false,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.activeDocumentIdSource, "event.slides");
  assert.equal(result.driveReason, "missing_file_scope");
  assert.equal(result.eventHasFileScopePermission, false);
  assert.match(result.message, /not been granted file access/);
});

test("Drive file-scope preflight refuses to pass without a Slides event ID", async () => {
  const context = await loadProbeContext();
  context.UrlFetchApp = {
    fetch() {
      throw new Error("Drive REST should not run without an active file ID");
    },
  };

  const result = context.runTransLayDriveFileScopePreflight_({});

  assert.equal(result.ok, false);
  assert.equal(result.activeDocumentId, null);
  assert.equal(result.activeDocumentIdSource, "event.unavailable");
  assert.equal(result.driveReason, "slides_event_unavailable");
  assert.match(result.message, /did not include Slides context/);
});

test("Drive file-scope request action uses CardService active-file scope builder", async () => {
  const context = await loadProbeContext();
  const calls = [];
  context.CardService = {
    newEditorFileScopeActionResponseBuilder() {
      calls.push("builder");
      return {
        requestFileScopeForActiveDocument() {
          calls.push("request");
          return this;
        },
        build() {
          calls.push("build");
          return { type: "editor-file-scope-response" };
        },
      };
    },
  };

  const response = context.requestTransLayFileScopeForActiveDocument({});

  assert.deepEqual(calls, ["builder", "request", "build"]);
  assert.deepEqual(response, { type: "editor-file-scope-response" });
});
