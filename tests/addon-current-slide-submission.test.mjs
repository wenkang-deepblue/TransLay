import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function loadSidebarSource() {
  return readFile(new URL("../apps/addon/src/sidebar/index.html", import.meta.url), "utf8");
}

test("current slide submissions refresh the active slide before previewing quota", async () => {
  const source = await loadSidebarSource();

  assert.match(
    source,
    /refreshCurrentSlideIndexForSubmission\(function\(\) \{\s*buildAndPreviewTranslationSubmission\(\);/s
  );
  assert.match(source, /\.getCurrentSlideIndex\(\);/);
  assert.match(source, /rangeExpression = String\(state\.currentSlideIndex\);/);
  assert.doesNotMatch(source, /rangeExpression = String\(state\.currentSlideIndex \|\| 1\);/);
});

test("sidebar does not initialize unknown current slide as slide one", async () => {
  const source = await loadSidebarSource();

  assert.match(source, /currentSlideIndex: null/);
  assert.match(source, /state\.currentSlideIndex = normalizeSlideIndex\(data\.currentSlideIndex\);/);
  assert.doesNotMatch(source, /state\.currentSlideIndex = data\.currentSlideIndex \|\| 1;/);
});
