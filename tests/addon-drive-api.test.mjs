import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function loadDriveApiContext() {
  const driveApiSource = await readFile(
    new URL("../apps/addon/src/server/drive_api.gs", import.meta.url),
    "utf8"
  );
  const context = {
    console: {
      log() {},
      warn() {},
      error() {},
    },
    getGoogleToken() {
      return "user-token";
    },
    WORKER_SERVICE_ACCOUNT_EMAIL: "worker@example.com",
  };
  vm.createContext(context);
  vm.runInContext(driveApiSource, context);
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

test("driveApiRequest normalizes Drive REST failure status and reason", async () => {
  const context = await loadDriveApiContext();
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

  assert.throws(
    () => context.driveApiRequest("/files/source-doc", { method: "get", operation: "Drive active file access check" }),
    (err) => {
      assert.equal(err.driveOperation, "Drive active file access check");
      assert.equal(err.driveStatus, 403);
      assert.equal(err.driveReason, "insufficientFilePermissions");
      assert.match(err.message, /HTTP 403 \/ insufficientFilePermissions/);
      return true;
    }
  );
});

test("driveApiRequest reports invalid Drive API JSON with a normalized reason", async () => {
  const context = await loadDriveApiContext();
  context.UrlFetchApp = {
    fetch() {
      return createRawResponse(500, "<html>not json</html>");
    },
  };

  assert.throws(
    () => context.driveApiRequest("/files/source-doc", { method: "get", operation: "Drive active file access check" }),
    (err) => {
      assert.equal(err.driveStatus, 500);
      assert.equal(err.driveReason, "INVALID_JSON");
      assert.match(err.message, /Drive API response was not valid JSON/);
      return true;
    }
  );
});

test("assertActivePresentationDriveFileAccess verifies the active Slides file metadata", async () => {
  const context = await loadDriveApiContext();
  const fetches = [];
  context.SlidesApp = {
    getActivePresentation() {
      return {
        getId() {
          return "active-deck";
        },
      };
    },
  };
  context.UrlFetchApp = {
    fetch(url, request) {
      fetches.push({ url, method: request.method, authorization: request.headers.Authorization });
      return createResponse(200, {
        id: "active-deck",
        name: "Source deck",
        mimeType: "application/vnd.google-apps.presentation",
        capabilities: {
          canEdit: true,
          canCopy: true,
          canShare: true,
        },
      });
    },
  };

  const fileAccess = context.assertActivePresentationDriveFileAccess();
  assert.equal(fileAccess.documentId, "active-deck");
  assert.equal(fileAccess.documentName, "Source deck");
  assert.equal(fileAccess.canShare, true);
  assert.deepEqual(fetches, [
    {
      url: "https://www.googleapis.com/drive/v3/files/active-deck?supportsAllDrives=true&fields=id,name,mimeType,capabilities(canEdit,canCopy,canShare)",
      method: "get",
      authorization: "Bearer user-token",
    },
  ]);
});

test("assertActivePresentationDriveFileAccess blocks files that cannot be shared with worker access", async () => {
  const context = await loadDriveApiContext();
  context.SlidesApp = {
    getActivePresentation() {
      return {
        getId() {
          return "active-deck";
        },
      };
    },
  };
  context.UrlFetchApp = {
    fetch() {
      return createResponse(200, {
        id: "active-deck",
        name: "Source deck",
        mimeType: "application/vnd.google-apps.presentation",
        capabilities: {
          canEdit: true,
          canCopy: true,
          canShare: false,
        },
      });
    },
  };

  assert.throws(
    () => context.assertActivePresentationDriveFileAccess(),
    /cannot be shared with TransLay worker access/
  );
});

test("copyPresentationFile retries My Drive root when same-folder REST copy fails", async () => {
  const context = await loadDriveApiContext();
  const fetches = [];
  context.UrlFetchApp = {
    fetch(url, request) {
      fetches.push({
        url,
        method: request.method,
        payload: request.payload ? JSON.parse(request.payload) : null,
      });
      if (url === "https://www.googleapis.com/drive/v3/files/source-doc?supportsAllDrives=true&fields=parents") {
        return createResponse(200, { parents: ["folder-1"] });
      }
      if (url === "https://www.googleapis.com/drive/v3/files/source-doc/copy?supportsAllDrives=true&fields=id,webViewLink" &&
          JSON.parse(request.payload).parents) {
        return createResponse(403, {
          error: {
            status: "PERMISSION_DENIED",
            errors: [{ reason: "insufficientFilePermissions" }],
            message: "Cannot create in source folder.",
          },
        });
      }
      if (url === "https://www.googleapis.com/drive/v3/files/source-doc/copy?supportsAllDrives=true&fields=id,webViewLink") {
        return createResponse(200, { id: "copy-doc" });
      }
      throw new Error("unexpected URL " + url);
    },
  };

  const copied = context.copyPresentationFile("source-doc", "Translated copy");
  assert.equal(copied.documentId, "copy-doc");
  assert.equal(copied.documentUrl, "https://docs.google.com/presentation/d/copy-doc/edit");
  assert.deepEqual(fetches, [
    {
      url: "https://www.googleapis.com/drive/v3/files/source-doc?supportsAllDrives=true&fields=parents",
      method: "get",
      payload: null,
    },
    {
      url: "https://www.googleapis.com/drive/v3/files/source-doc/copy?supportsAllDrives=true&fields=id,webViewLink",
      method: "post",
      payload: { name: "Translated copy", parents: ["folder-1"] },
    },
    {
      url: "https://www.googleapis.com/drive/v3/files/source-doc/copy?supportsAllDrives=true&fields=id,webViewLink",
      method: "post",
      payload: { name: "Translated copy" },
    },
  ]);
});

test("copyPresentationFile preserves same-folder failure context when root retry fails", async () => {
  const context = await loadDriveApiContext();
  context.UrlFetchApp = {
    fetch(url, request) {
      if (url === "https://www.googleapis.com/drive/v3/files/source-doc?supportsAllDrives=true&fields=parents") {
        return createResponse(200, { parents: ["folder-1"] });
      }
      if (url === "https://www.googleapis.com/drive/v3/files/source-doc/copy?supportsAllDrives=true&fields=id,webViewLink" &&
          JSON.parse(request.payload).parents) {
        return createResponse(403, {
          error: {
            status: "PERMISSION_DENIED",
            errors: [{ reason: "insufficientFilePermissions" }],
            message: "Cannot create in source folder.",
          },
        });
      }
      if (url === "https://www.googleapis.com/drive/v3/files/source-doc/copy?supportsAllDrives=true&fields=id,webViewLink") {
        return createResponse(500, {
          error: {
            status: "INTERNAL",
            errors: [{ reason: "backendError" }],
            message: "Root copy failed.",
          },
        });
      }
      throw new Error("unexpected URL " + url);
    },
  };

  assert.throws(
    () => context.copyPresentationFile("source-doc", "Translated copy"),
    (err) => {
      assert.equal(err.driveStatus, 500);
      assert.equal(err.driveReason, "backendError");
      assert.equal(err.driveParentRetryStatus, 403);
      assert.equal(err.driveParentRetryReason, "insufficientFilePermissions");
      assert.match(err.message, /Same-folder copy previously failed/);
      return true;
    }
  );
});

test("grantWorkerAccess creates a writer permission and returns the permission id", async () => {
  const context = await loadDriveApiContext();
  context.UrlFetchApp = {
    fetch(url, request) {
      assert.equal(
        url,
        "https://www.googleapis.com/drive/v3/files/source-doc/permissions?supportsAllDrives=true&sendNotificationEmail=false&fields=id"
      );
      assert.equal(request.method, "post");
      assert.deepEqual(JSON.parse(request.payload), {
        type: "user",
        role: "writer",
        emailAddress: "worker@example.com",
      });
      return createResponse(200, { id: "permission-1" });
    },
  };

  assert.equal(context.grantWorkerAccess("source-doc"), "permission-1");
});

test("findWorkerPermissionId returns null when worker permission is absent", async () => {
  const context = await loadDriveApiContext();
  context.UrlFetchApp = {
    fetch(url, request) {
      assert.equal(
        url,
        "https://www.googleapis.com/drive/v3/files/source-doc/permissions?supportsAllDrives=true&fields=permissions(id,type,role,emailAddress)"
      );
      assert.equal(request.method, "get");
      return createResponse(200, {
        permissions: [
          { id: "reader-permission", type: "user", role: "reader", emailAddress: "someone@example.com" },
        ],
      });
    },
  };

  assert.equal(context.findWorkerPermissionId("source-doc"), null);
});

test("revokeWorkerPermission deletes a known Drive permission id", async () => {
  const context = await loadDriveApiContext();
  context.UrlFetchApp = {
    fetch(url, request) {
      assert.equal(
        url,
        "https://www.googleapis.com/drive/v3/files/source-doc/permissions/permission-1?supportsAllDrives=true"
      );
      assert.equal(request.method, "delete");
      return createResponse(204);
    },
  };

  const result = context.revokeWorkerPermission("source-doc", "permission-1");
  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
});

test("revokeWorkerPermission skips missing document or permission ids", async () => {
  const context = await loadDriveApiContext();
  context.UrlFetchApp = {
    fetch() {
      throw new Error("Drive REST should not run for missing permission metadata");
    },
  };

  const result = context.revokeWorkerPermission("source-doc", "");
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
});

test("trashDriveFile marks a prepared copy as trashed through Drive REST", async () => {
  const context = await loadDriveApiContext();
  context.UrlFetchApp = {
    fetch(url, request) {
      assert.equal(
        url,
        "https://www.googleapis.com/drive/v3/files/copy-doc?supportsAllDrives=true&fields=id,trashed"
      );
      assert.equal(request.method, "patch");
      assert.deepEqual(JSON.parse(request.payload), { trashed: true });
      return createResponse(200, { id: "copy-doc", trashed: true });
    },
  };

  assert.equal(context.trashDriveFile("copy-doc"), undefined);
});
