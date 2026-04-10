import test from "node:test";
import assert from "node:assert/strict";
import type { SlideTextNode } from "../adapters/slides";
import {
  buildDeckContextPack,
  groupNodesForTranslation,
  projectGroupToTranslationNodes,
} from "./context-pack";

function createNode(overrides: Partial<SlideTextNode> & Pick<SlideTextNode, "node_id" | "text" | "full_text" | "slide_index" | "element_type" | "archetype" | "object_id">): SlideTextNode {
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

test("buildDeckContextPack includes deck context, glossary candidates, and active group summaries", () => {
  const bulletNode = createNode({
    node_id: "n1",
    text: "ARR grew 30%\nEnterprise expansion",
    full_text: "ARR grew 30%\nEnterprise expansion",
    slide_index: 1,
    element_type: "shape",
    archetype: "bullet_list",
    object_id: "shape_1",
    paragraphs: [
      {
        paragraph_id: "p0",
        text: "ARR grew 30%",
        start_index: 0,
        end_index: 13,
        bullet: { nesting_level: 0 },
        paragraph_style: {},
        runs: [
          {
            run_id: "r0",
            text: "ARR",
            start_index: 0,
            end_index: 3,
            style_role: "metric_value",
            text_style: { bold: true },
          },
          {
            run_id: "r1",
            text: " grew 30%",
            start_index: 3,
            end_index: 13,
            style_role: "default",
            text_style: {},
          },
        ],
      },
      {
        paragraph_id: "p1",
        text: "Enterprise expansion",
        start_index: 14,
        end_index: 34,
        bullet: { nesting_level: 0 },
        paragraph_style: {},
        runs: [
          {
            run_id: "r2",
            text: "Enterprise expansion",
            start_index: 14,
            end_index: 34,
            style_role: "emphasis",
            text_style: { italic: true },
          },
        ],
      },
    ],
  });

  const metricNode = createNode({
    node_id: "n2",
    text: "$68B ARR",
    full_text: "$68B ARR",
    slide_index: 1,
    element_type: "shape",
    archetype: "metric_card",
    object_id: "shape_2",
  });

  const plainNode = createNode({
    node_id: "n3",
    text: "ARR retention remains strong across enterprise accounts.",
    full_text: "ARR retention remains strong across enterprise accounts.",
    slide_index: 2,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "shape_3",
  });

  const groups = groupNodesForTranslation([bulletNode, metricNode, plainNode], {
    maxNodesPerGroup: 2,
  });

  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups[0]?.map((node) => node.node_id),
    ["n1", "n2"]
  );
  assert.deepEqual(
    projectGroupToTranslationNodes(groups[0] ?? []).map((node) => node.node_id),
    ["n1", "n2"]
  );

  const contextPack = buildDeckContextPack({
    deckTitle: "FY26 Board Review",
    sourceLanguage: "auto",
    targetLanguage: "fr",
    deckPlaintextContext:
      "[Slide 1] ARR grew 30% | Enterprise expansion\n[Slide 2] ARR retention remains strong across enterprise accounts.",
    deckNodes: [bulletNode, metricNode, plainNode],
    activeGroup: groups[0] ?? [],
  });

  assert.equal(contextPack.deck_title, "FY26 Board Review");
  assert.equal(contextPack.source_language, "auto");
  assert.equal(contextPack.target_language, "fr");
  assert.match(contextPack.deck_plaintext_context, /ARR grew 30%/);
  assert.equal(contextPack.nodes.length, 2);
  assert.deepEqual(
    contextPack.nodes.map((node) => node.node_id),
    ["n1", "n2"]
  );
  assert.equal(contextPack.nodes[0]?.archetype, "bullet_list");
  assert.equal(contextPack.nodes[0]?.paragraphs[0]?.bullet?.nesting_level, 0);
  assert.deepEqual(
    contextPack.nodes[0]?.paragraphs[0]?.style_roles,
    ["metric_value", "default"]
  );
  assert.deepEqual(
    contextPack.nodes[0]?.paragraphs[0]?.segments,
    [
      {
        segment_id: "r0",
        text: "ARR",
        style_role: "metric_value",
      },
      {
        segment_id: "r1",
        text: " grew 30%",
        style_role: "default",
      },
    ]
  );
  assert.ok(
    contextPack.glossary_candidates.some(
      (candidate) => candidate.source_term === "ARR" && candidate.occurrences >= 3
    )
  );
});

test("groupNodesForTranslation returns empty groups for empty input", () => {
  assert.deepEqual(groupNodesForTranslation([]), []);
});

test("groupNodesForTranslation keeps same container together and isolates speaker notes", () => {
  const bodyA1 = createNode({
    node_id: "body-a-1",
    text: "Revenue overview",
    full_text: "Revenue overview",
    slide_index: 1,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "shape_a",
  });
  const bodyA2 = createNode({
    node_id: "body-a-2",
    text: "Revenue detail",
    full_text: "Revenue detail",
    slide_index: 1,
    element_type: "shape",
    archetype: "mixed_emphasis",
    object_id: "shape_a",
  });
  const note1 = createNode({
    node_id: "note-1",
    text: "Say this verbally",
    full_text: "Say this verbally",
    slide_index: 1,
    element_type: "speaker_notes",
    archetype: "speaker_notes",
    object_id: "notes_1",
  });
  const bodyB = createNode({
    node_id: "body-b",
    text: "Customer growth",
    full_text: "Customer growth",
    slide_index: 2,
    element_type: "shape",
    archetype: "metric_card",
    object_id: "shape_b",
  });

  const groups = groupNodesForTranslation([bodyA1, bodyA2, note1, bodyB], {
    maxNodesPerGroup: 1,
    maxCharsPerGroup: 10,
  });

  assert.equal(groups.length, 3);
  assert.deepEqual(
    groups[0]?.map((node) => node.node_id),
    ["body-a-1", "body-a-2"]
  );
  assert.deepEqual(
    groups[1]?.map((node) => node.node_id),
    ["body-b"]
  );
  assert.deepEqual(
    groups[2]?.map((node) => node.node_id),
    ["note-1"]
  );
  assert.ok(groups[0]?.every((node) => node.element_type !== "speaker_notes"));
  assert.ok(groups[2]?.every((node) => node.element_type === "speaker_notes"));
});

test("buildDeckContextPack returns empty glossary when no terms repeat", () => {
  const node = createNode({
    node_id: "solo",
    text: "Unique topic only",
    full_text: "Unique topic only",
    slide_index: 1,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "shape_unique",
  });

  const contextPack = buildDeckContextPack({
    deckTitle: "One-off",
    sourceLanguage: "auto",
    targetLanguage: "de",
    deckPlaintextContext: "[Slide 1] Unique topic only",
    deckNodes: [node],
    activeGroup: [node],
  });

  assert.deepEqual(contextPack.glossary_candidates, []);
});

test("buildDeckContextPack extracts repeated CJK glossary candidates", () => {
  const node1 = createNode({
    node_id: "cjk-1",
    text: "ARR（年经常性收入）增长稳定",
    full_text: "ARR（年经常性收入）增长稳定",
    slide_index: 1,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "shape_cjk_1",
  });
  const node2 = createNode({
    node_id: "cjk-2",
    text: "提升年经常性收入与留存率",
    full_text: "提升年经常性收入与留存率",
    slide_index: 2,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "shape_cjk_2",
  });

  const contextPack = buildDeckContextPack({
    deckTitle: "CJK deck",
    sourceLanguage: "zh-Hans",
    targetLanguage: "en",
    deckPlaintextContext:
      "[Slide 1] ARR（年经常性收入）增长稳定\n[Slide 2] 提升年经常性收入与留存率",
    deckNodes: [node1, node2],
    activeGroup: [node1],
  });

  assert.ok(
    contextPack.glossary_candidates.some(
      (candidate) =>
        candidate.source_term === "年经常性收入" && candidate.occurrences >= 2
    )
  );
});
