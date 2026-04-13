import test from "node:test";
import assert from "node:assert/strict";
import type { slides_v1 } from "googleapis";
import type { TranslatedNode } from "@translay/shared-contracts";
import type { SlideTextNode } from "./types";
import {
  __buildNodeWarningsForTests,
  __buildNodeWriteRequestsForTests,
} from "./writer";

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
      width_emu: 100,
      height_emu: 40,
      translate_x_emu: 0,
      translate_y_emu: 0,
      rotation_deg: 0,
    },
    paragraphs: overrides.paragraphs ?? [],
    visible_style: overrides.visible_style,
    layout_hint: overrides.layout_hint,
    layout_hint_source: overrides.layout_hint_source,
    row_index: overrides.row_index,
    col_index: overrides.col_index,
  };
}

test("writer rebuilds mixed emphasis with paragraph and segment ranges instead of flattening one style over the whole node", () => {
  const sourceNode = createNode({
    node_id: "shape_1",
    text: "Revenue grew",
    full_text: "Revenue grew",
    slide_index: 1,
    element_type: "shape",
    archetype: "mixed_emphasis",
    object_id: "shape_1",
    paragraphs: [
      {
        paragraph_id: "p0",
        text: "Revenue grew",
        start_index: 0,
        end_index: 12,
        paragraph_style: {
          alignment: "CENTER",
        },
        runs: [
          {
            run_id: "r0",
            text: "Revenue",
            start_index: 0,
            end_index: 7,
            style_role: "default",
            text_style: {
              fontFamily: "Inter",
              fontSize: { magnitude: 18, unit: "PT" },
            },
          },
          {
            run_id: "r1",
            text: " grew",
            start_index: 7,
            end_index: 12,
            style_role: "emphasis",
            text_style: {
              bold: true,
              fontFamily: "Inter",
              fontSize: { magnitude: 18, unit: "PT" },
            },
          },
        ],
      },
    ],
  });

  const translatedNode: TranslatedNode = {
    node_id: "shape_1",
    translated_full_text: "Ingresos crecieron",
    paragraphs: [
      {
        paragraph_id: "p0",
        translated_text: "Ingresos crecieron",
        bullet_behavior: "none",
      },
    ],
    segments: [
      {
        segment_id: "r0",
        translated_text: "Ingresos",
        style_role: "default",
      },
      {
        segment_id: "r1",
        translated_text: " crecieron",
        style_role: "emphasis",
      },
    ],
  };

  const requests = __buildNodeWriteRequestsForTests({
    sourceNode,
    translatedNode,
    objectId: "shape_1_copy",
  });

  assert.deepEqual(
    requests.map((request) => Object.keys(request)[0]),
    [
      "deleteText",
      "insertText",
      "updateParagraphStyle",
      "updateTextStyle",
      "updateTextStyle",
    ]
  );

  assert.equal(requests[1]?.insertText?.text, "Ingresos crecieron");
  assert.deepEqual(requests[2]?.updateParagraphStyle?.textRange, {
    type: "FIXED_RANGE",
    startIndex: 0,
    endIndex: "Ingresos crecieron".length,
  });
  assert.deepEqual(requests[3]?.updateTextStyle?.textRange, {
    type: "FIXED_RANGE",
    startIndex: 0,
    endIndex: "Ingresos".length,
  });
  assert.deepEqual(requests[4]?.updateTextStyle?.textRange, {
    type: "FIXED_RANGE",
    startIndex: "Ingresos".length,
    endIndex: "Ingresos crecieron".length,
  });
  assert.equal(requests[3]?.updateTextStyle?.style?.bold, undefined);
  assert.equal(requests[4]?.updateTextStyle?.style?.bold, true);
}
);

test("writer rebuilds bullet paragraphs with preserved nesting and no trailing empty bullet paragraph", () => {
  const sourceNode = createNode({
    node_id: "shape_bullet",
    text: "Top level\nNested detail",
    full_text: "Top level\nNested detail",
    slide_index: 2,
    element_type: "shape",
    archetype: "bullet_list",
    object_id: "shape_bullet",
    paragraphs: [
      {
        paragraph_id: "p0",
        text: "Top level",
        start_index: 0,
        end_index: 9,
        bullet: { nesting_level: 0 },
        paragraph_style: { spacingMode: "NEVER_COLLAPSE" },
        runs: [
          {
            run_id: "r0",
            text: "Top level",
            start_index: 0,
            end_index: 9,
            style_role: "default",
            text_style: { fontSize: { magnitude: 20, unit: "PT" } },
          },
        ],
      },
      {
        paragraph_id: "p1",
        text: "Nested detail",
        start_index: 10,
        end_index: 23,
        bullet: { nesting_level: 1 },
        paragraph_style: { spacingMode: "NEVER_COLLAPSE" },
        runs: [
          {
            run_id: "r1",
            text: "Nested detail",
            start_index: 10,
            end_index: 23,
            style_role: "default",
            text_style: { italic: true },
          },
        ],
      },
    ],
  });

  const translatedNode: TranslatedNode = {
    node_id: "shape_bullet",
    translated_full_text: "Primer punto\nDetalle",
    paragraphs: [
      {
        paragraph_id: "p0",
        translated_text: "Primer punto",
        bullet_behavior: "preserve",
      },
      {
        paragraph_id: "p1",
        translated_text: "Detalle",
        bullet_behavior: "preserve",
      },
    ],
    segments: [
      {
        segment_id: "r0",
        translated_text: "Primer punto",
        style_role: "default",
      },
      {
        segment_id: "r1",
        translated_text: "Detalle",
        style_role: "default",
      },
    ],
  };

  const requests = __buildNodeWriteRequestsForTests({
    sourceNode,
    translatedNode,
    objectId: "shape_bullet_copy",
  });

  assert.equal(requests[1]?.insertText?.text, "Primer punto\n\tDetalle");
  assert.equal(requests[1]?.insertText?.text?.endsWith("\n"), false);
  assert.deepEqual(requests[2]?.createParagraphBullets?.textRange, {
    type: "FIXED_RANGE",
    startIndex: 0,
    endIndex: "Primer punto\n\tDetalle".length,
  });
  assert.deepEqual(requests[3]?.updateParagraphStyle?.textRange, {
    type: "FIXED_RANGE",
    startIndex: 0,
    endIndex: "Primer punto".length,
  });
  assert.deepEqual(requests[4]?.updateParagraphStyle?.textRange, {
    type: "FIXED_RANGE",
    startIndex: "Primer punto\n\t".length,
    endIndex: "Primer punto\n\tDetalle".length,
  });
  assert.deepEqual(requests[5]?.updateTextStyle?.textRange, {
    type: "FIXED_RANGE",
    startIndex: 0,
    endIndex: "Primer punto".length,
  });
  assert.deepEqual(requests[6]?.updateTextStyle?.textRange, {
    type: "FIXED_RANGE",
    startIndex: "Primer punto\n\t".length,
    endIndex: "Primer punto\n\tDetalle".length,
  });
}
);

test("writer rebuilds multi-paragraph plain text with paragraph-local ranges across newlines", () => {
  const sourceNode = createNode({
    node_id: "shape_multi",
    text: "Headline\nDetails",
    full_text: "Headline\nDetails",
    slide_index: 2,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "shape_multi",
    paragraphs: [
      {
        paragraph_id: "p0",
        text: "Headline",
        start_index: 0,
        end_index: 8,
        paragraph_style: { alignment: "CENTER" },
        runs: [
          {
            run_id: "r0",
            text: "Headline",
            start_index: 0,
            end_index: 8,
            style_role: "default",
            text_style: { bold: true },
          },
        ],
      },
      {
        paragraph_id: "p1",
        text: "Details",
        start_index: 9,
        end_index: 16,
        paragraph_style: { alignment: "START" },
        runs: [
          {
            run_id: "r1",
            text: "Details",
            start_index: 9,
            end_index: 16,
            style_role: "default",
            text_style: { italic: true },
          },
        ],
      },
    ],
  });

  const translatedNode: TranslatedNode = {
    node_id: "shape_multi",
    translated_full_text: "Titular\nDetalles",
    paragraphs: [
      {
        paragraph_id: "p0",
        translated_text: "Titular",
        bullet_behavior: "none",
      },
      {
        paragraph_id: "p1",
        translated_text: "Detalles",
        bullet_behavior: "none",
      },
    ],
    segments: [
      {
        segment_id: "r0",
        translated_text: "Titular",
        style_role: "default",
      },
      {
        segment_id: "r1",
        translated_text: "Detalles",
        style_role: "default",
      },
    ],
  };

  const requests = __buildNodeWriteRequestsForTests({
    sourceNode,
    translatedNode,
    objectId: "shape_multi_copy",
  });

  assert.equal(requests[1]?.insertText?.text, "Titular\nDetalles");
  assert.deepEqual(requests[2]?.updateParagraphStyle?.textRange, {
    type: "FIXED_RANGE",
    startIndex: 0,
    endIndex: "Titular".length,
  });
  assert.deepEqual(requests[3]?.updateParagraphStyle?.textRange, {
    type: "FIXED_RANGE",
    startIndex: "Titular\n".length,
    endIndex: "Titular\nDetalles".length,
  });
  assert.deepEqual(requests[4]?.updateTextStyle?.textRange, {
    type: "FIXED_RANGE",
    startIndex: 0,
    endIndex: "Titular".length,
  });
  assert.deepEqual(requests[5]?.updateTextStyle?.textRange, {
    type: "FIXED_RANGE",
    startIndex: "Titular\n".length,
    endIndex: "Titular\nDetalles".length,
  });
});

test("writer rebuilds speaker notes with the same rich-text request structure", () => {
  const sourceNode = createNode({
    node_id: "notes_1",
    text: "Talk track",
    full_text: "Talk track",
    slide_index: 4,
    element_type: "speaker_notes",
    archetype: "speaker_notes",
    object_id: "notes_body_1",
    paragraphs: [
      {
        paragraph_id: "p0",
        text: "Talk track",
        start_index: 0,
        end_index: 10,
        paragraph_style: {},
        runs: [
          {
            run_id: "r0",
            text: "Talk",
            start_index: 0,
            end_index: 4,
            style_role: "default",
            text_style: { bold: true },
          },
          {
            run_id: "r1",
            text: " track",
            start_index: 4,
            end_index: 10,
            style_role: "emphasis",
            text_style: { italic: true },
          },
        ],
      },
    ],
  });

  const translatedNode: TranslatedNode = {
    node_id: "notes_1",
    translated_full_text: "Guion oral",
    paragraphs: [
      {
        paragraph_id: "p0",
        translated_text: "Guion oral",
        bullet_behavior: "none",
      },
    ],
    segments: [
      {
        segment_id: "r0",
        translated_text: "Guion",
        style_role: "default",
      },
      {
        segment_id: "r1",
        translated_text: " oral",
        style_role: "emphasis",
      },
    ],
  };

  const requests = __buildNodeWriteRequestsForTests({
    sourceNode,
    translatedNode,
    objectId: "notes_body_copy",
  });

  assert.deepEqual(
    requests.map((request) => Object.keys(request)[0]),
    ["deleteText", "insertText", "updateTextStyle", "updateTextStyle"]
  );
  assert.equal(requests[1]?.insertText?.text, "Guion oral");
  assert.deepEqual(requests[2]?.updateTextStyle?.textRange, {
    type: "FIXED_RANGE",
    startIndex: 0,
    endIndex: "Guion".length,
  });
  assert.deepEqual(requests[3]?.updateTextStyle?.textRange, {
    type: "FIXED_RANGE",
    startIndex: "Guion".length,
    endIndex: "Guion oral".length,
  });
});

test("writer applies fit-pass scaling proportionally across style hierarchy and tightens paragraph spacing", () => {
  const sourceNode = createNode({
    node_id: "metric_fit",
    text: "$68B ARR",
    full_text: "$68B ARR",
    slide_index: 4,
    element_type: "shape",
    archetype: "metric_card",
    object_id: "metric_fit",
    box: {
      width_emu: 72 * 12700,
      height_emu: 26 * 12700,
      translate_x_emu: 0,
      translate_y_emu: 0,
      rotation_deg: 0,
    },
    paragraphs: [
      {
        paragraph_id: "p0",
        text: "$68B ARR",
        start_index: 0,
        end_index: 8,
        paragraph_style: {
          lineSpacing: 115,
          spaceAbove: { magnitude: 8, unit: "PT" },
          spaceBelow: { magnitude: 6, unit: "PT" },
        },
        runs: [
          {
            run_id: "r0",
            text: "$68B",
            start_index: 0,
            end_index: 4,
            style_role: "metric_value",
            text_style: {
              fontSize: { magnitude: 28, unit: "PT" },
              bold: true,
            },
          },
          {
            run_id: "r1",
            text: " ARR",
            start_index: 4,
            end_index: 8,
            style_role: "metric_unit",
            text_style: {
              fontSize: { magnitude: 14, unit: "PT" },
            },
          },
        ],
      },
    ],
  });

  const translatedNode: TranslatedNode = {
    node_id: "metric_fit",
    translated_full_text: "68 mil millones de dolares ARR",
    paragraphs: [
      {
        paragraph_id: "p0",
        translated_text: "68 mil millones de dolares ARR",
        bullet_behavior: "none",
      },
    ],
    segments: [
      {
        segment_id: "r0",
        translated_text: "68 mil millones",
        style_role: "metric_value",
      },
      {
        segment_id: "r1",
        translated_text: " de dolares ARR",
        style_role: "metric_unit",
      },
    ],
  };

  const requests = __buildNodeWriteRequestsForTests({
    sourceNode,
    translatedNode,
    objectId: "metric_fit_copy",
  });

  const paragraphStyleRequest = requests.find((request) => request.updateParagraphStyle);
  const textStyleRequests = requests.filter((request) => request.updateTextStyle);

  assert.ok(paragraphStyleRequest?.updateParagraphStyle);
  assert.equal(
    paragraphStyleRequest?.updateParagraphStyle?.style?.lineSpacing !== undefined,
    true
  );
  assert.ok((paragraphStyleRequest?.updateParagraphStyle?.style?.lineSpacing ?? 0) < 115);
  assert.ok(
    (paragraphStyleRequest?.updateParagraphStyle?.style?.spaceAbove?.magnitude ?? 0) < 8
  );
  assert.ok(
    (paragraphStyleRequest?.updateParagraphStyle?.style?.spaceBelow?.magnitude ?? 0) < 6
  );
  assert.equal(textStyleRequests.length, 2);
  assert.ok(
    (textStyleRequests[0]?.updateTextStyle?.style?.fontSize?.magnitude ?? 0) < 28
  );
  assert.ok(
    (textStyleRequests[1]?.updateTextStyle?.style?.fontSize?.magnitude ?? 0) < 14
  );
  assert.equal(
    (textStyleRequests[0]?.updateTextStyle?.style?.fontSize?.magnitude ?? 0) /
      (textStyleRequests[1]?.updateTextStyle?.style?.fontSize?.magnitude ?? 1),
    2
  );
});

test("writer injects explicit font size when shrinking inherited-theme text runs", () => {
  const sourceNode = createNode({
    node_id: "theme_inherited_body",
    text: "Platform overview",
    full_text: "Platform overview",
    slide_index: 4,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "theme_inherited_body",
    box: {
      width_emu: 92 * 12700,
      height_emu: 24 * 12700,
      translate_x_emu: 0,
      translate_y_emu: 0,
      rotation_deg: 0,
    },
    visible_style: {
      alignment: "START",
      font_family: "Arial",
      min_font_size_pt: 22,
      max_font_size_pt: 22,
    },
    paragraphs: [
      {
        paragraph_id: "p0",
        text: "Platform overview",
        start_index: 0,
        end_index: 17,
        paragraph_style: {},
        runs: [
          {
            run_id: "r0",
            text: "Platform overview",
            start_index: 0,
            end_index: 17,
            style_role: "default",
            text_style: {
              weightedFontFamily: { fontFamily: "Arial" },
            },
          },
        ],
      },
    ],
  });

  const translatedNode: TranslatedNode = {
    node_id: "theme_inherited_body",
    translated_full_text: "Plattformubersicht fur unternehmensweite Daten- und KI-Workloads",
    paragraphs: [
      {
        paragraph_id: "p0",
        translated_text: "Plattformubersicht fur unternehmensweite Daten- und KI-Workloads",
        bullet_behavior: "none",
      },
    ],
    segments: [
      {
        segment_id: "r0",
        translated_text: "Plattformubersicht fur unternehmensweite Daten- und KI-Workloads",
        style_role: "default",
      },
    ],
  };

  const requests = __buildNodeWriteRequestsForTests({
    sourceNode,
    translatedNode,
    objectId: "theme_inherited_body_copy",
  });
  const textStyleRequest = requests.find((request) => request.updateTextStyle);

  assert.ok(textStyleRequest?.updateTextStyle);
  assert.equal(
    typeof textStyleRequest?.updateTextStyle?.style?.fontSize?.magnitude,
    "number"
  );
  assert.ok((textStyleRequest?.updateTextStyle?.style?.fontSize?.magnitude ?? 0) < 22);
  assert.equal(textStyleRequest?.updateTextStyle?.style?.fontSize?.unit, "PT");
});

test("writer handles empty translated nodes by issuing only deleteText", () => {
  const sourceNode = createNode({
    node_id: "shape_empty",
    text: "",
    full_text: "",
    slide_index: 5,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "shape_empty",
    paragraphs: [],
  });

  const translatedNode: TranslatedNode = {
    node_id: "shape_empty",
    translated_full_text: "",
    paragraphs: [],
    segments: [],
  };

  const requests = __buildNodeWriteRequestsForTests({
    sourceNode,
    translatedNode,
    objectId: "shape_empty_copy",
  });

  assert.equal(requests.length, 1);
  assert.ok(requests[0]?.deleteText);
});

test("writer keeps table cell location on every rich-text rebuild request", () => {
  const sourceNode = createNode({
    node_id: "cell_1_2",
    text: "$68B ARR",
    full_text: "$68B ARR",
    slide_index: 3,
    element_type: "table_cell",
    archetype: "table_cell",
    object_id: "table_1",
    row_index: 1,
    col_index: 2,
    paragraphs: [
      {
        paragraph_id: "p0",
        text: "$68B ARR",
        start_index: 0,
        end_index: 8,
        paragraph_style: {},
        runs: [
          {
            run_id: "r0",
            text: "$68B",
            start_index: 0,
            end_index: 4,
            style_role: "metric_value",
            text_style: { bold: true },
          },
          {
            run_id: "r1",
            text: " ARR",
            start_index: 4,
            end_index: 8,
            style_role: "metric_unit",
            text_style: {},
          },
        ],
      },
    ],
  });
  const translatedNode: TranslatedNode = {
    node_id: "cell_1_2",
    translated_full_text: "68 亿美元 ARR",
    paragraphs: [
      {
        paragraph_id: "p0",
        translated_text: "68 亿美元 ARR",
        bullet_behavior: "none",
      },
    ],
    segments: [
      {
        segment_id: "r0",
        translated_text: "68 亿美元",
        style_role: "metric_value",
      },
      {
        segment_id: "r1",
        translated_text: " ARR",
        style_role: "metric_unit",
      },
    ],
  };
  const cellLocation: slides_v1.Schema$TableCellLocation = {
    rowIndex: 1,
    columnIndex: 2,
  };

  const requests = __buildNodeWriteRequestsForTests({
    sourceNode,
    translatedNode,
    objectId: "table_1_copy",
    cellLocation,
  });

  for (const request of requests) {
    const value = Object.values(request)[0] as { cellLocation?: slides_v1.Schema$TableCellLocation };
    assert.deepEqual(value.cellLocation, cellLocation);
  }
});

test("writer skips zero-length text style ranges for empty translated segments", () => {
  const sourceNode = createNode({
    node_id: "metric_prefix_drop",
    text: "$ 68B",
    full_text: "$ 68B",
    slide_index: 4,
    element_type: "shape",
    archetype: "metric_card",
    object_id: "metric_prefix_drop",
    paragraphs: [
      {
        paragraph_id: "p0",
        text: "$ 68B",
        start_index: 0,
        end_index: 5,
        paragraph_style: {},
        runs: [
          {
            run_id: "r0",
            text: "$ ",
            start_index: 0,
            end_index: 2,
            style_role: "prefix",
            text_style: {
              bold: true,
              fontSize: { magnitude: 18, unit: "PT" },
            },
          },
          {
            run_id: "r1",
            text: "68B",
            start_index: 2,
            end_index: 5,
            style_role: "metric_value",
            text_style: {
              bold: true,
              fontSize: { magnitude: 48, unit: "PT" },
            },
          },
        ],
      },
    ],
  });

  const translatedNode: TranslatedNode = {
    node_id: "metric_prefix_drop",
    translated_full_text: "680亿美元",
    paragraphs: [
      {
        paragraph_id: "p0",
        translated_text: "680亿美元",
        bullet_behavior: "none",
      },
    ],
    segments: [
      {
        segment_id: "r0",
        translated_text: "",
        style_role: "prefix",
      },
      {
        segment_id: "r1",
        translated_text: "680亿美元",
        style_role: "metric_value",
      },
    ],
  };

  const requests = __buildNodeWriteRequestsForTests({
    sourceNode,
    translatedNode,
    objectId: "metric_prefix_drop_copy",
  });
  const textStyleRequests = requests.filter((request) => request.updateTextStyle);

  assert.equal(textStyleRequests.length, 1);
  assert.deepEqual(textStyleRequests[0]?.updateTextStyle?.textRange, {
    type: "FIXED_RANGE",
    startIndex: 0,
    endIndex: "680亿美元".length,
  });
});

test("writer emits structured warning metadata without leaking source or translated text", () => {
  const sourceNode = createNode({
    node_id: "metric_warning",
    text: "$68B ARR",
    full_text: "$68B ARR",
    slide_index: 6,
    element_type: "shape",
    archetype: "metric_card",
    object_id: "metric_warning",
    box: {
      width_emu: 44 * 12700,
      height_emu: 16 * 12700,
      translate_x_emu: 0,
      translate_y_emu: 0,
      rotation_deg: 0,
    },
    paragraphs: [
      {
        paragraph_id: "p0",
        text: "$68B ARR",
        start_index: 0,
        end_index: 8,
        paragraph_style: {
          lineSpacing: 112,
        },
        runs: [
          {
            run_id: "r0",
            text: "$68B",
            start_index: 0,
            end_index: 4,
            style_role: "metric_value",
            text_style: {
              fontSize: { magnitude: 28, unit: "PT" },
              bold: true,
            },
          },
          {
            run_id: "r1",
            text: " ARR",
            start_index: 4,
            end_index: 8,
            style_role: "metric_unit",
            text_style: {
              fontSize: { magnitude: 14, unit: "PT" },
            },
          },
        ],
      },
    ],
  });

  const translatedNode: TranslatedNode = {
    node_id: "metric_warning",
    translated_full_text: "68 mil millones de dolares en ingresos recurrentes anuales",
    paragraphs: [
      {
        paragraph_id: "p0",
        translated_text: "68 mil millones de dolares en ingresos recurrentes anuales",
        bullet_behavior: "none",
      },
    ],
    segments: [
      {
        segment_id: "r0",
        translated_text: "68 mil millones",
        style_role: "metric_value",
      },
      {
        segment_id: "r1",
        translated_text: " de dolares en ingresos recurrentes anuales",
        style_role: "metric_unit",
      },
    ],
    risk_flags: ["mixed_style_alignment_low_confidence"],
  };

  const warnings = __buildNodeWarningsForTests({
    sourceNode,
    translatedNode,
    objectId: "metric_warning_copy",
  });

  assert.deepEqual(warnings, [
    {
      node_id: "metric_warning",
      slide_index: 6,
      archetype: "metric_card",
      risk_level: "high",
      risk_reason: "manual_review_recommended",
    },
    {
      node_id: "metric_warning",
      slide_index: 6,
      archetype: "metric_card",
      risk_level: "high",
      risk_reason: "possible_overflow",
    },
    {
      node_id: "metric_warning",
      slide_index: 6,
      archetype: "metric_card",
      risk_level: "high",
      risk_reason: "layout_semantics_fallback_applied",
    },
    {
      node_id: "metric_warning",
      slide_index: 6,
      archetype: "metric_card",
      risk_level: "high",
      risk_reason: "mixed_style_alignment_low_confidence",
    },
  ]);

  const serializedWarnings = JSON.stringify(warnings);
  assert.equal(serializedWarnings.includes(sourceNode.full_text), false);
  assert.equal(serializedWarnings.includes(translatedNode.translated_full_text), false);
});

test("writer emits layout semantics fallback warning when a node has no layout hint", () => {
  const sourceNode = createNode({
    node_id: "fallback_warning",
    text: "Pipeline overview",
    full_text: "Pipeline overview",
    slide_index: 7,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "fallback_warning",
    box: {
      width_emu: 160 * 12700,
      height_emu: 40 * 12700,
      translate_x_emu: 0,
      translate_y_emu: 0,
      rotation_deg: 0,
    },
    paragraphs: [
      {
        paragraph_id: "p0",
        text: "Pipeline overview",
        start_index: 0,
        end_index: 17,
        paragraph_style: {},
        runs: [
          {
            run_id: "r0",
            text: "Pipeline overview",
            start_index: 0,
            end_index: 17,
            style_role: "default",
            text_style: {
              fontSize: { magnitude: 20, unit: "PT" },
            },
          },
        ],
      },
    ],
  });
  const translatedNode: TranslatedNode = {
    node_id: "fallback_warning",
    translated_full_text: "Resumen del pipeline",
    paragraphs: [
      {
        paragraph_id: "p0",
        translated_text: "Resumen del pipeline",
        bullet_behavior: "none",
      },
    ],
    segments: [
      {
        segment_id: "r0",
        translated_text: "Resumen del pipeline",
        style_role: "default",
      },
    ],
  };

  const warnings = __buildNodeWarningsForTests({
    sourceNode,
    translatedNode,
    objectId: "fallback_warning_copy",
  });

  assert.deepEqual(warnings, [
    {
      node_id: "fallback_warning",
      slide_index: 7,
      archetype: "plain_text",
      risk_level: "medium",
      risk_reason: "layout_semantics_fallback_applied",
    },
  ]);
});

test("writer does not emit fallback warning when the model explicitly returns default-valued hints", () => {
  const sourceNode = createNode({
    node_id: "default_hint_from_model",
    text: "Pipeline overview",
    full_text: "Pipeline overview",
    slide_index: 7,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "default_hint_from_model",
    box: {
      width_emu: 160 * 12700,
      height_emu: 40 * 12700,
      translate_x_emu: 0,
      translate_y_emu: 0,
      rotation_deg: 0,
    },
    paragraphs: [
      {
        paragraph_id: "p0",
        text: "Pipeline overview",
        start_index: 0,
        end_index: 17,
        paragraph_style: {},
        runs: [
          {
            run_id: "r0",
            text: "Pipeline overview",
            start_index: 0,
            end_index: 17,
            style_role: "default",
            text_style: {
              fontSize: { magnitude: 20, unit: "PT" },
            },
          },
        ],
      },
    ],
    layout_hint: {
      node_id: "default_hint_from_model",
      visual_role: "unknown",
      cluster_id: "default_hint_from_model",
      line_policy: "allow_wrap",
      scale_sync: "independent",
      confidence: 0,
    },
    layout_hint_source: "model",
  });
  const translatedNode: TranslatedNode = {
    node_id: "default_hint_from_model",
    translated_full_text: "Resumen del pipeline",
    paragraphs: [
      {
        paragraph_id: "p0",
        translated_text: "Resumen del pipeline",
        bullet_behavior: "none",
      },
    ],
    segments: [
      {
        segment_id: "r0",
        translated_text: "Resumen del pipeline",
        style_role: "default",
      },
    ],
  };

  const warnings = __buildNodeWarningsForTests({
    sourceNode,
    translatedNode,
    objectId: "default_hint_from_model_copy",
  });

  assert.equal(
    warnings.some((warning) => warning.risk_reason === "layout_semantics_fallback_applied"),
    false
  );
});

test("writer emits single-line degradation warning when a preferred single-line title still cannot fit", () => {
  const sourceNode = createNode({
    node_id: "single_line_warning",
    text: "Executive summary",
    full_text: "Executive summary",
    slide_index: 8,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "single_line_warning",
    box: {
      width_emu: 68 * 12700,
      height_emu: 24 * 12700,
      translate_x_emu: 0,
      translate_y_emu: 0,
      rotation_deg: 0,
    },
    paragraphs: [
      {
        paragraph_id: "p0",
        text: "Executive summary",
        start_index: 0,
        end_index: 17,
        paragraph_style: {},
        runs: [
          {
            run_id: "r0",
            text: "Executive summary",
            start_index: 0,
            end_index: 17,
            style_role: "default",
            text_style: {
              fontSize: { magnitude: 28, unit: "PT" },
              bold: true,
            },
          },
        ],
      },
    ],
    layout_hint: {
      node_id: "single_line_warning",
      visual_role: "title",
      cluster_id: "single_line_warning",
      line_policy: "prefer_single_line",
      scale_sync: "independent",
      confidence: 0.94,
    },
  });
  const translatedNode: TranslatedNode = {
    node_id: "single_line_warning",
    translated_full_text: "Resumen ejecutivo trimestral completamente detallado",
    paragraphs: [
      {
        paragraph_id: "p0",
        translated_text: "Resumen ejecutivo trimestral completamente detallado",
        bullet_behavior: "none",
      },
    ],
    segments: [
      {
        segment_id: "r0",
        translated_text: "Resumen ejecutivo trimestral completamente detallado",
        style_role: "default",
      },
    ],
  };

  const warnings = __buildNodeWarningsForTests({
    sourceNode,
    translatedNode,
    objectId: "single_line_warning_copy",
  });

  assert.equal(
    warnings.some((warning) => warning.risk_reason === "single_line_policy_degraded"),
    true
  );
});
