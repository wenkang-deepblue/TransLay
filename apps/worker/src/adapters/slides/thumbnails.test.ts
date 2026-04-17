import test from "node:test";
import assert from "node:assert/strict";
import { __resetSlidesClientForTests, __setSlidesClientForTests } from "./auth";
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
                contentUrl: "https://example.com/thumb.png",
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
                contentUrl: "https://example.com/thumb.png",
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
