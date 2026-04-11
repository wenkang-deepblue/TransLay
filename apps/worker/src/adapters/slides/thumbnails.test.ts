import test from "node:test";
import assert from "node:assert/strict";
import { normalizeThumbnailMimeType } from "./thumbnails";

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
