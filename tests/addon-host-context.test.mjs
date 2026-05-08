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

test("prepareOutputPresentation creates a SlidesApp copy without Drive REST or worker access", async () => {
  const context = await loadHostContext();
  const removedDefaults = [];
  const appendedSlides = [];
  const sourceSlides = [
    { getObjectId: () => "source-slide-1" },
    { getObjectId: () => "source-slide-2" },
  ];
  const target = {
    getId() {
      return "target-doc";
    },
    getUrl() {
      return "https://docs.google.com/presentation/d/target-doc/edit";
    },
    getSlides() {
      return [
        {
          remove() {
            removedDefaults.push("default-slide");
          },
        },
      ];
    },
    appendSlide(slide) {
      appendedSlides.push(slide.getObjectId());
    },
    saveAndClose() {
      appendedSlides.push("saved");
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
        getSlides() {
          return sourceSlides;
        },
      };
    },
    create(name) {
      assert.equal(name, "Source deck (French)");
      return target;
    },
    openById(id) {
      assert.equal(id, "target-doc");
      return target;
    },
  };
  context.UrlFetchApp = {
    fetch() {
      throw new Error("prepareOutputPresentation must not call Drive REST");
    },
  };

  const prepared = context.prepareOutputPresentation("French");
  assert.equal(prepared.documentId, "target-doc");
  assert.equal(prepared.documentUrl, "https://docs.google.com/presentation/d/target-doc/edit");
  assert.equal(prepared.targetWorkerPermissionId, null);
  assert.equal(prepared.accessMode, "user_oauth_only");
  assert.deepEqual(removedDefaults, ["default-slide"]);
  assert.deepEqual(appendedSlides, ["source-slide-1", "source-slide-2", "saved"]);
});

test("prepareOutputPresentation reports SlidesApp preparation failures without Drive REST", async () => {
  const context = await loadHostContext();
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
    create() {
      throw new Error("Slides create failed for source-doc");
    },
  };
  context.UrlFetchApp = {
    fetch() {
      throw new Error("prepareOutputPresentation must not call Drive REST");
    },
  };

  assert.throws(
    () => context.prepareOutputPresentation("French"),
    { message: "Failed to prepare the new presentation" }
  );
});

test("ensureCurrentPresentationReadyForUserOauthJob reads active Slides metadata without Drive REST", async () => {
  const context = await loadHostContext();
  context.SlidesApp = {
    getActivePresentation() {
      return {
        getId() {
          return "source-doc";
        },
        getName() {
          return "Source deck";
        },
        getSlides() {
          return [{ getObjectId: () => "slide-1" }];
        },
      };
    },
  };
  context.UrlFetchApp = {
    fetch() {
      throw new Error("source readiness must not call Drive REST");
    },
  };

  const access = context.ensureCurrentPresentationReadyForUserOauthJob();
  assert.deepEqual(JSON.parse(JSON.stringify(access)), {
    documentId: "source-doc",
    documentName: "Source deck",
    sourceWorkerPermissionId: null,
    accessMode: "user_oauth_only",
  });
});

test("ensureCurrentPresentationReadyForUserOauthJob hides low-level Slides errors", async () => {
  const context = await loadHostContext();
  context.SlidesApp = {
    getActivePresentation() {
      return {
        getId() {
          return "source-doc";
        },
        getName() {
          return "Source deck";
        },
        getSlides() {
          throw new Error("internal failure for source-doc");
        },
      };
    },
  };

  assert.throws(
    () => context.ensureCurrentPresentationReadyForUserOauthJob(),
    { message: "Failed to read the current presentation for translation" }
  );
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
