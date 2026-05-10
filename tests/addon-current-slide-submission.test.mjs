import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function loadSidebarSource() {
  return readFile(new URL("../apps/addon/src/sidebar/index.html", import.meta.url), "utf8");
}

function extractFunctionBody(source, functionName, nextFunctionName) {
  const start = source.indexOf(`function ${functionName}`);
  const end = source.indexOf(`function ${nextFunctionName}`, start);
  assert.notEqual(start, -1, `${functionName} not found`);
  assert.notEqual(end, -1, `${nextFunctionName} not found after ${functionName}`);
  return source.slice(start, end);
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

test("current slide refresh failure uses stable user-facing copy", async () => {
  const source = await loadSidebarSource();
  const refreshCurrentSlideIndexForSubmission = extractFunctionBody(
    source,
    "refreshCurrentSlideIndexForSubmission",
    "previewTranslationSubmission"
  );

  assert.match(
    refreshCurrentSlideIndexForSubmission,
    /showError\('Unable to determine the current slide\. Select a slide in Google Slides™ and try again\.'\)/
  );
  assert.doesNotMatch(refreshCurrentSlideIndexForSubmission, /err\.message|detail/);
});
