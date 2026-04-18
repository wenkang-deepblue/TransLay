import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import {
  __resetSlidesClientForTests,
  __setSlidesAuthHooksForTests,
  __setSlidesClientForTests,
} from "./auth";
import { fetchSlideThumbnail, fetchSlideThumbnails, normalizeThumbnailMimeType } from "./thumbnails";

test("fetchSlideThumbnail reuses an in-memory cache entry for repeated slide requests", async () => {
  let thumbnailCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(Buffer.from("fake-image"), {
      status: 200,
      headers: { "Content-Type": "image/png" },
    })) as typeof fetch;

  __setSlidesClientForTests({
    auth: {
      getClient: async () => ({
        getAccessToken: async () => ({ token: "test-token" }),
      }),
    } as never,
    slides: {
      presentations: {
        pages: {
          getThumbnail: async () => {
            thumbnailCalls += 1;
            return {
              data: {
                contentUrl: "https://lh3.googleusercontent.com/thumb.png",
                mimeType: "PNG",
              },
            };
          },
        },
      },
    } as never,
  });

  try {
    const cache = new Map();
    const slide = {
      slide_index: 0,
      slide_object_id: "slide_0",
      nodes: [],
    };

    const first = await fetchSlideThumbnail("pres-1", slide, { cache });
    const second = await fetchSlideThumbnail("pres-1", slide, { cache });

    assert.equal(first.base64_data, second.base64_data);
    assert.equal(thumbnailCalls, 1);
  } finally {
    __resetSlidesClientForTests();
    globalThis.fetch = originalFetch;
  }
});

test("fetchSlideThumbnails forwards cache metadata to batch requests", async () => {
  let thumbnailCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(Buffer.from("fake-image"), {
      status: 200,
      headers: { "Content-Type": "image/png" },
    })) as typeof fetch;

  __setSlidesClientForTests({
    auth: {
      getClient: async () => ({
        getAccessToken: async () => ({ token: "test-token" }),
      }),
    } as never,
    slides: {
      presentations: {
        pages: {
          getThumbnail: async () => {
            thumbnailCalls += 1;
            return {
              data: {
                contentUrl: "https://lh3.googleusercontent.com/thumb.png",
                mimeType: "PNG",
              },
            };
          },
        },
      },
    } as never,
  });

  try {
    const cache = new Map();
    const slide = {
      slide_index: 0,
      slide_object_id: "slide_0",
      nodes: [],
    };

    const first = await fetchSlideThumbnails("pres-1", [slide], { cache, jobId: "job-1" });
    const second = await fetchSlideThumbnails("pres-1", [slide], { cache, jobId: "job-1" });

    assert.equal(first[0]?.base64_data, second[0]?.base64_data);
    assert.equal(thumbnailCalls, 1);
  } finally {
    __resetSlidesClientForTests();
    globalThis.fetch = originalFetch;
  }
});

test("fetchSlideThumbnails preserves job auth for batch requests and uses fallback auth after a read failure", async () => {
  let userThumbnailAttempts = 0;
  let authorizedHeader: string | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    if (!init?.headers) {
      return new Response("forbidden", { status: 403 });
    }
    const headers = init.headers as Record<string, string>;
    authorizedHeader = headers.Authorization ?? null;
    return new Response(Buffer.from("fallback-image"), {
      status: 200,
      headers: { "Content-Type": "image/png" },
    });
  }) as typeof fetch;

  __setSlidesClientForTests({
    auth: {
      getClient: async () => ({
        getAccessToken: async () => ({ token: "sa-token" }),
      }),
    } as never,
    slides: {
      presentations: {
        pages: {
          getThumbnail: async () => ({
            data: {
              contentUrl: "https://lh3.googleusercontent.com/thumb.png",
              mimeType: "PNG",
            },
          }),
        },
      },
    } as never,
  });

  __setSlidesAuthHooksForTests({
    nowMs: () => Date.parse("2026-04-17T10:00:00.000Z"),
    decryptToken: async () => "user-token",
    buildUserSlidesClient: () => ({
      auth: {
        getAccessToken: async () => ({ token: "user-token" }),
      } as never,
      slides: {
        presentations: {
          pages: {
            getThumbnail: async () => {
              userThumbnailAttempts += 1;
              throw Object.assign(new Error("invalid credentials"), { status: 401 });
            },
          },
        },
      } as never,
    }),
  });

  const pool = {
    query: async () => ({
      rows: [
        {
          user_id: "user-1",
          host_oauth_access_token_enc: Buffer.from("ciphertext"),
          host_oauth_token_expires_at: "2026-04-17T10:10:00.000Z",
          host_oauth_source: "addon",
        },
      ],
    }),
  } as unknown as Pool;

  try {
    const [thumbnail] = await fetchSlideThumbnails(
      "pres-1",
      [{ slide_index: 0, slide_object_id: "slide_0", nodes: [] }],
      {
        pool,
        jobId: "job-1",
      }
    );

    assert.equal(userThumbnailAttempts, 1);
    assert.equal(authorizedHeader, "Bearer sa-token");
    assert.equal(thumbnail?.mime_type, "image/png");
    assert.ok(thumbnail?.base64_data);
  } finally {
    __resetSlidesClientForTests();
    globalThis.fetch = originalFetch;
  }
});

test("fetchSlideThumbnail falls back to service account when thumbnail content auth fails after metadata succeeds", async () => {
  const authHeaders: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    if (!init?.headers) {
      return new Response("forbidden", { status: 403 });
    }
    const headers = init.headers as Record<string, string>;
    authHeaders.push(headers.Authorization ?? "");
    if (headers.Authorization === "Bearer user-token") {
      return new Response("forbidden", { status: 403 });
    }
    return new Response(Buffer.from("sa-fallback-image"), {
      status: 200,
      headers: { "Content-Type": "image/png" },
    });
  }) as typeof fetch;

  __setSlidesClientForTests({
    auth: {
      getClient: async () => ({
        getAccessToken: async () => ({ token: "sa-token" }),
      }),
    } as never,
    slides: {
      presentations: {
        pages: {
          getThumbnail: async () => ({
            data: {
              contentUrl: "https://lh3.googleusercontent.com/thumb.png",
              mimeType: "PNG",
            },
          }),
        },
      },
    } as never,
  });

  __setSlidesAuthHooksForTests({
    nowMs: () => Date.parse("2026-04-17T10:00:00.000Z"),
    decryptToken: async () => "user-token",
    buildUserSlidesClient: () => ({
      auth: {
        getAccessToken: async () => ({ token: "user-token" }),
      } as never,
      slides: {
        presentations: {
          pages: {
            getThumbnail: async () => ({
              data: {
                contentUrl: "https://lh3.googleusercontent.com/thumb.png",
                mimeType: "PNG",
              },
            }),
          },
        },
      } as never,
    }),
  });

  const pool = {
    query: async () => ({
      rows: [
        {
          user_id: "user-1",
          host_oauth_access_token_enc: Buffer.from("ciphertext"),
          host_oauth_token_expires_at: "2026-04-17T10:10:00.000Z",
          host_oauth_source: "addon",
        },
      ],
    }),
  } as unknown as Pool;

  try {
    const thumbnail = await fetchSlideThumbnail(
      "pres-1",
      { slide_index: 0, slide_object_id: "slide_0", nodes: [] },
      {
        pool,
        jobId: "job-2",
      }
    );

    assert.deepEqual(authHeaders, ["Bearer user-token", "Bearer sa-token"]);
    assert.equal(thumbnail.mime_type, "image/png");
    assert.ok(thumbnail.base64_data);
  } finally {
    __resetSlidesClientForTests();
    globalThis.fetch = originalFetch;
  }
});

test("normalizeThumbnailMimeType maps Slides enum values to standard image mime types", () => {
  assert.equal(normalizeThumbnailMimeType("PNG"), "image/png");
  assert.equal(normalizeThumbnailMimeType("JPEG"), "image/jpeg");
  assert.equal(normalizeThumbnailMimeType("JPG"), "image/jpeg");
  assert.equal(normalizeThumbnailMimeType("WEBP"), "image/webp");
  assert.equal(normalizeThumbnailMimeType("GIF"), "image/gif");
});

test("normalizeThumbnailMimeType accepts already-normalized mime types and blanks", () => {
  assert.equal(normalizeThumbnailMimeType("image/png"), "image/png");
  assert.equal(normalizeThumbnailMimeType(" Image/JPEG "), "image/jpeg");
  assert.equal(normalizeThumbnailMimeType(undefined), "image/png");
  assert.equal(normalizeThumbnailMimeType(""), "image/png");
});

test("fetchSlideThumbnail rejects non-Google thumbnail hosts before sending bearer tokens", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response("unexpected", { status: 200 });
  }) as typeof fetch;

  __setSlidesClientForTests({
    auth: {
      getClient: async () => ({
        getAccessToken: async () => ({ token: "test-token" }),
      }),
    } as never,
    slides: {
      presentations: {
        pages: {
          getThumbnail: async () => ({
            data: {
              contentUrl: "https://example.com/thumb.png",
              mimeType: "PNG",
            },
          }),
        },
      },
    } as never,
  });

  try {
    await assert.rejects(
      () =>
        fetchSlideThumbnail("pres-1", {
          slide_index: 0,
          slide_object_id: "slide_0",
          nodes: [],
        }),
      /host is not allowed/
    );
    assert.equal(fetchCalls, 0);
  } finally {
    __resetSlidesClientForTests();
    globalThis.fetch = originalFetch;
  }
});
