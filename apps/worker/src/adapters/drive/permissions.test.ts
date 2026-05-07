import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { google } from "googleapis";
import { DriveCleanupAuthError } from "./auth";
import {
  __resetDrivePermissionsHooksForTests,
  __setDrivePermissionsHooksForTests,
  buildDriveCleanupTargets,
  cleanupDriveWorkerPermissionsForJob,
  revokeDrivePermission,
} from "./permissions";

const noopPool = {} as Pool;

test("buildDriveCleanupTargets includes source and distinct create-new-file target permissions", () => {
  assert.deepEqual(
    buildDriveCleanupTargets({
      id: "job-1",
      source_doc_id: "source-doc",
      target_doc_id: "target-doc",
      source_worker_permission_id: "source-permission",
      target_worker_permission_id: "target-permission",
    }),
    [
      {
        kind: "source",
        fileId: "source-doc",
        permissionId: "source-permission",
      },
      {
        kind: "target",
        fileId: "target-doc",
        permissionId: "target-permission",
      },
    ]
  );
});

test("buildDriveCleanupTargets keeps distinct in-file source and target permissions", () => {
  assert.deepEqual(
    buildDriveCleanupTargets({
      id: "job-same-file",
      source_doc_id: "source-doc",
      target_doc_id: "source-doc",
      source_worker_permission_id: "source-permission",
      target_worker_permission_id: "target-permission",
    }),
    [
      {
        kind: "source",
        fileId: "source-doc",
        permissionId: "source-permission",
      },
      {
        kind: "target",
        fileId: "source-doc",
        permissionId: "target-permission",
      },
    ]
  );
});

test("buildDriveCleanupTargets deduplicates repeated in-file permission ids", () => {
  assert.deepEqual(
    buildDriveCleanupTargets({
      id: "job-same-permission",
      source_doc_id: "source-doc",
      target_doc_id: "source-doc",
      source_worker_permission_id: "same-permission",
      target_worker_permission_id: "same-permission",
    }),
    [
      {
        kind: "source",
        fileId: "source-doc",
        permissionId: "same-permission",
      },
    ]
  );
});

test("buildDriveCleanupTargets handles append-in-file jobs without target permissions", () => {
  assert.deepEqual(
    buildDriveCleanupTargets({
      id: "job-append-in-file",
      source_doc_id: "source-doc",
      target_doc_id: "source-doc",
      source_worker_permission_id: "source-permission",
      target_worker_permission_id: null,
    }),
    [
      {
        kind: "source",
        fileId: "source-doc",
        permissionId: "source-permission",
      },
    ]
  );
});

test("cleanupDriveWorkerPermissionsForJob revokes all temporary permissions", async () => {
  const deletes: Array<{ fileId: string; permissionId: string; supportsAllDrives: boolean }> = [];
  const options: unknown[] = [];
  __setDrivePermissionsHooksForTests({
    getDriveClientForJob: async () => ({
      auth: {} as never,
      source: "user",
      jobId: "job-1",
      userId: "user-1",
      drive: {
        permissions: {
          delete: async (params: unknown, option: unknown) => {
            deletes.push(params as { fileId: string; permissionId: string; supportsAllDrives: boolean });
            options.push(option);
            return { data: {} };
          },
        },
      } as never,
    }),
  });

  try {
    const result = await cleanupDriveWorkerPermissionsForJob(noopPool, {
      id: "job-1",
      source_doc_id: "source-doc",
      target_doc_id: "target-doc",
      source_worker_permission_id: "source-permission",
      target_worker_permission_id: "target-permission",
    });

    assert.deepEqual(result, {
      status: "succeeded",
      attempted: true,
      errorCode: null,
      targetCount: 2,
    });
    assert.deepEqual(deletes, [
      {
        fileId: "source-doc",
        permissionId: "source-permission",
        supportsAllDrives: true,
      },
      {
        fileId: "target-doc",
        permissionId: "target-permission",
        supportsAllDrives: true,
      },
    ]);
    assert.deepEqual(options, [{ timeout: 10000 }, { timeout: 10000 }]);
  } finally {
    __resetDrivePermissionsHooksForTests();
  }
});

test("cleanupDriveWorkerPermissionsForJob treats already removed permissions as success", async () => {
  __setDrivePermissionsHooksForTests({
    getDriveClientForJob: async () => ({
      auth: {} as never,
      source: "user",
      jobId: "job-404",
      userId: "user-1",
      drive: {
        permissions: {
          delete: async () => {
            throw Object.assign(new Error("not found"), { response: { status: 404 } });
          },
        },
      } as never,
    }),
  });

  try {
    const result = await cleanupDriveWorkerPermissionsForJob(noopPool, {
      id: "job-404",
      source_doc_id: "source-doc",
      target_doc_id: null,
      source_worker_permission_id: "source-permission",
      target_worker_permission_id: null,
    });

    assert.deepEqual(result, {
      status: "succeeded",
      attempted: true,
      errorCode: null,
      targetCount: 1,
    });
  } finally {
    __resetDrivePermissionsHooksForTests();
  }
});

test("cleanupDriveWorkerPermissionsForJob records token expiry as failed cleanup without deleting permissions", async () => {
  __setDrivePermissionsHooksForTests({
    getDriveClientForJob: async () => {
      throw new DriveCleanupAuthError(
        "host_oauth_token_expired",
        "Host OAuth token is expired for Drive cleanup"
      );
    },
  });

  try {
    const result = await cleanupDriveWorkerPermissionsForJob(noopPool, {
      id: "job-expired",
      source_doc_id: "source-doc",
      target_doc_id: null,
      source_worker_permission_id: "source-permission",
      target_worker_permission_id: null,
    });

    assert.deepEqual(result, {
      status: "failed",
      attempted: true,
      errorCode: "host_oauth_token_expired",
      targetCount: 1,
    });
  } finally {
    __resetDrivePermissionsHooksForTests();
  }
});

test("cleanupDriveWorkerPermissionsForJob keeps best-effort cleanup visible when one delete fails", async () => {
  const attemptedFiles: string[] = [];
  __setDrivePermissionsHooksForTests({
    getDriveClientForJob: async () => ({
      auth: {} as never,
      source: "user",
      jobId: "job-partial-failure",
      userId: "user-1",
      drive: {
        permissions: {
          delete: async (params: { fileId?: unknown }) => {
            attemptedFiles.push(String(params.fileId));
            if (params.fileId === "source-doc") {
              throw Object.assign(new Error("forbidden"), { response: { status: 403 } });
            }
            return { data: {} };
          },
        },
      } as never,
    }),
  });

  try {
    const result = await cleanupDriveWorkerPermissionsForJob(noopPool, {
      id: "job-partial-failure",
      source_doc_id: "source-doc",
      target_doc_id: "target-doc",
      source_worker_permission_id: "source-permission",
      target_worker_permission_id: "target-permission",
    });

    assert.deepEqual(attemptedFiles, ["source-doc", "target-doc"]);
    assert.deepEqual(result, {
      status: "failed",
      attempted: true,
      errorCode: "drive_cleanup_forbidden",
      targetCount: 2,
    });
  } finally {
    __resetDrivePermissionsHooksForTests();
  }
});

test("revokeDrivePermission retries Drive rate limits before marking cleanup failed", async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  __setDrivePermissionsHooksForTests({
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  try {
    await revokeDrivePermission(
      {
        permissions: {
          delete: async () => {
            attempts += 1;
            if (attempts === 1) {
              throw Object.assign(new Error("rate limited"), { response: { status: 429 } });
            }
            return { data: {} };
          },
        },
      } as never,
      {
        kind: "source",
        fileId: "source-doc",
        permissionId: "source-permission",
      }
    );

    assert.equal(attempts, 2);
    assert.deepEqual(sleeps, [500]);
  } finally {
    __resetDrivePermissionsHooksForTests();
  }
});

test("cleanupDriveWorkerPermissionsForJob records retry-exhausted 5xx short codes", async () => {
  const sleeps: number[] = [];
  __setDrivePermissionsHooksForTests({
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    getDriveClientForJob: async () => ({
      auth: {} as never,
      source: "user",
      jobId: "job-5xx",
      userId: "user-1",
      drive: {
        permissions: {
          delete: async () => {
            throw Object.assign(new Error("unavailable"), { response: { status: 503 } });
          },
        },
      } as never,
    }),
  });

  try {
    const result = await cleanupDriveWorkerPermissionsForJob(noopPool, {
      id: "job-5xx",
      source_doc_id: "source-doc",
      target_doc_id: null,
      source_worker_permission_id: "source-permission",
      target_worker_permission_id: null,
    });

    assert.deepEqual(sleeps, [500, 1000]);
    assert.deepEqual(result, {
      status: "failed",
      attempted: true,
      errorCode: "drive_cleanup_api_unavailable",
      targetCount: 1,
    });
  } finally {
    __resetDrivePermissionsHooksForTests();
  }
});

test("cleanupDriveWorkerPermissionsForJob records network transport errors distinctly", async () => {
  __setDrivePermissionsHooksForTests({
    sleep: async () => {},
    getDriveClientForJob: async () => ({
      auth: {} as never,
      source: "user",
      jobId: "job-network",
      userId: "user-1",
      drive: {
        permissions: {
          delete: async () => {
            throw Object.assign(new Error("network unavailable"), { code: "ENOTFOUND" });
          },
        },
      } as never,
    }),
  });

  try {
    const result = await cleanupDriveWorkerPermissionsForJob(noopPool, {
      id: "job-network",
      source_doc_id: "source-doc",
      target_doc_id: null,
      source_worker_permission_id: "source-permission",
      target_worker_permission_id: null,
    });

    assert.deepEqual(result, {
      status: "failed",
      attempted: true,
      errorCode: "drive_cleanup_network_error",
      targetCount: 1,
    });
  } finally {
    __resetDrivePermissionsHooksForTests();
  }
});

test("revokeDrivePermission uses googleapis Drive REST DELETE request shape", async () => {
  const requests: Array<{
    url: string;
    method: string;
    params: unknown;
    authorization: string | undefined;
    timeout: number | undefined;
  }> = [];
  const drive = createCapturedGoogleDriveClient(async (options) => {
    requests.push(captureDriveRequest(options));
    return {
      data: {},
      status: 204,
      statusText: "No Content",
      headers: {},
      config: options,
    };
  });

  await revokeDrivePermission(drive, {
    kind: "source",
    fileId: "source doc",
    permissionId: "permission/id",
  });

  assert.deepEqual(requests, [
    {
      url: "https://www.googleapis.com/drive/v3/files/source%20doc/permissions/permission%2Fid",
      method: "DELETE",
      params: { supportsAllDrives: true },
      authorization: "Bearer drive-access-token",
      timeout: 10000,
    },
  ]);
});

test("revokeDrivePermission treats googleapis Drive REST 404 as idempotent success", async () => {
  let requestCount = 0;
  const drive = createCapturedGoogleDriveClient(async (options) => {
    requestCount += 1;
    throw Object.assign(new Error("not found"), {
      response: {
        status: 404,
        config: options,
      },
    });
  });

  await revokeDrivePermission(drive, {
    kind: "source",
    fileId: "source-doc",
    permissionId: "source-permission",
  });

  assert.equal(requestCount, 1);
});

test("revokeDrivePermission surfaces googleapis Drive REST 401 failures", async () => {
  const drive = createCapturedGoogleDriveClient(async (options) => {
    throw Object.assign(new Error("unauthorized"), {
      response: {
        status: 401,
        config: options,
      },
    });
  });

  await assert.rejects(
    () =>
      revokeDrivePermission(drive, {
        kind: "source",
        fileId: "source-doc",
        permissionId: "source-permission",
      }),
    (error) => {
      assert.equal((error as { response?: { status?: unknown } }).response?.status, 401);
      return true;
    }
  );
});

test("cleanupDriveWorkerPermissionsForJob parses string numeric Drive statuses", async () => {
  __setDrivePermissionsHooksForTests({
    getDriveClientForJob: async () => ({
      auth: {} as never,
      source: "user",
      jobId: "job-string-status",
      userId: "user-1",
      drive: {
        permissions: {
          delete: async () => {
            throw Object.assign(new Error("forbidden"), { response: { status: "403" } });
          },
        },
      } as never,
    }),
  });

  try {
    const result = await cleanupDriveWorkerPermissionsForJob(noopPool, {
      id: "job-string-status",
      source_doc_id: "source-doc",
      target_doc_id: null,
      source_worker_permission_id: "source-permission",
      target_worker_permission_id: null,
    });

    assert.equal(result.errorCode, "drive_cleanup_forbidden");
  } finally {
    __resetDrivePermissionsHooksForTests();
  }
});

function createCapturedGoogleDriveClient(
  request: (options: {
    url?: string;
    method?: string;
    params?: unknown;
    headers?: Record<string, string>;
    timeout?: number;
  }) => Promise<unknown>
): ReturnType<typeof google.drive> {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: "drive-access-token" });
  auth.transporter = {
    request: request as never,
  } as never;
  return google.drive({ version: "v3", auth });
}

function captureDriveRequest(options: {
  url?: string;
  method?: string;
  params?: unknown;
  headers?: Record<string, string>;
  timeout?: number;
}) {
  return {
    url: options.url ?? "",
    method: options.method ?? "",
    params: options.params,
    authorization: options.headers?.Authorization,
    timeout: options.timeout,
  };
}
