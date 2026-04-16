import test from "node:test";
import assert from "node:assert/strict";
import type { slides_v1 } from "googleapis";
import type { TranslatedNode } from "@translay/shared-contracts";
import type { SlideTextNode } from "./types";
import {
  __buildNodeWarningsForTests,
  __buildNodeWriteRequestsForTests,
  __resetWriteRuntimeForTests,
  __setWriteRuntimeForTests,
  writeBackAppend,
  writeBackNewFile,
} from "./writer";
import {
  __resetSlidesClientForTests,
  __setSlidesClientForTests,
} from "./auth";

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

function createSingleParagraphNode(
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
  return createNode({
    ...overrides,
    paragraphs: overrides.paragraphs ?? [
      {
        paragraph_id: `${overrides.node_id}_p0`,
        text: overrides.full_text,
        start_index: 0,
        end_index: overrides.full_text.length,
        paragraph_style: {},
        runs: [
          {
            run_id: `${overrides.node_id}_r0`,
            text: overrides.full_text,
            start_index: 0,
            end_index: overrides.full_text.length,
            style_role: "default",
            text_style: {},
          },
        ],
      },
    ],
  });
}

function createValidTranslatedNode(node: SlideTextNode, translatedText: string): TranslatedNode {
  const paragraph = node.paragraphs[0];
  const run = paragraph?.runs[0];
  assert.ok(paragraph);
  assert.ok(run);

  return {
    node_id: node.node_id,
    translated_full_text: translatedText,
    paragraphs: [
      {
        paragraph_id: paragraph.paragraph_id,
        translated_text: translatedText,
        bullet_behavior: "none",
      },
    ],
    segments: [
      {
        segment_id: run.run_id,
        translated_text: translatedText,
        style_role: "default",
      },
    ],
  };
}

function createInvalidTranslatedNode(node: SlideTextNode, translatedText: string): TranslatedNode {
  const paragraph = node.paragraphs[0];
  assert.ok(paragraph);

  return {
    node_id: node.node_id,
    translated_full_text: translatedText,
    paragraphs: [
      {
        paragraph_id: paragraph.paragraph_id,
        translated_text: translatedText,
        bullet_behavior: "none",
      },
    ],
    segments: [],
  };
}

function createShapeSlide(
  slideObjectId: string,
  shapeObjectId: string
): slides_v1.Schema$Page {
  return {
    objectId: slideObjectId,
    pageElements: [
      {
        objectId: shapeObjectId,
        shape: {
          text: {
            textElements: [{ textRun: { content: "placeholder" } }],
          },
        },
      },
    ],
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

test("writer skips zero-length paragraph style ranges for accepted trailing empty paragraphs", () => {
  const sourceNode = createNode({
    node_id: "shape_trailing_empty_suffix",
    text: "App + API Protection",
    full_text: "App + API\nProtection",
    slide_index: 9,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "shape_trailing_empty_suffix",
    paragraphs: [
      {
        paragraph_id: "p0",
        text: "App + API",
        start_index: 0,
        end_index: 9,
        paragraph_style: {
          alignment: "CENTER",
        },
        runs: [
          {
            run_id: "p0_r0",
            text: "App + API",
            start_index: 0,
            end_index: 9,
            style_role: "default",
            text_style: {
              fontSize: { magnitude: 18, unit: "PT" },
            },
          },
        ],
      },
      {
        paragraph_id: "p1",
        text: "Protection",
        start_index: 10,
        end_index: 20,
        paragraph_style: {
          alignment: "CENTER",
        },
        runs: [
          {
            run_id: "p1_r0",
            text: "Protection",
            start_index: 10,
            end_index: 20,
            style_role: "default",
            text_style: {
              fontSize: { magnitude: 18, unit: "PT" },
            },
          },
        ],
      },
    ],
  });

  const translatedNode: TranslatedNode = {
    node_id: "shape_trailing_empty_suffix",
    translated_full_text: "APP + API-Schutz\n",
    paragraphs: [
      {
        paragraph_id: "p0",
        translated_text: "APP + API-Schutz",
        bullet_behavior: "none",
      },
      {
        paragraph_id: "p1",
        translated_text: "",
        bullet_behavior: "none",
      },
    ],
    segments: [
      {
        segment_id: "p0_r0",
        translated_text: "APP + API-Schutz",
        style_role: "default",
      },
      {
        segment_id: "p1_r0",
        translated_text: "",
        style_role: "default",
      },
    ],
  };

  const requests = __buildNodeWriteRequestsForTests({
    sourceNode,
    translatedNode,
    objectId: "shape_trailing_empty_suffix_copy",
  });
  const paragraphStyleRequests = requests.filter((request) => request.updateParagraphStyle);

  assert.equal(paragraphStyleRequests.length, 1);
  assert.deepEqual(paragraphStyleRequests[0]?.updateParagraphStyle?.textRange, {
    type: "FIXED_RANGE",
    startIndex: 0,
    endIndex: "APP + API-Schutz".length,
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
      risk_reason: "manual_review_recommended",
    },
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

test("writer emits trailing empty suffix acceptance warning from translated node risk flags", () => {
  const sourceNode = createNode({
    node_id: "tail_empty_warning",
    text: "Pipeline overview",
    full_text: "Pipeline overview",
    slide_index: 8,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "tail_empty_warning",
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
      node_id: "tail_empty_warning",
      visual_role: "unknown",
      cluster_id: "tail_empty_warning",
      line_policy: "allow_wrap",
      scale_sync: "independent",
      confidence: 0,
    },
    layout_hint_source: "model",
  });
  const translatedNode: TranslatedNode = {
    node_id: "tail_empty_warning",
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
    risk_flags: ["materialization_trailing_empty_suffix_accepted"],
  };

  const warnings = __buildNodeWarningsForTests({
    sourceNode,
    translatedNode,
    objectId: "tail_empty_warning_copy",
  });

  assert.equal(
    warnings.some(
      (warning) =>
        warning.node_id === "tail_empty_warning" &&
        warning.risk_reason === "materialization_trailing_empty_suffix_accepted"
    ),
    true
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

test("writeBackAppend cleans up failed duplicated slide and continues later slides", async () => {
  const failingNode = createSingleParagraphNode({
    node_id: "shape_fail",
    text: "Broken",
    full_text: "Broken",
    slide_index: 1,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "shape_fail",
  });
  const successfulNode = createSingleParagraphNode({
    node_id: "shape_ok",
    text: "Healthy",
    full_text: "Healthy",
    slide_index: 0,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "shape_ok",
  });

  const batchUpdateCalls: Array<slides_v1.Params$Resource$Presentations$Batchupdate> = [];
  __setSlidesClientForTests({
    auth: {} as never,
    slides: {
      presentations: {
        get: async () => ({
          data: {
            slides: [
              createShapeSlide("slide_0", "shape_ok"),
              createShapeSlide("slide_1", "shape_fail"),
            ],
          },
        }),
        batchUpdate: async (
          params: slides_v1.Params$Resource$Presentations$Batchupdate
        ) => {
          batchUpdateCalls.push(params);
          return { data: {} };
        },
      },
    } as never,
  });

  try {
    const result = await writeBackAppend(
      "presentation_123",
      [
        { slide_index: 0, slide_object_id: "slide_0", nodes: [successfulNode] },
        { slide_index: 1, slide_object_id: "slide_1", nodes: [failingNode] },
      ],
      [
        createInvalidTranslatedNode(failingNode, "Rotto"),
        createValidTranslatedNode(successfulNode, "Saludable"),
      ]
    );

    assert.equal(result.committedUnits, 1);
    assert.deepEqual(result.committed_slide_indexes, [0]);
    assert.deepEqual(result.failed_slide_indexes, [1]);
    assert.deepEqual(
      result.slide_results.map((item) => [item.slide_index, item.status]),
      [
        [1, "skipped_write_failed"],
        [0, "committed"],
      ]
    );
    assert.ok(
      batchUpdateCalls.some((call) =>
        (call.requestBody?.requests ?? []).some((request) => request.deleteObject)
      )
    );
  } finally {
    __resetSlidesClientForTests();
  }
});

test("writeBackAppend anchors duplication and insertion by source slide object id", async () => {
  const anchoredNode = createSingleParagraphNode({
    node_id: "shape_anchor",
    text: "Anchor",
    full_text: "Anchor",
    slide_index: 1,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "shape_anchor",
  });
  const batchUpdateCalls: slides_v1.Params$Resource$Presentations$Batchupdate[] = [];

  __setSlidesClientForTests({
    auth: {} as never,
    slides: {
      presentations: {
        get: async () => ({
          data: {
            slides: [
              createShapeSlide("source_0", "shape_0"),
              createShapeSlide("tl_existing_0", "shape_tl"),
              createShapeSlide("source_1", "shape_anchor"),
            ],
          },
        }),
        batchUpdate: async (
          params: slides_v1.Params$Resource$Presentations$Batchupdate
        ) => {
          batchUpdateCalls.push(params);
          return { data: {} };
        },
      },
    } as never,
  });

  try {
    const result = await writeBackAppend(
      "presentation_anchor",
      [
        {
          slide_index: 1,
          slide_object_id: "source_1",
          slide_fingerprint: "fingerprint_source_1",
          nodes: [anchoredNode],
        },
      ],
      [createValidTranslatedNode(anchoredNode, "Anclado")]
    );

    assert.equal(result.committedUnits, 1);
    const duplicateCall = batchUpdateCalls[0];
    assert.ok(duplicateCall);
    const requests = duplicateCall.requestBody?.requests ?? [];
    assert.equal(requests[0]?.duplicateObject?.objectId, "source_1");
    assert.equal(requests[1]?.updateSlidesPosition?.insertionIndex, 3);
  } finally {
    __resetSlidesClientForTests();
  }
});

test("writeBackNewFile keeps committed slides when one slide write fails", async () => {
  const firstNode = createSingleParagraphNode({
    node_id: "shape_first",
    text: "First",
    full_text: "First",
    slide_index: 0,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "shape_first",
  });
  const secondNode = createSingleParagraphNode({
    node_id: "shape_second",
    text: "Second",
    full_text: "Second",
    slide_index: 1,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "shape_second",
  });

  let replaceAttempt = 0;
  __setSlidesClientForTests({
    auth: {} as never,
    slides: {
      presentations: {
        get: async () => ({
          data: {
            slides: [
              createShapeSlide("slide_copy_0", "shape_first"),
              createShapeSlide("slide_copy_1", "shape_second"),
            ],
          },
        }),
        batchUpdate: async () => {
          replaceAttempt += 1;
          if (replaceAttempt === 1) {
            throw new Error("batchUpdate failed");
          }
          return { data: {} };
        },
      },
    } as never,
  });

  try {
    const result = await writeBackNewFile(
      "new_presentation_123",
      [
        { slide_index: 0, slide_object_id: "slide_copy_0", nodes: [firstNode] },
        { slide_index: 1, slide_object_id: "slide_copy_1", nodes: [secondNode] },
      ],
      [
        createValidTranslatedNode(firstNode, "Prima"),
        createValidTranslatedNode(secondNode, "Seconda"),
      ]
    );

    assert.equal(result.committedUnits, 1);
    assert.deepEqual(result.committed_slide_indexes, [1]);
    assert.deepEqual(result.failed_slide_indexes, [0]);
    assert.deepEqual(
      result.slide_results.map((item) => [item.slide_index, item.status]),
      [
        [0, "skipped_write_failed"],
        [1, "committed"],
      ]
    );
  } finally {
    __resetSlidesClientForTests();
  }
});

test("writeBackNewFile batches slide writes by default instead of issuing one API call per node", async () => {
  const firstNode = createSingleParagraphNode({
    node_id: "shape_batch_1",
    text: "First",
    full_text: "First",
    slide_index: 0,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "shape_batch_1",
  });
  const secondNode = createSingleParagraphNode({
    node_id: "shape_batch_2",
    text: "Second",
    full_text: "Second",
    slide_index: 0,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "shape_batch_2",
  });
  const batchUpdateCalls: Array<slides_v1.Params$Resource$Presentations$Batchupdate> = [];

  __setSlidesClientForTests({
    auth: {} as never,
    slides: {
      presentations: {
        get: async () => ({
          data: {
            slides: [
              {
                objectId: "slide_0",
                pageElements: [
                  { objectId: "shape_batch_1", shape: { text: { textElements: [] } } },
                  { objectId: "shape_batch_2", shape: { text: { textElements: [] } } },
                ],
              },
            ],
          },
        }),
        batchUpdate: async (
          params: slides_v1.Params$Resource$Presentations$Batchupdate
        ) => {
          batchUpdateCalls.push(params);
          return { data: {} };
        },
      },
    } as never,
  });

  try {
    const result = await writeBackNewFile(
      "presentation_batch",
      [{ slide_index: 0, slide_object_id: "slide_0", nodes: [firstNode, secondNode] }],
      [
        createValidTranslatedNode(firstNode, "Uno"),
        createValidTranslatedNode(secondNode, "Dos"),
      ]
    );

    assert.equal(result.committedUnits, 1);
    assert.equal(batchUpdateCalls.length, 1);
    assert.ok((batchUpdateCalls[0]?.requestBody?.requests?.length ?? 0) > 2);
  } finally {
    __resetSlidesClientForTests();
  }
});

test("writeBackNewFile retries rate-limited slide writes and enables slow mode for later requests", async () => {
  const firstNode = createSingleParagraphNode({
    node_id: "shape_rate_1",
    text: "First",
    full_text: "First",
    slide_index: 0,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "shape_rate_1",
  });
  const secondNode = createSingleParagraphNode({
    node_id: "shape_rate_2",
    text: "Second",
    full_text: "Second",
    slide_index: 1,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "shape_rate_2",
  });
  const sleepCalls: number[] = [];
  let batchUpdateCalls = 0;

  __setWriteRuntimeForTests({
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
    random: () => 0.5,
  });
  __setSlidesClientForTests({
    auth: {} as never,
    slides: {
      presentations: {
        get: async () => ({
          data: {
            slides: [
              createShapeSlide("slide_0", "shape_rate_1"),
              createShapeSlide("slide_1", "shape_rate_2"),
            ],
          },
        }),
        batchUpdate: async () => {
          batchUpdateCalls += 1;
          if (batchUpdateCalls <= 2) {
            throw Object.assign(
              new Error("Quota exceeded for quota metric 'Write requests'"),
              {
                response: {
                  status: 429,
                  data: {
                    error: {
                      status: "RESOURCE_EXHAUSTED",
                      errors: [{ reason: "rateLimitExceeded" }],
                    },
                  },
                },
              }
            );
          }
          return { data: {} };
        },
      },
    } as never,
  });

  try {
    const result = await writeBackNewFile(
      "presentation_rate",
      [
        { slide_index: 0, slide_object_id: "slide_0", nodes: [firstNode] },
        { slide_index: 1, slide_object_id: "slide_1", nodes: [secondNode] },
      ],
      [
        createValidTranslatedNode(firstNode, "Uno"),
        createValidTranslatedNode(secondNode, "Dos"),
      ]
    );

    assert.equal(result.committedUnits, 2);
    assert.equal(batchUpdateCalls, 4);
    assert.equal(sleepCalls.includes(500), true);
    assert.equal(sleepCalls.includes(1000), true);
    assert.equal(
      sleepCalls.some((ms) => ms >= 500 && ms <= 1000),
      true
    );
  } finally {
    __resetSlidesClientForTests();
    __resetWriteRuntimeForTests();
  }
});

test("writeBackNewFile disables slow mode after enough successful writes", async () => {
  const sleepCalls: number[] = [];
  let batchUpdateCalls = 0;
  const slides = Array.from({ length: 7 }, (_, slideIndex) => {
    const node = createSingleParagraphNode({
      node_id: `shape_recover_${slideIndex}`,
      text: `Node ${slideIndex}`,
      full_text: `Node ${slideIndex}`,
      slide_index: slideIndex,
      element_type: "shape",
      archetype: "plain_text",
      object_id: `shape_recover_${slideIndex}`,
    });
    return {
      extracted: {
        slide_index: slideIndex,
        slide_object_id: `slide_recover_${slideIndex}`,
        nodes: [node],
      },
      translated: createValidTranslatedNode(node, `Texto ${slideIndex}`),
    };
  });

  __setWriteRuntimeForTests({
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
    random: () => 0.5,
  });
  __setSlidesClientForTests({
    auth: {} as never,
    slides: {
      presentations: {
        get: async () => ({
          data: {
            slides: slides.map(({ extracted }) =>
              createShapeSlide(extracted.slide_object_id, extracted.nodes[0]!.object_id)
            ),
          },
        }),
        batchUpdate: async () => {
          batchUpdateCalls += 1;
          if (batchUpdateCalls <= 2) {
            throw Object.assign(new Error("Rate limit exceeded"), {
              response: {
                status: 429,
                data: {
                  error: {
                    status: "RESOURCE_EXHAUSTED",
                    errors: [{ reason: "rateLimitExceeded" }],
                  },
                },
              },
            });
          }
          return { data: {} };
        },
      },
    } as never,
  });

  try {
    const result = await writeBackNewFile(
      "presentation_recover",
      slides.map(({ extracted }) => extracted),
      slides.map(({ translated }) => translated)
    );

    assert.equal(result.committedUnits, 7);
    assert.equal(batchUpdateCalls, 9);
    assert.equal(sleepCalls.length, 7);
  } finally {
    __resetSlidesClientForTests();
    __resetWriteRuntimeForTests();
  }
});

test("writeBackAppend limits quota retries and trips circuit breaker on repeated quota failures", async () => {
  const slides = [0, 1, 2].map((slideIndex) => {
    const node = createSingleParagraphNode({
      node_id: `shape_quota_${slideIndex}`,
      text: `Slide ${slideIndex}`,
      full_text: `Slide ${slideIndex}`,
      slide_index: slideIndex,
      element_type: "shape",
      archetype: "plain_text",
      object_id: `shape_quota_${slideIndex}`,
    });
    return {
      extracted: {
        slide_index: slideIndex,
        slide_object_id: `slide_quota_${slideIndex}`,
        nodes: [node],
      },
      translated: createValidTranslatedNode(node, `Texto ${slideIndex}`),
    };
  });
  const sleepCalls: number[] = [];
  let batchUpdateCalls = 0;

  __setWriteRuntimeForTests({
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
    random: () => 0.5,
  });
  __setSlidesClientForTests({
    auth: {} as never,
    slides: {
      presentations: {
        get: async () => ({
          data: {
            slides: slides.map(({ extracted }) =>
              createShapeSlide(extracted.slide_object_id, extracted.nodes[0]!.object_id)
            ),
          },
        }),
        batchUpdate: async () => {
          batchUpdateCalls += 1;
          throw Object.assign(new Error("Quota exceeded"), {
            response: {
              status: 403,
              data: {
                error: {
                  status: "RESOURCE_EXHAUSTED",
                  errors: [{ reason: "quotaExceeded" }],
                },
              },
            },
          });
        },
      },
    } as never,
  });

  try {
    const result = await writeBackAppend(
      "presentation_quota",
      slides.map(({ extracted }) => extracted),
      slides.map(({ translated }) => translated)
    );

    assert.equal(result.committedUnits, 0);
    assert.equal(batchUpdateCalls, 4);
    assert.deepEqual(result.failed_slide_indexes, [2, 1, 0]);
    assert.deepEqual(
      result.slide_results.map((item) => item.error_code),
      ["QUOTA_EXCEEDED", "QUOTA_EXCEEDED", "QUOTA_EXCEEDED"]
    );
    assert.deepEqual(sleepCalls, [500, 500]);
  } finally {
    __resetSlidesClientForTests();
    __resetWriteRuntimeForTests();
  }
});

test("writeBackNewFile degrades structural batch failures into smaller groups before failing single nodes", async () => {
  const firstNode = createSingleParagraphNode({
    node_id: "shape_group_1",
    text: "First",
    full_text: "First",
    slide_index: 0,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "shape_group_1",
  });
  const secondNode = createSingleParagraphNode({
    node_id: "shape_group_2",
    text: "Second",
    full_text: "Second",
    slide_index: 0,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "shape_group_2",
  });
  const failingNode = createSingleParagraphNode({
    node_id: "shape_group_3",
    text: "Third",
    full_text: "Third",
    slide_index: 0,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "shape_group_3",
  });
  const objectIdsPerCall: string[][] = [];

  __setSlidesClientForTests({
    auth: {} as never,
    slides: {
      presentations: {
        get: async () => ({
          data: {
            slides: [
              {
                objectId: "slide_0",
                pageElements: [
                  { objectId: "shape_group_1", shape: { text: { textElements: [] } } },
                  { objectId: "shape_group_2", shape: { text: { textElements: [] } } },
                  { objectId: "shape_group_3", shape: { text: { textElements: [] } } },
                ],
              },
            ],
          },
        }),
        batchUpdate: async (
          params: slides_v1.Params$Resource$Presentations$Batchupdate
        ) => {
          const objectIds = (params.requestBody?.requests ?? [])
            .flatMap((request) => {
              const deleteRange = request.deleteText?.objectId;
              const insertRange = request.insertText?.objectId;
              const textStyleRange = request.updateTextStyle?.objectId;
              const paragraphRange = request.updateParagraphStyle?.objectId;
              return [deleteRange, insertRange, textStyleRange, paragraphRange].filter(
                (value): value is string => Boolean(value)
              );
            });
          objectIdsPerCall.push([...new Set(objectIds)]);

          const uniqueObjectIds = [...new Set(objectIds)];
          if (uniqueObjectIds.length === 3) {
            throw Object.assign(new Error("invalid batch"), {
              response: { status: 400, data: { error: { status: "INVALID_ARGUMENT" } } },
            });
          }
          if (uniqueObjectIds.length === 1 && uniqueObjectIds[0] === "shape_group_3") {
            throw Object.assign(new Error("invalid node"), {
              response: { status: 400, data: { error: { status: "INVALID_ARGUMENT" } } },
            });
          }

          return { data: {} };
        },
      },
    } as never,
  });

  try {
    const result = await writeBackNewFile(
      "presentation_group",
      [
        {
          slide_index: 0,
          slide_object_id: "slide_0",
          nodes: [firstNode, secondNode, failingNode],
        },
      ],
      [
        createValidTranslatedNode(firstNode, "Uno"),
        createValidTranslatedNode(secondNode, "Dos"),
        createValidTranslatedNode(failingNode, "Tres"),
      ]
    );

    assert.equal(result.committedUnits, 1);
    assert.deepEqual(result.committed_slide_indexes, [0]);
    assert.deepEqual(result.failed_slide_indexes, []);
    assert.deepEqual(
      result.slide_results[0]?.committed_node_ids,
      ["shape_group_1", "shape_group_2"]
    );
    assert.deepEqual(
      result.slide_results[0]?.failed_node_ids,
      ["shape_group_3"]
    );
    assert.equal(objectIdsPerCall.some((ids) => ids.length === 3), true);
    assert.equal(objectIdsPerCall.some((ids) => ids.length === 2), true);
    assert.equal(
      objectIdsPerCall.some((ids) => ids.length === 1 && ids[0] === "shape_group_3"),
      true
    );
  } finally {
    __resetSlidesClientForTests();
  }
});

test("writeBackAppend trips circuit breaker after repeated systemic auth failures", async () => {
  const firstNode = createSingleParagraphNode({
    node_id: "shape_auth_1",
    text: "First",
    full_text: "First",
    slide_index: 0,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "shape_auth_1",
  });
  const secondNode = createSingleParagraphNode({
    node_id: "shape_auth_2",
    text: "Second",
    full_text: "Second",
    slide_index: 1,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "shape_auth_2",
  });
  const thirdNode = createSingleParagraphNode({
    node_id: "shape_auth_3",
    text: "Third",
    full_text: "Third",
    slide_index: 2,
    element_type: "shape",
    archetype: "plain_text",
    object_id: "shape_auth_3",
  });

  let batchUpdateCalls = 0;
  __setSlidesClientForTests({
    auth: {} as never,
    slides: {
      presentations: {
        get: async () => ({
          data: {
            slides: [
              createShapeSlide("slide_0", "shape_auth_1"),
              createShapeSlide("slide_1", "shape_auth_2"),
              createShapeSlide("slide_2", "shape_auth_3"),
            ],
          },
        }),
        batchUpdate: async () => {
          batchUpdateCalls += 1;
          throw Object.assign(new Error("Unauthorized"), {
            response: {
              status: 401,
              data: { error: { status: "UNAUTHENTICATED" } },
            },
          });
        },
      },
    } as never,
  });

  try {
    const result = await writeBackAppend(
      "presentation_auth",
      [
        { slide_index: 0, slide_object_id: "slide_0", nodes: [firstNode] },
        { slide_index: 1, slide_object_id: "slide_1", nodes: [secondNode] },
        { slide_index: 2, slide_object_id: "slide_2", nodes: [thirdNode] },
      ],
      [
        createValidTranslatedNode(firstNode, "Uno"),
        createValidTranslatedNode(secondNode, "Dos"),
        createValidTranslatedNode(thirdNode, "Tres"),
      ]
    );

    assert.equal(batchUpdateCalls, 2);
    assert.equal(result.committedUnits, 0);
    assert.deepEqual(result.failed_slide_indexes, [2, 1, 0]);
    assert.deepEqual(
      result.slide_results.map((item) => item.error_code),
      ["UNAUTHORIZED", "UNAUTHORIZED", "UNAUTHORIZED"]
    );
  } finally {
    __resetSlidesClientForTests();
  }
});

test("test Slides client injection is blocked in production", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    assert.throws(
      () =>
        __setSlidesClientForTests({
          auth: {} as never,
          slides: {} as never,
        }),
      /disabled in production/
    );
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
  }
});
