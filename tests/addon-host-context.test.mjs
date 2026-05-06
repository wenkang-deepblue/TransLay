import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function loadHostContext() {
  const driveApiSource = await readFile(
    new URL("../apps/addon/src/server/drive_api.gs", import.meta.url),
    "utf8"
  );
  const hostContextSource = await readFile(
    new URL("../apps/addon/src/server/host_context.gs", import.meta.url),
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
  vm.runInContext(hostContextSource, context);
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

test("prepareOutputPresentation copies and grants worker access through Drive REST", async () => {
  const context = await loadHostContext();
  const fetches = [];
  context.SlidesApp = {
    getActivePresentation() {
      return {
        getId() {
          return "source-doc";
        },
        getName() {
          return "Source deck";
        },
      };
    },
  };
  context.UrlFetchApp = {
    fetch(url, request) {
      fetches.push({
        url,
        method: request.method,
        payload: request.payload ? JSON.parse(request.payload) : null,
      });
      if (url === "https://www.googleapis.com/drive/v3/files/source-doc?supportsAllDrives=true&fields=parents") {
        return createResponse(200, {});
      }
      if (url === "https://www.googleapis.com/drive/v3/files/source-doc/copy?supportsAllDrives=true&fields=id,webViewLink") {
        return createResponse(200, {
          id: "copy-doc",
          webViewLink: "https://docs.google.com/presentation/d/copy-doc/edit",
        });
      }
      if (url === "https://www.googleapis.com/drive/v3/files/copy-doc/permissions?supportsAllDrives=true&sendNotificationEmail=false&fields=id") {
        return createResponse(200, { id: "target-permission" });
      }
      throw new Error("unexpected URL " + url);
    },
  };

  const prepared = context.prepareOutputPresentation("French");
  assert.equal(prepared.documentId, "copy-doc");
  assert.equal(prepared.documentUrl, "https://docs.google.com/presentation/d/copy-doc/edit");
  assert.equal(prepared.targetWorkerPermissionId, "target-permission");
  assert.deepEqual(fetches, [
    {
      url: "https://www.googleapis.com/drive/v3/files/source-doc?supportsAllDrives=true&fields=parents",
      method: "get",
      payload: null,
    },
    {
      url: "https://www.googleapis.com/drive/v3/files/source-doc/copy?supportsAllDrives=true&fields=id,webViewLink",
      method: "post",
      payload: { name: "Source deck (French)" },
    },
    {
      url: "https://www.googleapis.com/drive/v3/files/copy-doc/permissions?supportsAllDrives=true&sendNotificationEmail=false&fields=id",
      method: "post",
      payload: {
        type: "user",
        role: "writer",
        emailAddress: "worker@example.com",
      },
    },
  ]);
});

test("prepareOutputPresentation trashes copied file when worker grant fails", async () => {
  const context = await loadHostContext();
  const fetches = [];
  context.SlidesApp = {
    getActivePresentation() {
      return {
        getId() {
          return "source-doc";
        },
        getName() {
          return "Source deck";
        },
      };
    },
  };
  context.UrlFetchApp = {
    fetch(url, request) {
      fetches.push({
        url,
        method: request.method,
        payload: request.payload ? JSON.parse(request.payload) : null,
      });
      if (url === "https://www.googleapis.com/drive/v3/files/source-doc?supportsAllDrives=true&fields=parents") {
        return createResponse(200, {});
      }
      if (url === "https://www.googleapis.com/drive/v3/files/source-doc/copy?supportsAllDrives=true&fields=id,webViewLink") {
        return createResponse(200, {
          id: "copy-doc",
          webViewLink: "https://docs.google.com/presentation/d/copy-doc/edit",
        });
      }
      if (url === "https://www.googleapis.com/drive/v3/files/copy-doc/permissions?supportsAllDrives=true&sendNotificationEmail=false&fields=id") {
        return createResponse(403, {
          error: {
            status: "PERMISSION_DENIED",
            errors: [{ reason: "insufficientFilePermissions" }],
            message: "Cannot share copied file.",
          },
        });
      }
      if (url === "https://www.googleapis.com/drive/v3/files/copy-doc?supportsAllDrives=true&fields=id,trashed") {
        return createResponse(200, { id: "copy-doc", trashed: true });
      }
      throw new Error("unexpected URL " + url);
    },
  };

  assert.throws(
    () => context.prepareOutputPresentation("French"),
    /Failed to grant worker access to the copied presentation/
  );
  assert.deepEqual(fetches, [
    {
      url: "https://www.googleapis.com/drive/v3/files/source-doc?supportsAllDrives=true&fields=parents",
      method: "get",
      payload: null,
    },
    {
      url: "https://www.googleapis.com/drive/v3/files/source-doc/copy?supportsAllDrives=true&fields=id,webViewLink",
      method: "post",
      payload: { name: "Source deck (French)" },
    },
    {
      url: "https://www.googleapis.com/drive/v3/files/copy-doc/permissions?supportsAllDrives=true&sendNotificationEmail=false&fields=id",
      method: "post",
      payload: {
        type: "user",
        role: "writer",
        emailAddress: "worker@example.com",
      },
    },
    {
      url: "https://www.googleapis.com/drive/v3/files/copy-doc?supportsAllDrives=true&fields=id,trashed",
      method: "patch",
      payload: { trashed: true },
    },
  ]);
});

test("ensureCurrentPresentationWorkerAccess returns the Drive REST permission id", async () => {
  const context = await loadHostContext();
  const fetches = [];
  context.SlidesApp = {
    getActivePresentation() {
      return {
        getId() {
          return "source-doc";
        },
      };
    },
  };
  context.UrlFetchApp = {
    fetch(url, request) {
      fetches.push({
        url,
        method: request.method,
        payload: request.payload ? JSON.parse(request.payload) : null,
      });
      if (url === "https://www.googleapis.com/drive/v3/files/source-doc?supportsAllDrives=true&fields=id,name,mimeType,capabilities(canEdit,canCopy,canShare)") {
        return createResponse(200, {
          id: "source-doc",
          name: "Source deck",
          mimeType: "application/vnd.google-apps.presentation",
          capabilities: {
            canEdit: true,
            canCopy: true,
            canShare: true,
          },
        });
      }
      if (url !== "https://www.googleapis.com/drive/v3/files/source-doc/permissions?supportsAllDrives=true&sendNotificationEmail=false&fields=id") {
        throw new Error("unexpected URL " + url);
      }
      return createResponse(200, { id: "source-permission" });
    },
  };

  const access = context.ensureCurrentPresentationWorkerAccess();
  assert.deepEqual(JSON.parse(JSON.stringify(access)), {
    documentId: "source-doc",
    documentName: "Source deck",
    sourceWorkerPermissionId: "source-permission",
  });
  assert.deepEqual(fetches, [
    {
      url: "https://www.googleapis.com/drive/v3/files/source-doc?supportsAllDrives=true&fields=id,name,mimeType,capabilities(canEdit,canCopy,canShare)",
      method: "get",
      payload: null,
    },
    {
      url: "https://www.googleapis.com/drive/v3/files/source-doc/permissions?supportsAllDrives=true&sendNotificationEmail=false&fields=id",
      method: "post",
      payload: {
        type: "user",
        role: "writer",
        emailAddress: "worker@example.com",
      },
    },
  ]);
});

test("cleanupPreparedPresentation trashes the prepared copy through Drive REST", async () => {
  const context = await loadHostContext();
  const fetches = [];
  context.UrlFetchApp = {
    fetch(url, request) {
      fetches.push({
        url,
        method: request.method,
        payload: request.payload ? JSON.parse(request.payload) : null,
      });
      return createResponse(200, { id: "copy-doc", trashed: true });
    },
  };

  context.cleanupPreparedPresentation("copy-doc");

  assert.deepEqual(fetches, [
    {
      url: "https://www.googleapis.com/drive/v3/files/copy-doc?supportsAllDrives=true&fields=id,trashed",
      method: "patch",
      payload: { trashed: true },
    },
  ]);
});

test("cleanupPreparedTranslationSubmission revokes prepared permissions and trashes target", async () => {
  const context = await loadHostContext();
  const fetches = [];
  context.UrlFetchApp = {
    fetch(url, request) {
      fetches.push({ url, method: request.method });
      if (url === "https://www.googleapis.com/drive/v3/files/target-doc/permissions/target-permission?supportsAllDrives=true") {
        return createResponse(204);
      }
      if (url === "https://www.googleapis.com/drive/v3/files/target-doc?supportsAllDrives=true&fields=id,trashed") {
        return createResponse(200, { id: "target-doc", trashed: true });
      }
      if (url === "https://www.googleapis.com/drive/v3/files/source-doc/permissions/source-permission?supportsAllDrives=true") {
        return createResponse(204);
      }
      throw new Error("unexpected URL " + url);
    },
  };

  context.cleanupPreparedTranslationSubmission(
    "source-doc",
    "source-permission",
    "target-doc",
    "target-permission",
    true
  );

  assert.deepEqual(fetches, [
    {
      url: "https://www.googleapis.com/drive/v3/files/target-doc/permissions/target-permission?supportsAllDrives=true",
      method: "delete",
    },
    {
      url: "https://www.googleapis.com/drive/v3/files/target-doc?supportsAllDrives=true&fields=id,trashed",
      method: "patch",
    },
    {
      url: "https://www.googleapis.com/drive/v3/files/source-doc/permissions/source-permission?supportsAllDrives=true",
      method: "delete",
    },
  ]);
});

test("cleanupPreparedTranslationSubmission does not trash unconfirmed target documents", async () => {
  const context = await loadHostContext();
  const fetches = [];
  context.UrlFetchApp = {
    fetch(url, request) {
      fetches.push({ url, method: request.method });
      if (url === "https://www.googleapis.com/drive/v3/files/target-doc/permissions/target-permission?supportsAllDrives=true") {
        return createResponse(204);
      }
      if (url === "https://www.googleapis.com/drive/v3/files/source-doc/permissions/source-permission?supportsAllDrives=true") {
        return createResponse(204);
      }
      throw new Error("unexpected URL " + url);
    },
  };

  context.cleanupPreparedTranslationSubmission(
    "source-doc",
    "source-permission",
    "target-doc",
    "target-permission",
    false
  );

  assert.deepEqual(fetches, [
    {
      url: "https://www.googleapis.com/drive/v3/files/target-doc/permissions/target-permission?supportsAllDrives=true",
      method: "delete",
    },
    {
      url: "https://www.googleapis.com/drive/v3/files/source-doc/permissions/source-permission?supportsAllDrives=true",
      method: "delete",
    },
  ]);
});

test("revokeWorkerAccessForJob looks up and deletes worker permissions through Drive REST", async () => {
  const context = await loadHostContext();
  const fetches = [];
  context.UrlFetchApp = {
    fetch(url, request) {
      fetches.push({ url, method: request.method });
      if (url === "https://www.googleapis.com/drive/v3/files/source-doc/permissions?supportsAllDrives=true&fields=permissions(id,type,role,emailAddress)") {
        return createResponse(200, {
          permissions: [{ id: "source-permission", type: "user", role: "writer", emailAddress: "worker@example.com" }],
        });
      }
      if (url === "https://www.googleapis.com/drive/v3/files/target-doc/permissions?supportsAllDrives=true&fields=permissions(id,type,role,emailAddress)") {
        return createResponse(200, {
          permissions: [{ id: "target-permission", type: "user", role: "writer", emailAddress: "worker@example.com" }],
        });
      }
      if (url === "https://www.googleapis.com/drive/v3/files/source-doc/permissions/source-permission?supportsAllDrives=true") {
        return createResponse(204);
      }
      if (url === "https://www.googleapis.com/drive/v3/files/target-doc/permissions/target-permission?supportsAllDrives=true") {
        return createResponse(204);
      }
      throw new Error("unexpected URL " + url);
    },
  };

  context.revokeWorkerAccessForJob("source-doc", "target-doc");

  assert.deepEqual(fetches, [
    {
      url: "https://www.googleapis.com/drive/v3/files/source-doc/permissions?supportsAllDrives=true&fields=permissions(id,type,role,emailAddress)",
      method: "get",
    },
    {
      url: "https://www.googleapis.com/drive/v3/files/source-doc/permissions/source-permission?supportsAllDrives=true",
      method: "delete",
    },
    {
      url: "https://www.googleapis.com/drive/v3/files/target-doc/permissions?supportsAllDrives=true&fields=permissions(id,type,role,emailAddress)",
      method: "get",
    },
    {
      url: "https://www.googleapis.com/drive/v3/files/target-doc/permissions/target-permission?supportsAllDrives=true",
      method: "delete",
    },
  ]);
});
