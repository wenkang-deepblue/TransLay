import test from "node:test";
import assert from "node:assert/strict";
import type { DeckStoryboard } from "./storyboard";
import type { SlideExtractionResult, SlideTextNode } from "./types";
import {
  annotateSlidesWithLayoutSemanticsBestEffort,
  buildLayoutSemanticInputs,
  validateSlideLayoutHints,
} from "./layout-semantics";

function createNode(
  overrides: Partial<SlideTextNode> &
    Pick<
      SlideTextNode,
      | "node_id"
      | "text"
      | "full_text"
      | "slide_index"
      | "element_type"
      | "archetype"
      | "object_id"
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
      width_emu: 160 * 12700,
      height_emu: 40 * 12700,
      translate_x_emu: 0,
      translate_y_emu: 0,
      rotation_deg: 0,
    },
    paragraphs: overrides.paragraphs ?? [
      {
        paragraph_id: "p0",
        text: overrides.full_text,
        start_index: 0,
        end_index: overrides.full_text.length,
        paragraph_style: { alignment: "CENTER" },
        runs: [
          {
            run_id: "r0",
            text: overrides.full_text,
            start_index: 0,
            end_index: overrides.full_text.length,
            style_role: "default",
            text_style: {
              fontSize: { magnitude: 24, unit: "PT" },
              weightedFontFamily: { fontFamily: "Inter" },
            },
          },
        ],
      },
    ],
    visible_style: overrides.visible_style,
    layout_hint: overrides.layout_hint,
    row_index: overrides.row_index,
    col_index: overrides.col_index,
  };
}

function createStoryboard(): DeckStoryboard {
  return {
    frames: [
      {
        slide_index: 1,
        slide_object_id: "slide_1",
        mime_type: "image/png",
        base64_data: "ZmFrZQ==",
      },
    ],
  };
}

test("buildLayoutSemanticInputs projects visible slide nodes and skips speaker notes", () => {
  const slide: SlideExtractionResult = {
    slide_index: 1,
    slide_object_id: "slide_1",
    nodes: [
      createNode({
        node_id: "shape_1",
        text: "Key Takeaways",
        full_text: "Key Takeaways",
        slide_index: 1,
        element_type: "shape",
        archetype: "plain_text",
        object_id: "shape_1",
        visible_style: {
          alignment: "CENTER",
          font_family: "Inter",
          min_font_size_pt: 24,
          max_font_size_pt: 24,
          fill_color_hex: "#112233",
          outline_color_hex: "#445566",
        },
      }),
      createNode({
        node_id: "notes_1",
        text: "Speaker note",
        full_text: "Speaker note",
        slide_index: 1,
        element_type: "speaker_notes",
        archetype: "speaker_notes",
        object_id: "notes_1",
      }),
    ],
  };

  const inputs = buildLayoutSemanticInputs([slide], createStoryboard());

  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]?.nodes.length, 1);
  assert.equal(inputs[0]?.nodes[0]?.node_id, "shape_1");
  assert.equal(inputs[0]?.nodes[0]?.alignment, "CENTER");
  assert.equal(inputs[0]?.nodes[0]?.min_font_size_pt, 24);
  assert.equal(inputs[0]?.nodes[0]?.max_font_size_pt, 24);
  assert.equal(inputs[0]?.nodes[0]?.fill_color_hex, "#112233");
  assert.equal(inputs[0]?.nodes[0]?.outline_color_hex, "#445566");
  assert.equal(inputs[0]?.thumbnail.slide_index, 1);
});

test("validateSlideLayoutHints keeps valid node ids and normalizes invalid fields to fallback defaults", () => {
  const slide: SlideExtractionResult = {
    slide_index: 1,
    slide_object_id: "slide_1",
    nodes: [
      createNode({
        node_id: "shape_1",
        text: "Agenda",
        full_text: "Agenda",
        slide_index: 1,
        element_type: "shape",
        archetype: "plain_text",
        object_id: "shape_1",
      }),
      createNode({
        node_id: "shape_2",
        text: "Next Steps",
        full_text: "Next Steps",
        slide_index: 1,
        element_type: "shape",
        archetype: "plain_text",
        object_id: "shape_2",
      }),
    ],
  };

  const [input] = buildLayoutSemanticInputs([slide], createStoryboard());
  assert.ok(input);

  const validated = validateSlideLayoutHints(input, [
    {
      node_id: "shape_1",
      visual_role: "title",
      cluster_id: "cluster_title",
      line_policy: "prefer_single_line",
      scale_sync: "sync_with_group",
      confidence: 0.94,
    },
    {
      node_id: "shape_2",
      visual_role: "not_real",
      cluster_id: "",
      line_policy: "not_real",
      scale_sync: "not_real",
      confidence: "high",
    },
    {
      node_id: "shape_missing",
      visual_role: "body",
      cluster_id: "cluster_body",
      line_policy: "allow_wrap",
      scale_sync: "independent",
      confidence: 0.8,
    },
  ]);

  assert.deepEqual(validated, [
    {
      node_id: "shape_1",
      visual_role: "title",
      cluster_id: "cluster_title",
      line_policy: "prefer_single_line",
      scale_sync: "sync_with_group",
      confidence: 0.94,
    },
    {
      node_id: "shape_2",
      visual_role: "unknown",
      cluster_id: "shape_2",
      line_policy: "allow_wrap",
      scale_sync: "independent",
      confidence: 0,
    },
  ]);
});

test("annotateSlidesWithLayoutSemanticsBestEffort applies per-node fallback hints when analysis fails", async () => {
  const slides: SlideExtractionResult[] = [
    {
      slide_index: 1,
      slide_object_id: "slide_1",
      nodes: [
        createNode({
          node_id: "shape_1",
          text: "Agenda",
          full_text: "Agenda",
          slide_index: 1,
          element_type: "shape",
          archetype: "plain_text",
          object_id: "shape_1",
        }),
        createNode({
          node_id: "shape_2",
          text: "Step 1",
          full_text: "Step 1",
          slide_index: 1,
          element_type: "shape",
          archetype: "plain_text",
          object_id: "shape_2",
        }),
        createNode({
          node_id: "notes_1",
          text: "Narration",
          full_text: "Narration",
          slide_index: 1,
          element_type: "speaker_notes",
          archetype: "speaker_notes",
          object_id: "notes_1",
        }),
      ],
    },
  ];

  const annotated = await annotateSlidesWithLayoutSemanticsBestEffort(
    slides,
    createStoryboard(),
    async () => {
      throw new Error("layout provider unavailable");
    }
  );

  const visibleNodes = annotated[0]?.nodes.filter((node) => node.element_type !== "speaker_notes");
  assert.deepEqual(
    visibleNodes?.map((node) => node.layout_hint),
    [
      {
        node_id: "shape_1",
        visual_role: "unknown",
        cluster_id: "shape_1",
        line_policy: "allow_wrap",
        scale_sync: "independent",
        confidence: 0,
      },
      {
        node_id: "shape_2",
        visual_role: "unknown",
        cluster_id: "shape_2",
        line_policy: "allow_wrap",
        scale_sync: "independent",
        confidence: 0,
      },
    ]
  );
  assert.equal(
    annotated[0]?.nodes.find((node) => node.element_type === "speaker_notes")?.layout_hint,
    undefined
  );
});
