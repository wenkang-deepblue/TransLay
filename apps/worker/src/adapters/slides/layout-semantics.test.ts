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

test("validateSlideLayoutHints keeps valid node ids and drops low-confidence hints", () => {
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
  assert.deepEqual(
    visibleNodes?.map((node) => node.layout_hint_source),
    ["fallback", "fallback"]
  );
});

test("annotateSlidesWithLayoutSemanticsBestEffort falls back when model returns low-confidence hints", async () => {
  const slides: SlideExtractionResult[] = [
    {
      slide_index: 2,
      slide_object_id: "slide_2",
      nodes: [
        createNode({
          node_id: "shape_3",
          text: "Highlights",
          full_text: "Highlights",
          slide_index: 2,
          element_type: "shape",
          archetype: "plain_text",
          object_id: "shape_3",
        }),
      ],
    },
  ];

  const annotated = await annotateSlidesWithLayoutSemanticsBestEffort(
    slides,
    createStoryboard(),
    async () => [
      {
        node_id: "shape_3",
        visual_role: "title",
        cluster_id: "hero",
        line_policy: "prefer_single_line",
        scale_sync: "sync_with_group",
        confidence: 0.42,
      },
    ]
  );

  assert.deepEqual(annotated[0]?.nodes[0]?.layout_hint, {
    node_id: "shape_3",
    visual_role: "unknown",
    cluster_id: "shape_3",
    line_policy: "allow_wrap",
    scale_sync: "independent",
    confidence: 0,
  });
  assert.equal(annotated[0]?.nodes[0]?.layout_hint_source, "fallback");
});

test("annotateSlidesWithLayoutSemanticsBestEffort applies rule-based fallback for obvious title and body nodes", async () => {
  const slides: SlideExtractionResult[] = [
    {
      slide_index: 3,
      slide_object_id: "slide_3",
      nodes: [
        createNode({
          node_id: "shape_title",
          text: "The Enterprise Data Challenges in AI Era",
          full_text: "The Enterprise Data Challenges in AI Era",
          slide_index: 3,
          element_type: "shape",
          archetype: "plain_text",
          object_id: "shape_title",
          box: {
            width_emu: 420 * 12700,
            height_emu: 42 * 12700,
            translate_x_emu: 24 * 12700,
            translate_y_emu: 18 * 12700,
            rotation_deg: 0,
          },
          visible_style: {
            alignment: "START",
            font_family: "Arial",
            min_font_size_pt: 28,
            max_font_size_pt: 28,
          },
        }),
        createNode({
          node_id: "shape_body",
          text: "Enterprise data silos\nMulti-cloud lacks data freedom",
          full_text: "Enterprise data silos\nMulti-cloud lacks data freedom",
          slide_index: 3,
          element_type: "shape",
          archetype: "bullet_list",
          object_id: "shape_body",
          box: {
            width_emu: 280 * 12700,
            height_emu: 180 * 12700,
            translate_x_emu: 36 * 12700,
            translate_y_emu: 92 * 12700,
            rotation_deg: 0,
          },
          visible_style: {
            alignment: "START",
            font_family: "Arial",
            min_font_size_pt: 20,
            max_font_size_pt: 20,
          },
          paragraphs: [
            {
              paragraph_id: "p0",
              text: "Enterprise data silos",
              start_index: 0,
              end_index: 22,
              bullet: { nesting_level: 0 },
              paragraph_style: { alignment: "START" },
              runs: [
                {
                  run_id: "r0",
                  text: "Enterprise data silos",
                  start_index: 0,
                  end_index: 22,
                  style_role: "default",
                  text_style: {
                    fontSize: { magnitude: 20, unit: "PT" },
                    weightedFontFamily: { fontFamily: "Arial" },
                  },
                },
              ],
            },
            {
              paragraph_id: "p1",
              text: "Multi-cloud lacks data freedom",
              start_index: 23,
              end_index: 54,
              bullet: { nesting_level: 0 },
              paragraph_style: { alignment: "START" },
              runs: [
                {
                  run_id: "r1",
                  text: "Multi-cloud lacks data freedom",
                  start_index: 23,
                  end_index: 54,
                  style_role: "default",
                  text_style: {
                    fontSize: { magnitude: 20, unit: "PT" },
                    weightedFontFamily: { fontFamily: "Arial" },
                  },
                },
              ],
            },
          ],
        }),
      ],
    },
  ];

  const storyboard: DeckStoryboard = {
    frames: [
      {
        slide_index: 3,
        slide_object_id: "slide_3",
        mime_type: "image/png",
        base64_data: "ZmFrZQ==",
      },
    ],
  };

  const annotated = await annotateSlidesWithLayoutSemanticsBestEffort(
    slides,
    storyboard,
    async () => []
  );

  assert.deepEqual(annotated[0]?.nodes[0]?.layout_hint, {
    node_id: "shape_title",
    visual_role: "title",
    cluster_id: "shape_title",
    line_policy: "prefer_single_line",
    scale_sync: "independent",
    confidence: 0,
  });
  assert.deepEqual(annotated[0]?.nodes[1]?.layout_hint, {
    node_id: "shape_body",
    visual_role: "body",
    cluster_id: "shape_body",
    line_policy: "allow_wrap",
    scale_sync: "independent",
    confidence: 0,
  });
  assert.deepEqual(
    annotated[0]?.nodes.map((node) => node.layout_hint_source),
    ["fallback", "fallback"]
  );
});

test("buildRuleBasedFallbackHints assigns prefer_single_line for short single-paragraph text that fits in one line", async () => {
  const slides: SlideExtractionResult[] = [
    {
      slide_index: 5,
      slide_object_id: "slide_5",
      nodes: [
        createNode({
          node_id: "title_node",
          text: "OCI Core Value – Unlock AI on Private Data",
          full_text: "OCI Core Value – Unlock AI on Private Data",
          slide_index: 5,
          element_type: "shape",
          archetype: "plain_text",
          object_id: "title_obj",
          box: {
            width_emu: 590 * 12700,
            height_emu: 34 * 12700,
            translate_x_emu: 0,
            translate_y_emu: 10000,
            rotation_deg: 0,
          },
          visible_style: {
            max_font_size_pt: 28,
            min_font_size_pt: 28,
          },
        }),
        createNode({
          node_id: "subtitle_node",
          text: "Gain Oracle Database capabilities without migrating clouds",
          full_text: "Gain Oracle Database capabilities without migrating clouds",
          slide_index: 5,
          element_type: "shape",
          archetype: "plain_text",
          object_id: "subtitle_obj",
          box: {
            width_emu: 638 * 12700,
            height_emu: 60 * 12700,
            translate_x_emu: 0,
            translate_y_emu: 80000,
            rotation_deg: 0,
          },
          visible_style: {
            max_font_size_pt: 15,
            min_font_size_pt: 15,
          },
        }),
        createNode({
          node_id: "banner_node",
          text: "Zero Data Movement. Compatible with All Formats.",
          full_text: "Zero Data Movement. Compatible with All Formats.",
          slide_index: 5,
          element_type: "shape",
          archetype: "plain_text",
          object_id: "banner_obj",
          box: {
            width_emu: 520 * 12700,
            height_emu: 34 * 12700,
            translate_x_emu: 0,
            translate_y_emu: 4000000,
            rotation_deg: 0,
          },
          visible_style: {
            max_font_size_pt: 12,
            min_font_size_pt: 12,
          },
        }),
      ],
    },
  ];

  const storyboard: DeckStoryboard = {
    frames: [
      {
        slide_index: 5,
        slide_object_id: "slide_5",
        mime_type: "image/png",
        base64_data: "ZmFrZQ==",
      },
    ],
  };

  const annotated = await annotateSlidesWithLayoutSemanticsBestEffort(
    slides,
    storyboard,
    async () => []
  );

  const titleHint = annotated[0]?.nodes[0]?.layout_hint;
  assert.equal(titleHint?.line_policy, "prefer_single_line");
  assert.equal(titleHint?.visual_role, "title");

  const subtitleHint = annotated[0]?.nodes[1]?.layout_hint;
  assert.equal(subtitleHint?.line_policy, "prefer_single_line");

  const bannerHint = annotated[0]?.nodes[2]?.layout_hint;
  assert.equal(bannerHint?.line_policy, "prefer_single_line");
  assert.equal(bannerHint?.visual_role, "caption");
});

test("model hint allow_wrap is upgraded to prefer_single_line when source text fits on one line", async () => {
  const slides: SlideExtractionResult[] = [
    {
      slide_index: 6,
      slide_object_id: "slide_6",
      nodes: [
        createNode({
          node_id: "model_title",
          text: "Go-to-market strategy",
          full_text: "Go-to-market strategy",
          slide_index: 6,
          element_type: "shape",
          archetype: "plain_text",
          object_id: "model_title",
          box: {
            width_emu: 520 * 12700,
            height_emu: 38 * 12700,
            translate_x_emu: 0,
            translate_y_emu: 10000,
            rotation_deg: 0,
          },
          visible_style: {
            max_font_size_pt: 28,
            min_font_size_pt: 28,
          },
        }),
      ],
    },
  ];

  const storyboard: DeckStoryboard = {
    frames: [
      {
        slide_index: 6,
        slide_object_id: "slide_6",
        mime_type: "image/png",
        base64_data: "ZmFrZQ==",
      },
    ],
  };

  const annotated = await annotateSlidesWithLayoutSemanticsBestEffort(
    slides,
    storyboard,
    async () => [
      {
        node_id: "model_title",
        visual_role: "body",
        cluster_id: "llm_cluster",
        line_policy: "allow_wrap",
        scale_sync: "sync_with_group",
        confidence: 0.97,
      },
    ]
  );

  assert.deepEqual(annotated[0]?.nodes[0]?.layout_hint, {
    node_id: "model_title",
    visual_role: "body",
    cluster_id: "llm_cluster",
    line_policy: "prefer_single_line",
    scale_sync: "sync_with_group",
    confidence: 0.97,
  });
  assert.equal(annotated[0]?.nodes[0]?.layout_hint_source, "model");
});

test("model hint allow_wrap is preserved for multi-paragraph body text", async () => {
  const slides: SlideExtractionResult[] = [
    {
      slide_index: 7,
      slide_object_id: "slide_7",
      nodes: [
        createNode({
          node_id: "body_long",
          text: "This is a long body text that spans multiple paragraphs and should wrap",
          full_text: "This is a long body text that spans multiple paragraphs and should wrap",
          slide_index: 7,
          element_type: "shape",
          archetype: "plain_text",
          object_id: "body_long",
          paragraphs: [
            {
              paragraph_id: "p0",
              text: "This is a long body text",
              start_index: 0,
              end_index: 24,
              paragraph_style: { alignment: "START" },
              runs: [{ run_id: "r0", text: "This is a long body text", start_index: 0, end_index: 24, style_role: "default" as const, text_style: { fontSize: { magnitude: 14, unit: "PT" as const } } }],
            },
            {
              paragraph_id: "p1",
              text: "that spans multiple paragraphs and should wrap",
              start_index: 25,
              end_index: 71,
              paragraph_style: { alignment: "START" },
              runs: [{ run_id: "r1", text: "that spans multiple paragraphs and should wrap", start_index: 25, end_index: 71, style_role: "default" as const, text_style: { fontSize: { magnitude: 14, unit: "PT" as const } } }],
            },
          ],
          box: {
            width_emu: 300 * 12700,
            height_emu: 100 * 12700,
            translate_x_emu: 0,
            translate_y_emu: 10000,
            rotation_deg: 0,
          },
          visible_style: {
            max_font_size_pt: 14,
            min_font_size_pt: 14,
          },
        }),
      ],
    },
  ];

  const storyboard: DeckStoryboard = {
    frames: [
      {
        slide_index: 7,
        slide_object_id: "slide_7",
        mime_type: "image/png",
        base64_data: "ZmFrZQ==",
      },
    ],
  };

  const annotated = await annotateSlidesWithLayoutSemanticsBestEffort(
    slides,
    storyboard,
    async () => [
      {
        node_id: "body_long",
        visual_role: "body",
        cluster_id: "body_cluster",
        line_policy: "allow_wrap",
        scale_sync: "independent",
        confidence: 0.95,
      },
    ]
  );

  assert.deepEqual(annotated[0]?.nodes[0]?.layout_hint, {
    node_id: "body_long",
    visual_role: "body",
    cluster_id: "body_cluster",
    line_policy: "allow_wrap",
    scale_sync: "independent",
    confidence: 0.95,
  });
  assert.equal(annotated[0]?.nodes[0]?.layout_hint_source, "model");
});

test("high-confidence geometric sync groups override fragmented model clusters for repeated short labels", async () => {
  const slides: SlideExtractionResult[] = [
    {
      slide_index: 8,
      slide_object_id: "slide_8",
      nodes: [
        createNode({
          node_id: "agenda_1",
          text: "Agenda",
          full_text: "Agenda",
          slide_index: 8,
          element_type: "shape",
          archetype: "plain_text",
          object_id: "agenda_1",
          box: {
            width_emu: 180 * 12700,
            height_emu: 32 * 12700,
            translate_x_emu: 10 * 12700,
            translate_y_emu: 20 * 12700,
            rotation_deg: 0,
          },
          visible_style: {
            max_font_size_pt: 20,
            min_font_size_pt: 20,
          },
        }),
        createNode({
          node_id: "agenda_2",
          text: "Next steps",
          full_text: "Next steps",
          slide_index: 8,
          element_type: "shape",
          archetype: "plain_text",
          object_id: "agenda_2",
          box: {
            width_emu: 180 * 12700,
            height_emu: 32 * 12700,
            translate_x_emu: 10 * 12700,
            translate_y_emu: 60 * 12700,
            rotation_deg: 0,
          },
          visible_style: {
            max_font_size_pt: 20,
            min_font_size_pt: 20,
          },
        }),
      ],
    },
  ];

  const storyboard: DeckStoryboard = {
    frames: [
      {
        slide_index: 8,
        slide_object_id: "slide_8",
        mime_type: "image/png",
        base64_data: "ZmFrZQ==",
      },
    ],
  };

  const annotated = await annotateSlidesWithLayoutSemanticsBestEffort(
    slides,
    storyboard,
    async () => [
      {
        node_id: "agenda_1",
        visual_role: "agenda_item",
        cluster_id: "llm_agenda_a",
        line_policy: "prefer_single_line",
        scale_sync: "independent",
        confidence: 0.96,
      },
      {
        node_id: "agenda_2",
        visual_role: "agenda_item",
        cluster_id: "llm_agenda_b",
        line_policy: "prefer_single_line",
        scale_sync: "independent",
        confidence: 0.96,
      },
    ]
  );

  const firstHint = annotated[0]?.nodes[0]?.layout_hint;
  const secondHint = annotated[0]?.nodes[1]?.layout_hint;

  assert.ok(firstHint?.cluster_id.startsWith("geo_sync_"));
  assert.equal(firstHint?.cluster_id, secondHint?.cluster_id);
  assert.equal(firstHint?.scale_sync, "sync_with_group");
  assert.equal(secondHint?.scale_sync, "sync_with_group");
  assert.equal(annotated[0]?.nodes[0]?.layout_hint_source, "model");
  assert.equal(annotated[0]?.nodes[1]?.layout_hint_source, "model");
});

test("geometric sync override does not replace model clusters for incompatible visual roles", async () => {
  const slides: SlideExtractionResult[] = [
    {
      slide_index: 9,
      slide_object_id: "slide_9",
      nodes: [
        createNode({
          node_id: "title_like",
          text: "Overview",
          full_text: "Overview",
          slide_index: 9,
          element_type: "shape",
          archetype: "plain_text",
          object_id: "title_like",
          box: {
            width_emu: 180 * 12700,
            height_emu: 32 * 12700,
            translate_x_emu: 10 * 12700,
            translate_y_emu: 20 * 12700,
            rotation_deg: 0,
          },
          visible_style: {
            max_font_size_pt: 20,
            min_font_size_pt: 20,
          },
        }),
        createNode({
          node_id: "body_like",
          text: "Overview",
          full_text: "Overview",
          slide_index: 9,
          element_type: "shape",
          archetype: "plain_text",
          object_id: "body_like",
          box: {
            width_emu: 180 * 12700,
            height_emu: 32 * 12700,
            translate_x_emu: 10 * 12700,
            translate_y_emu: 60 * 12700,
            rotation_deg: 0,
          },
          visible_style: {
            max_font_size_pt: 20,
            min_font_size_pt: 20,
          },
        }),
      ],
    },
  ];

  const storyboard: DeckStoryboard = {
    frames: [
      {
        slide_index: 9,
        slide_object_id: "slide_9",
        mime_type: "image/png",
        base64_data: "ZmFrZQ==",
      },
    ],
  };

  const annotated = await annotateSlidesWithLayoutSemanticsBestEffort(
    slides,
    storyboard,
    async () => [
      {
        node_id: "title_like",
        visual_role: "title",
        cluster_id: "llm_title_cluster",
        line_policy: "prefer_single_line",
        scale_sync: "independent",
        confidence: 0.96,
      },
      {
        node_id: "body_like",
        visual_role: "body",
        cluster_id: "llm_body_cluster",
        line_policy: "allow_wrap",
        scale_sync: "independent",
        confidence: 0.96,
      },
    ]
  );

  assert.equal(annotated[0]?.nodes[0]?.layout_hint?.cluster_id, "llm_title_cluster");
  assert.equal(annotated[0]?.nodes[1]?.layout_hint?.cluster_id, "llm_body_cluster");
  assert.equal(annotated[0]?.nodes[0]?.layout_hint?.scale_sync, "independent");
  assert.equal(annotated[0]?.nodes[1]?.layout_hint?.scale_sync, "independent");
});

test("fallback marks wide banner labels as prefer_single_line even near the threshold", async () => {
  const slides: SlideExtractionResult[] = [
    {
      slide_index: 10,
      slide_object_id: "slide_10",
      nodes: [
        createNode({
          node_id: "banner_like",
          text: "Can AI span all underlying databases to deliver complete business insights?",
          full_text: "Can AI span all underlying databases to deliver complete business insights?",
          slide_index: 10,
          element_type: "shape",
          archetype: "plain_text",
          object_id: "banner_like",
          box: {
            width_emu: 544.13 * 12700,
            height_emu: 30.66 * 12700,
            translate_x_emu: 0,
            translate_y_emu: 200 * 12700,
            rotation_deg: 0,
          },
          visible_style: {
            max_font_size_pt: 14,
            min_font_size_pt: 14,
          },
        }),
      ],
    },
  ];

  const storyboard: DeckStoryboard = {
    frames: [
      {
        slide_index: 10,
        slide_object_id: "slide_10",
        mime_type: "image/png",
        base64_data: "ZmFrZQ==",
      },
    ],
  };

  const annotated = await annotateSlidesWithLayoutSemanticsBestEffort(
    slides,
    storyboard,
    async () => []
  );

  assert.equal(annotated[0]?.nodes[0]?.layout_hint?.line_policy, "prefer_single_line");
  assert.equal(annotated[0]?.nodes[0]?.layout_hint?.visual_role, "caption");
});

test("model fixed_multiline is corrected to prefer_single_line for obvious single-line labels", async () => {
  const slides: SlideExtractionResult[] = [
    {
      slide_index: 11,
      slide_object_id: "slide_11",
      nodes: [
        createNode({
          node_id: "single_line_chip",
          text: "Key Takeaways",
          full_text: "Key Takeaways",
          slide_index: 11,
          element_type: "shape",
          archetype: "plain_text",
          object_id: "single_line_chip",
          box: {
            width_emu: 167.43 * 12700,
            height_emu: 34.77 * 12700,
            translate_x_emu: 0,
            translate_y_emu: 100 * 12700,
            rotation_deg: 0,
          },
          visible_style: {
            max_font_size_pt: 18,
            min_font_size_pt: 18,
          },
        }),
      ],
    },
  ];

  const storyboard: DeckStoryboard = {
    frames: [
      {
        slide_index: 11,
        slide_object_id: "slide_11",
        mime_type: "image/png",
        base64_data: "ZmFrZQ==",
      },
    ],
  };

  const annotated = await annotateSlidesWithLayoutSemanticsBestEffort(
    slides,
    storyboard,
    async () => [
      {
        node_id: "single_line_chip",
        visual_role: "caption",
        cluster_id: "chip_cluster",
        line_policy: "fixed_multiline",
        scale_sync: "independent",
        confidence: 0.96,
      },
    ]
  );

  assert.equal(annotated[0]?.nodes[0]?.layout_hint?.line_policy, "prefer_single_line");
  assert.equal(annotated[0]?.nodes[0]?.layout_hint_source, "model");
});
