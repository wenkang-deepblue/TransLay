import test from "node:test";
import assert from "node:assert/strict";
import type { AuthorityTranslationNode } from "@translay/shared-contracts";
import type { SlideExtractionResult, SlideTextNode } from "../adapters/slides";
import {
  auditAuthorityCoverage,
  buildMaterializationGroups,
  mergeAuthorityNodes,
} from "./authority";

function createNode(
  overrides: Partial<SlideTextNode> &
    Pick<
      SlideTextNode,
      "node_id" | "text" | "full_text" | "slide_index" | "element_type" | "archetype" | "object_id"
    >
): SlideTextNode {
  return {
    node_id: overrides.node_id,
    text: overrides.text,
    full_text: overrides.full_text,
    slide_index: overrides.slide_index,
    element_type: overrides.element_type,
    archetype: overrides.archetype,
    object_id: overrides.object_id,
    box: overrides.box ?? {
      width_emu: 100,
      height_emu: 50,
      translate_x_emu: 10,
      translate_y_emu: 20,
      rotation_deg: 0,
    },
    paragraphs: overrides.paragraphs ?? [
      {
        paragraph_id: "p0",
        text: overrides.full_text,
        start_index: 0,
        end_index: overrides.full_text.length,
        paragraph_style: {},
        runs: [
          {
            run_id: "r0",
            text: overrides.full_text,
            start_index: 0,
            end_index: overrides.full_text.length,
            style_role: "default",
            text_style: {},
          },
        ],
      },
    ],
    row_index: overrides.row_index,
    col_index: overrides.col_index,
  };
}

test("auditAuthorityCoverage marks missing and empty authority nodes as gaps", () => {
  const sourceNodes = [
    createNode({
      node_id: "n1",
      text: "Presentation overview",
      full_text: "Presentation overview",
      slide_index: 1,
      element_type: "shape",
      archetype: "plain_text",
      object_id: "shape_1",
    }),
    createNode({
      node_id: "n2",
      text: "ARR",
      full_text: "ARR",
      slide_index: 1,
      element_type: "shape",
      archetype: "metric_card",
      object_id: "shape_2",
    }),
    createNode({
      node_id: "n3",
      text: "Speaker note",
      full_text: "Speaker note",
      slide_index: 2,
      element_type: "speaker_notes",
      archetype: "speaker_notes",
      object_id: "notes_1",
    }),
  ];
  const authorityNodes: AuthorityTranslationNode[] = [
    {
      node_id: "n1",
      slide_index: 1,
      translated_full_text: "演示概览",
    },
    {
      node_id: "n2",
      slide_index: 1,
      translated_full_text: "",
    },
  ];

  const audit = auditAuthorityCoverage(sourceNodes, authorityNodes);
  assert.deepEqual(
    audit.authority_nodes.map((node) => node.node_id),
    ["n1"]
  );
  assert.deepEqual(
    audit.missing_nodes.map((node) => node.node_id),
    ["n2", "n3"]
  );
});

test("mergeAuthorityNodes prefers supplement values and keeps slide order", () => {
  const merged = mergeAuthorityNodes(
    [
      {
        node_id: "n2",
        slide_index: 2,
        translated_full_text: "旧值",
      },
      {
        node_id: "n1",
        slide_index: 1,
        translated_full_text: "第一页",
      },
    ],
    [
      {
        node_id: "n2",
        slide_index: 2,
        translated_full_text: "新值",
      },
    ]
  );

  assert.deepEqual(
    merged.map((node) => [node.slide_index, node.node_id, node.translated_full_text]),
    [
      [1, "n1", "第一页"],
      [2, "n2", "新值"],
    ]
  );
});

test("buildMaterializationGroups groups nodes per slide and respects small limits", () => {
  const slide1: SlideExtractionResult = {
    slide_index: 1,
    slide_object_id: "slide_1",
    nodes: [
      createNode({
        node_id: "s1-n1",
        text: "A".repeat(20),
        full_text: "A".repeat(20),
        slide_index: 1,
        element_type: "shape",
        archetype: "plain_text",
        object_id: "shape_1",
      }),
      createNode({
        node_id: "s1-n2",
        text: "B".repeat(20),
        full_text: "B".repeat(20),
        slide_index: 1,
        element_type: "shape",
        archetype: "plain_text",
        object_id: "shape_2",
      }),
    ],
  };
  const slide2: SlideExtractionResult = {
    slide_index: 2,
    slide_object_id: "slide_2",
    nodes: [
      createNode({
        node_id: "s2-n1",
        text: "C".repeat(20),
        full_text: "C".repeat(20),
        slide_index: 2,
        element_type: "shape",
        archetype: "plain_text",
        object_id: "shape_3",
      }),
    ],
  };

  const groups = buildMaterializationGroups([slide1, slide2], {
    maxNodesPerGroup: 1,
    maxCharsPerGroup: 25,
  });

  assert.deepEqual(
    groups.map((group) => group.node_summaries.map((node) => node.node_id)),
    [["s1-n1"], ["s1-n2"], ["s2-n1"]]
  );
});
