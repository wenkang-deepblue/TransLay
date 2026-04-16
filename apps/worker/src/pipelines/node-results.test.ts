import test from "node:test";
import assert from "node:assert/strict";
import type { SlideExtractionResult, SlideTextNode } from "../adapters/slides";
import {
  countFailedBodyNodes,
  countSuccessfulBodyNodes,
  countWrittenBodyNodes,
  initializeJobNodeResults,
  listJobNodeResults,
  listNodeIdsForSlide,
  markNodeMaterializationFailed,
  markNodeMaterializationSucceeded,
  markNodeTranslationFailed,
  markNodeTranslationSucceeded,
  markNodeWriteFailed,
  markNodeWriteSucceeded,
} from "./node-results";

function createNode(overrides: {
  node_id: string;
  slide_index: number;
  element_type: SlideTextNode["element_type"];
}): SlideTextNode {
  return {
    node_id: overrides.node_id,
    text: overrides.node_id,
    full_text: overrides.node_id,
    slide_index: overrides.slide_index,
    element_type: overrides.element_type,
    archetype: overrides.element_type === "speaker_notes" ? "speaker_notes" : "plain_text",
    object_id: `${overrides.node_id}_object`,
    box: {
      width_emu: 100,
      height_emu: 40,
      translate_x_emu: 0,
      translate_y_emu: 0,
      rotation_deg: 0,
    },
    paragraphs: [],
  };
}

function createSlide(
  slide_index: number,
  slide_object_id: string,
  nodes: SlideTextNode[]
): SlideExtractionResult {
  return {
    slide_index,
    slide_object_id,
    slide_fingerprint: `fp_${slide_index}`,
    nodes,
  };
}

test("initializeJobNodeResults seeds body and notes nodes with expected pending states", () => {
  const bodyNode = createNode({
    node_id: "body_1",
    slide_index: 3,
    element_type: "shape",
  });
  const notesNode = createNode({
    node_id: "notes_1",
    slide_index: 3,
    element_type: "speaker_notes",
  });

  const results = initializeJobNodeResults([
    createSlide(3, "slide_3", [bodyNode, notesNode]),
  ]);
  const ordered = listJobNodeResults(results);

  assert.deepEqual(ordered, [
    {
      node_id: "body_1",
      slide_index: 3,
      source_slide_object_id: "slide_3",
      source_slide_fingerprint: "fp_3",
      node_kind: "body",
      translation_status: "pending",
      materialization_status: "pending",
      write_status: "pending",
      output_visible: false,
    },
    {
      node_id: "notes_1",
      slide_index: 3,
      source_slide_object_id: "slide_3",
      source_slide_fingerprint: "fp_3",
      node_kind: "notes",
      translation_status: "pending",
      materialization_status: "skipped",
      write_status: "pending",
      output_visible: false,
    },
  ]);
});

test("node result transitions mark downstream stages skipped on translation and materialization failure", () => {
  const bodyNode = createNode({
    node_id: "body_fail",
    slide_index: 5,
    element_type: "shape",
  });
  const results = initializeJobNodeResults([
    createSlide(5, "slide_5", [bodyNode]),
  ]);

  markNodeTranslationFailed(results, "body_fail", "LLM_PROVIDER_ERROR");
  assert.deepEqual(listJobNodeResults(results)[0], {
    node_id: "body_fail",
    slide_index: 5,
    source_slide_object_id: "slide_5",
    source_slide_fingerprint: "fp_5",
    node_kind: "body",
    translation_status: "failed",
    materialization_status: "skipped",
    write_status: "skipped",
    output_visible: false,
    failure_reason_code: "LLM_PROVIDER_ERROR",
  });

  const secondResults = initializeJobNodeResults([
    createSlide(5, "slide_5", [bodyNode]),
  ]);
  markNodeTranslationSucceeded(secondResults, "body_fail");
  markNodeMaterializationFailed(secondResults, "body_fail", "PARSE_ERROR");
  assert.deepEqual(listJobNodeResults(secondResults)[0], {
    node_id: "body_fail",
    slide_index: 5,
    source_slide_object_id: "slide_5",
    source_slide_fingerprint: "fp_5",
    node_kind: "body",
    translation_status: "succeeded",
    materialization_status: "failed",
    write_status: "skipped",
    output_visible: false,
    failure_reason_code: "PARSE_ERROR",
  });
});

test("node result counters and node lists reflect visible successes and failures per slide", () => {
  const bodySuccess = createNode({
    node_id: "body_success",
    slide_index: 7,
    element_type: "shape",
  });
  const bodyFailure = createNode({
    node_id: "body_failure",
    slide_index: 7,
    element_type: "shape",
  });
  const notesFailure = createNode({
    node_id: "notes_failure",
    slide_index: 7,
    element_type: "speaker_notes",
  });

  const results = initializeJobNodeResults([
    createSlide(7, "slide_7", [bodySuccess, bodyFailure, notesFailure]),
  ]);

  markNodeTranslationSucceeded(results, "body_success");
  markNodeMaterializationSucceeded(results, "body_success");
  markNodeWriteSucceeded(results, "body_success");

  markNodeTranslationSucceeded(results, "body_failure");
  markNodeMaterializationSucceeded(results, "body_failure");
  markNodeWriteFailed(results, "body_failure", "HOST_ADAPTER_ERROR");

  markNodeTranslationFailed(results, "notes_failure", "LLM_PROVIDER_ERROR");

  assert.equal(countSuccessfulBodyNodes(results, 7), 2);
  assert.equal(countWrittenBodyNodes(results, 7), 1);
  assert.equal(countFailedBodyNodes(results, 7), 1);
  assert.deepEqual(listNodeIdsForSlide(results, 7, "body"), [
    "body_failure",
    "body_success",
  ]);
  assert.deepEqual(listNodeIdsForSlide(results, 7, "notes"), ["notes_failure"]);
});
