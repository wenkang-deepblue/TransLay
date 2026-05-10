import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function loadSidebarSource() {
  return readFile(new URL("../apps/addon/src/sidebar/index.html", import.meta.url), "utf8");
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  let depth = 0;
  let seenBody = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") {
      depth += 1;
      seenBody = true;
    } else if (char === "}") {
      depth -= 1;
      if (seenBody && depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new Error(`${name} body not found`);
}

function extractFunctionBody(source, functionName, nextFunctionName) {
  const start = source.indexOf(`function ${functionName}`);
  const end = source.indexOf(`function ${nextFunctionName}`, start);
  assert.notEqual(start, -1, `${functionName} not found`);
  assert.notEqual(end, -1, `${nextFunctionName} not found after ${functionName}`);
  return source.slice(start, end);
}

test("no-billed canceled results do not synthesize an output document link", async () => {
  const source = await loadSidebarSource();
  const showCanceledResult = extractFunction(source, "showCanceledResult");

  assert.match(showCanceledResult, /hasCountedQuota\(resp\)/);
  assert.match(
    showCanceledResult,
    /var outputUrl = hasDeliveredSlides \? resolveOutputDocumentUrl\(resp\) : null;/
  );
  assert.doesNotMatch(showCanceledResult, /resolveOutputDocumentUrl\(resp\), \[\], resp\)/);
});

test("pre-accept create-new-file cancellation does not expose created presentation text or link", async () => {
  const source = await loadSidebarSource();
  const finishSubmissionCanceled = extractFunction(source, "finishSubmissionCanceled");

  assert.match(finishSubmissionCanceled, /function finishSubmissionCanceled\(outputMode\)/);
  assert.doesNotMatch(finishSubmissionCanceled, /targetDocumentId/);
  assert.doesNotMatch(finishSubmissionCanceled, /buildPresentationUrl/);
  assert.doesNotMatch(finishSubmissionCanceled, /new presentation was already created/);
  assert.doesNotMatch(finishSubmissionCanceled, /remains in your Drive/);
  assert.match(finishSubmissionCanceled, /showCanceledResult\(/);
});

test("pre-start create-new-file submission failures do not expose target links", async () => {
  const source = await loadSidebarSource();
  const showSubmissionError = extractFunction(source, "showSubmissionError");

  assert.doesNotMatch(source, /function showCreateNewFileSubmissionFailure/);
  assert.doesNotMatch(source, /The new presentation was created, but the translation job was not started/);
  assert.doesNotMatch(source, /You can open the created presentation below/);
  assert.doesNotMatch(showSubmissionError, /buildPresentationUrl|target_document_id|showResult/);
  assert.match(showSubmissionError, /showError\(message\)/);
});

test("duplicate cancel clears pre-start submission messaging", async () => {
  const source = await loadSidebarSource();
  const handleDuplicateCancel = extractFunction(source, "handleDuplicateCancel");

  assert.match(handleDuplicateCancel, /hideDuplicateAction\(\)/);
  assert.match(handleDuplicateCancel, /clearError\(\)/);
  assert.match(handleDuplicateCancel, /hideResult\(\)/);
});

test("idempotent replay shows only duplicate action, not a second error banner", async () => {
  const source = await loadSidebarSource();
  const submitJob = extractFunctionBody(source, "submitJob", "parseQuotaPartialError");
  const replayBranchMatch = /msg\.indexOf\('\[IDEMPOTENT_REPLAY\]'\)[\s\S]*?\} else \{/.exec(submitJob);
  assert.ok(replayBranchMatch, "IDEMPOTENT_REPLAY branch not found");
  const replayBranch = replayBranchMatch[0];

  assert.match(replayBranch, /showDuplicateAction\(/);
  assert.doesNotMatch(replayBranch, /showSubmissionError\(/);
  assert.doesNotMatch(replayBranch, /showError\(/);
});

test("duplicate action clears generic error and result state before rendering", async () => {
  const source = await loadSidebarSource();
  const showDuplicateAction = extractFunction(source, "showDuplicateAction");

  assert.match(showDuplicateAction, /clearError\(\)/);
  assert.match(showDuplicateAction, /hideResult\(\)/);
  assert.match(showDuplicateAction, /duplicateAction'\)\.classList\.add\('visible'\)/);
});

test("terminal output links require counted quota", async () => {
  const source = await loadSidebarSource();
  const pollJob = extractFunction(source, "pollJob");

  assert.match(source, /function hasCountedQuota\(resultMeta\)/);
  assert.match(source, /function getCountedQuotaUnits\(resultMeta\)/);
  assert.match(pollJob, /hasCountedQuota\(resp\) \? resolveOutputDocumentUrl\(resp\) : null/);
});
