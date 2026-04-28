import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function loadHostContext() {
  const source = await readFile(
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
  vm.runInContext(source, context);
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

test("prepareOutputPresentation copies with Drive API before using DriveApp", async () => {
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
      if (url.indexOf("/copy?") !== -1) {
        return createResponse(200, {
          id: "copy-doc",
          webViewLink: "https://docs.google.com/presentation/d/copy-doc/edit",
        });
      }
      if (url.indexOf("/permissions?") !== -1) {
        return createResponse(200, { id: "permission-1" });
      }
      throw new Error("unexpected URL " + url);
    },
  };
  context.DriveApp = {
    getFileById() {
      throw new Error("DriveApp should not be used");
    },
  };

  const prepared = context.prepareOutputPresentation("French");
  assert.equal(prepared.documentId, "copy-doc");
  assert.equal(prepared.documentUrl, "https://docs.google.com/presentation/d/copy-doc/edit");
  assert.deepEqual(fetches, [
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

test("copyPresentationFile falls back to DriveApp root when Drive API and source folder copies fail", async () => {
  const context = await loadHostContext();
  const parentFolder = { id: "folder-1" };
  const calls = [];
  const rootCopy = {
    getId() {
      return "copy-root";
    },
  };
  const sourceFile = {
    getParents() {
      return {
        hasNext() {
          return true;
        },
        next() {
          return parentFolder;
        },
      };
    },
    makeCopy(name, folder) {
      calls.push({ name, folder: folder ?? null });
      if (folder) {
        throw new Error("cannot create in source folder");
      }
      return rootCopy;
    },
  };
  context.UrlFetchApp = {
    fetch() {
      return createResponse(403, {
        error: {
          status: "PERMISSION_DENIED",
          errors: [{ reason: "insufficientFilePermissions" }],
          message: "The user does not have sufficient permissions",
        },
      });
    },
  };
  context.DriveApp = {
    getFileById(fileId) {
      assert.equal(fileId, "source-doc");
      return sourceFile;
    },
  };

  const copied = context.copyPresentationFile("source-doc", "Translated copy");

  assert.equal(copied.documentId, "copy-root");
  assert.equal(copied.documentUrl, "https://docs.google.com/presentation/d/copy-root/edit");
  assert.deepEqual(calls, [
    { name: "Translated copy", folder: parentFolder },
    { name: "Translated copy", folder: null },
  ]);
});

test("DriveApp fallback copy uses My Drive root when source parents cannot be inspected", async () => {
  const context = await loadHostContext();
  const rootCopy = {
    getId() {
      return "copy-root";
    },
  };
  const sourceFile = {
    getParents() {
      throw new Error("no parent visibility");
    },
    makeCopy(name, folder) {
      assert.equal(name, "Translated copy");
      assert.equal(folder, undefined);
      return rootCopy;
    },
  };
  context.DriveApp = {
    getFileById(fileId) {
      assert.equal(fileId, "source-doc");
      return sourceFile;
    },
  };

  const copied = context.copyPresentationFileViaDriveApp("source-doc", "Translated copy");
  assert.equal(copied.documentId, "copy-root");
  assert.equal(copied.documentUrl, "https://docs.google.com/presentation/d/copy-root/edit");
});
