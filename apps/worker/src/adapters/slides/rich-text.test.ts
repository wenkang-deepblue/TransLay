import test from "node:test";
import assert from "node:assert/strict";
import type { slides_v1 } from "googleapis";
import {
  buildRichTextNode,
  extractBoxGeometry,
  extractTableCellVisibleStyleSummary,
  extractVisibleStyleSummary,
} from "./rich-text";
import { buildPlaceholderFontSizeLookup } from "./extractor";

test("buildRichTextNode preserves bullet paragraphs, styles, and box geometry", () => {
  const element = {
    objectId: "shape_1",
    size: {
      width: { magnitude: 120, unit: "PT" },
      height: { magnitude: 60, unit: "PT" },
    },
    transform: {
      scaleX: 1,
      scaleY: 1,
      shearX: 0,
      shearY: 0,
      translateX: 36,
      translateY: 72,
      unit: "PT",
    },
    shape: {
      text: {
        textElements: [
          {
            startIndex: 0,
            paragraphMarker: {
              style: { alignment: "START" },
              bullet: { listId: "list-1", glyph: "•" },
            },
          },
          {
            startIndex: 0,
            endIndex: 6,
            textRun: {
              content: "Hello\n",
              style: {
                fontSize: { magnitude: 18, unit: "PT" },
                bold: true,
              },
            },
          },
          {
            startIndex: 6,
            paragraphMarker: {
              style: { alignment: "START" },
              bullet: { listId: "list-1", glyph: "•" },
            },
          },
          {
            startIndex: 6,
            endIndex: 12,
            textRun: {
              content: "World\n",
              style: {
                fontSize: { magnitude: 14, unit: "PT" },
              },
            },
          },
        ],
      },
    },
  } as unknown as slides_v1.Schema$PageElement;

  const node = buildRichTextNode({
    nodeId: "n1",
    objectId: "shape_1",
    slideIndex: 0,
    elementType: "shape",
    textContent: element.shape!.text!,
    box: extractBoxGeometry(element),
  });

  assert.ok(node);
  assert.equal(node.archetype, "bullet_list");
  assert.equal(node.text, "Hello\nWorld\n");
  assert.equal(node.paragraphs.length, 2);
  assert.equal(node.paragraphs[0]?.bullet?.list_id, "list-1");
  assert.equal(node.paragraphs[0]?.runs[0]?.text, "Hello");
  assert.equal(node.paragraphs[0]?.runs[0]?.text_style?.bold, true);
  assert.equal(node.box.width_emu, 120 * 12700); // scaleX=1 → unchanged
  assert.equal(node.box.translate_y_emu, 72 * 12700);
});

test("extractVisibleStyleSummary captures text metrics and visible shape colors", () => {
  const element = {
    objectId: "shape_1",
    shape: {
      shapeProperties: {
        shapeBackgroundFill: {
          solidFill: {
            color: {
              rgbColor: {
                red: 0.1,
                green: 0.2,
                blue: 0.3,
              },
            },
          },
        },
        outline: {
          outlineFill: {
            solidFill: {
              color: {
                rgbColor: {
                  red: 0.7,
                  green: 0.8,
                  blue: 0.9,
                },
              },
            },
          },
        },
      },
      text: {
        textElements: [
          {
            startIndex: 0,
            paragraphMarker: {
              style: { alignment: "CENTER" },
            },
          },
          {
            startIndex: 0,
            endIndex: 6,
            textRun: {
              content: "Badge\n",
              style: {
                fontSize: { magnitude: 16, unit: "PT" },
                weightedFontFamily: { fontFamily: "Inter" },
              },
            },
          },
        ],
      },
    },
  } as unknown as slides_v1.Schema$PageElement;

  const summary = extractVisibleStyleSummary(element, element.shape!.text!);

  assert.deepEqual(summary, {
    alignment: "CENTER",
    font_family: "Inter",
    min_font_size_pt: 16,
    max_font_size_pt: 16,
    fill_color_hex: "#1a334d",
    outline_color_hex: "#b3cce6",
  });
});

test("buildRichTextNode infers visible font metrics for inherited theme-sized title text", () => {
  const element = {
    objectId: "shape_theme_title",
    size: {
      width: { magnitude: 240, unit: "PT" },
      height: { magnitude: 36, unit: "PT" },
    },
    transform: {
      scaleX: 1,
      scaleY: 1,
      shearX: 0,
      shearY: 0,
      translateX: 0,
      translateY: 0,
      unit: "PT",
    },
    shape: {
      text: {
        textElements: [
          {
            startIndex: 0,
            paragraphMarker: {
              style: { alignment: "CENTER" },
            },
          },
          {
            startIndex: 0,
            endIndex: 15,
            textRun: {
              content: "Growth Strategy",
              style: {
                weightedFontFamily: { fontFamily: "Arial" },
                bold: true,
              },
            },
          },
        ],
      },
    },
  } as unknown as slides_v1.Schema$PageElement;

  const node = buildRichTextNode({
    nodeId: "theme-title-1",
    objectId: "shape_theme_title",
    slideIndex: 0,
    elementType: "shape",
    textContent: element.shape!.text!,
    box: extractBoxGeometry(element),
  });

  assert.ok(node);
  assert.equal(node.visible_style?.alignment, "CENTER");
  assert.equal(node.visible_style?.font_family, "Arial");
  assert.equal(typeof node.visible_style?.max_font_size_pt, "number");
  assert.equal(typeof node.visible_style?.min_font_size_pt, "number");
  assert.ok((node.visible_style?.max_font_size_pt ?? 0) >= 20);
});

test("extractTableCellVisibleStyleSummary captures table cell background fill", () => {
  const cell = {
    tableCellProperties: {
      tableCellBackgroundFill: {
        solidFill: {
          color: {
            rgbColor: {
              red: 1.2,
              green: 0.5,
              blue: -0.2,
            },
          },
        },
      },
    },
    text: {
      textElements: [
        {
          startIndex: 0,
          paragraphMarker: {
            style: { alignment: "CENTER" },
          },
        },
        {
          startIndex: 0,
          endIndex: 5,
          textRun: {
            content: "Cell\n",
            style: {
              fontSize: { magnitude: 12, unit: "PT" },
              weightedFontFamily: { fontFamily: "Arial" },
            },
          },
        },
      ],
    },
  } as unknown as slides_v1.Schema$TableCell;

  const summary = extractTableCellVisibleStyleSummary(cell, cell.text!);

  assert.deepEqual(summary, {
    alignment: "CENTER",
    font_family: "Arial",
    min_font_size_pt: 12,
    max_font_size_pt: 12,
    fill_color_hex: "#ff8000",
  });
});

test("buildRichTextNode records preserved hard-break counts for body-like shapes", () => {
  const textContent = {
    textElements: [
      {
        startIndex: 0,
        paragraphMarker: {
          style: { alignment: "START" },
        },
      },
      {
        startIndex: 0,
        endIndex: 15,
        textRun: {
          content: "Heading\nBody line\n\nNext heading\nNext body\n",
          style: {
            fontSize: { magnitude: 16, unit: "PT" },
          },
        },
      },
    ],
  } as unknown as slides_v1.Schema$TextContent;

  const node = buildRichTextNode({
    nodeId: "body_like_spacing",
    objectId: "shape_body_like_spacing",
    slideIndex: 0,
    elementType: "shape",
    textContent,
    box: {
      width_emu: 320 * 12700,
      height_emu: 120 * 12700,
      translate_x_emu: 0,
      translate_y_emu: 0,
      rotation_deg: 0,
    },
    visibleStyle: {
      alignment: "START",
      min_font_size_pt: 16,
      max_font_size_pt: 16,
    },
  });

  assert.ok(node);
  assert.deepEqual(
    node.paragraphs.map((paragraph) => ({
      text: paragraph.text,
      line_breaks_before: paragraph.line_breaks_before,
    })),
    [
      { text: "Heading", line_breaks_before: 0 },
      { text: "Body line", line_breaks_before: 1 },
      { text: "Next heading", line_breaks_before: 2 },
      { text: "Next body", line_breaks_before: 1 },
    ]
  );
});

test("buildRichTextNode classifies metric cards and assigns metric style roles", () => {
  const textContent = {
    textElements: [
      {
        startIndex: 0,
        paragraphMarker: {
          style: { alignment: "CENTER" },
        },
      },
      {
        startIndex: 0,
        endIndex: 1,
        textRun: {
          content: "$",
          style: {
            fontSize: { magnitude: 10, unit: "PT" },
          },
        },
      },
      {
        startIndex: 1,
        endIndex: 5,
        textRun: {
          content: "68B\n",
          style: {
            fontSize: { magnitude: 28, unit: "PT" },
            bold: true,
          },
        },
      },
      {
        startIndex: 5,
        paragraphMarker: {
          style: { alignment: "CENTER" },
        },
      },
      {
        startIndex: 5,
        endIndex: 26,
        textRun: {
          content: "and more top clients\n",
          style: {
            fontSize: { magnitude: 12, unit: "PT" },
          },
        },
      },
    ],
  } as slides_v1.Schema$TextContent;

  const node = buildRichTextNode({
    nodeId: "metric-1",
    objectId: "shape_metric",
    slideIndex: 3,
    elementType: "shape",
    textContent,
    box: {
      width_emu: 0,
      height_emu: 0,
      translate_x_emu: 0,
      translate_y_emu: 0,
      rotation_deg: 0,
    },
  });

  assert.ok(node);
  assert.equal(node.archetype, "metric_card");
  assert.equal(node.paragraphs.length, 2);
  assert.equal(node.paragraphs[0]?.runs[0]?.style_role, "prefix");
  assert.equal(node.paragraphs[0]?.runs[1]?.style_role, "metric_value");
  assert.equal(node.paragraphs[1]?.runs[0]?.style_role, "suffix");
});

test("buildRichTextNode classifies mixed emphasis and marks non-baseline runs", () => {
  const textContent = {
    textElements: [
      {
        startIndex: 0,
        paragraphMarker: {
          style: { alignment: "START" },
        },
      },
      {
        startIndex: 0,
        endIndex: 5,
        textRun: {
          content: "Alpha",
          style: {
            fontSize: { magnitude: 14, unit: "PT" },
          },
        },
      },
      {
        startIndex: 5,
        endIndex: 11,
        textRun: {
          content: " Beta\n",
          style: {
            fontSize: { magnitude: 14, unit: "PT" },
            bold: true,
          },
        },
      },
    ],
  } as slides_v1.Schema$TextContent;

  const node = buildRichTextNode({
    nodeId: "mixed-1",
    objectId: "shape_mixed",
    slideIndex: 1,
    elementType: "shape",
    textContent,
    box: {
      width_emu: 0,
      height_emu: 0,
      translate_x_emu: 0,
      translate_y_emu: 0,
      rotation_deg: 0,
    },
  });

  assert.ok(node);
  assert.equal(node.archetype, "mixed_emphasis");
  assert.equal(node.paragraphs[0]?.runs[0]?.style_role, "default");
  assert.equal(node.paragraphs[0]?.runs[1]?.style_role, "emphasis");
});

test("buildRichTextNode classifies table cells and speaker notes correctly", () => {
  const textContent = {
    textElements: [
      {
        startIndex: 0,
        paragraphMarker: {
          style: { alignment: "START" },
        },
      },
      {
        startIndex: 0,
        endIndex: 10,
        textRun: {
          content: "Cell text\n",
          style: {
            fontSize: { magnitude: 12, unit: "PT" },
          },
        },
      },
    ],
  } as slides_v1.Schema$TextContent;

  const tableNode = buildRichTextNode({
    nodeId: "cell-1",
    objectId: "table_1",
    slideIndex: 2,
    elementType: "table_cell",
    textContent,
    box: {
      width_emu: 0,
      height_emu: 0,
      translate_x_emu: 0,
      translate_y_emu: 0,
      rotation_deg: 0,
    },
    rowIndex: 1,
    colIndex: 2,
  });

  const notesNode = buildRichTextNode({
    nodeId: "notes-1",
    objectId: "notes_1",
    slideIndex: 2,
    elementType: "speaker_notes",
    textContent,
    box: {
      width_emu: 0,
      height_emu: 0,
      translate_x_emu: 0,
      translate_y_emu: 0,
      rotation_deg: 0,
    },
  });

  assert.ok(tableNode);
  assert.equal(tableNode.archetype, "table_cell");
  assert.equal(tableNode.row_index, 1);
  assert.equal(tableNode.col_index, 2);

  assert.ok(notesNode);
  assert.equal(notesNode.archetype, "speaker_notes");
});

test("buildRichTextNode preserves hard breaks and repeated spaces for body placeholders", () => {
  const textContent = {
    textElements: [
      {
        startIndex: 0,
        paragraphMarker: {
          style: { alignment: "START" },
        },
      },
      {
        startIndex: 0,
        endIndex: 28,
        textRun: {
          content: "First line\n  second  line\nThird",
          style: {
            fontSize: { magnitude: 18, unit: "PT" },
          },
        },
      },
    ],
  } as slides_v1.Schema$TextContent;

  const node = buildRichTextNode({
    nodeId: "body-whitespace-1",
    objectId: "shape_body",
    slideIndex: 4,
    elementType: "shape",
    placeholderType: "BODY",
    textContent,
    box: {
      width_emu: 320 * 12700,
      height_emu: 72 * 12700,
      translate_x_emu: 0,
      translate_y_emu: 0,
      rotation_deg: 0,
    },
  });

  assert.ok(node);
  assert.equal(node.paragraphs.length, 3);
  assert.equal(node.paragraphs[0]?.text, "First line");
  assert.equal(node.paragraphs[1]?.text, "  second  line");
  assert.equal(node.paragraphs[2]?.text, "Third");
});

test("buildRichTextNode keeps legacy whitespace handling for non-body placeholder shapes", () => {
  const textContent = {
    textElements: [
      {
        startIndex: 0,
        paragraphMarker: {
          style: { alignment: "CENTER" },
        },
      },
      {
        startIndex: 0,
        endIndex: 20,
        textRun: {
          content: "Line A\n  Line B",
          style: {
            fontSize: { magnitude: 28, unit: "PT" },
            bold: true,
          },
        },
      },
    ],
  } as slides_v1.Schema$TextContent;

  const node = buildRichTextNode({
    nodeId: "title-whitespace-1",
    objectId: "shape_title",
    slideIndex: 4,
    elementType: "shape",
    placeholderType: "TITLE",
    textContent,
    box: {
      width_emu: 240 * 12700,
      height_emu: 36 * 12700,
      translate_x_emu: 0,
      translate_y_emu: 0,
      rotation_deg: 0,
    },
  });

  assert.ok(node);
  assert.equal(node.paragraphs.length, 1);
  assert.equal(node.paragraphs[0]?.text, "Line A  Line B");
});

test("buildRichTextNode returns null for non-translatable autoText-only or newline-only content", () => {
  const autoTextOnly = {
    textElements: [
      {
        startIndex: 0,
        paragraphMarker: {
          style: { alignment: "START" },
        },
      },
      {
        startIndex: 0,
        endIndex: 1,
        autoText: {
          content: "3",
          type: "SLIDE_NUMBER",
        },
      },
    ],
  } as slides_v1.Schema$TextContent;

  const newlineOnly = {
    textElements: [
      {
        startIndex: 0,
        paragraphMarker: {
          style: { alignment: "START" },
        },
      },
      {
        startIndex: 0,
        endIndex: 1,
        textRun: {
          content: "\n",
          style: {
            fontSize: { magnitude: 12, unit: "PT" },
          },
        },
      },
    ],
  } as slides_v1.Schema$TextContent;

  assert.equal(
    buildRichTextNode({
      nodeId: "auto-1",
      objectId: "shape_auto",
      slideIndex: 0,
      elementType: "shape",
      textContent: autoTextOnly,
      box: {
        width_emu: 0,
        height_emu: 0,
        translate_x_emu: 0,
        translate_y_emu: 0,
        rotation_deg: 0,
      },
    }),
    null
  );

  assert.equal(
    buildRichTextNode({
      nodeId: "newline-1",
      objectId: "shape_newline",
      slideIndex: 0,
      elementType: "shape",
      textContent: newlineOnly,
      box: {
        width_emu: 0,
        height_emu: 0,
        translate_x_emu: 0,
        translate_y_emu: 0,
        rotation_deg: 0,
      },
    }),
    null
  );
});

test("extractBoxGeometry preserves EMU units across pure rotation and computes rotation", () => {
  const element = {
    size: {
      width: { magnitude: 914400, unit: "EMU" },
      height: { magnitude: 457200, unit: "EMU" },
    },
    transform: {
      scaleX: Math.cos(Math.PI / 6),
      scaleY: Math.cos(Math.PI / 6),
      shearX: -Math.sin(Math.PI / 6),
      shearY: Math.sin(Math.PI / 6),
      translateX: 1000,
      translateY: 2000,
      unit: "EMU",
    },
  } as unknown as slides_v1.Schema$PageElement;

  const box = extractBoxGeometry(element);

  assert.ok(Math.abs(box.width_emu - 914400) < 1);
  assert.ok(Math.abs(box.height_emu - 457200) < 1);
  assert.equal(box.translate_x_emu, 1000);
  assert.equal(box.translate_y_emu, 2000);
  assert.ok(Math.abs(box.rotation_deg - 30) < 0.0001);
});

test("extractBoxGeometry applies non-uniform scaleX/scaleY to compute effective dimensions", () => {
  const element = {
    size: {
      width: { magnitude: 3000000, unit: "EMU" },
      height: { magnitude: 3000000, unit: "EMU" },
    },
    transform: {
      scaleX: 2.8402,
      scaleY: 0.1909,
      translateX: 311700,
      translateY: 445025,
      unit: "EMU",
    },
  } as unknown as slides_v1.Schema$PageElement;

  const box = extractBoxGeometry(element);

  assert.ok(Math.abs(box.width_emu - 3000000 * 2.8402) < 1);
  assert.ok(Math.abs(box.height_emu - 3000000 * 0.1909) < 1);
});

test("extractBoxGeometry preserves mirrored element dimensions", () => {
  const element = {
    size: {
      width: { magnitude: 100000, unit: "EMU" },
      height: { magnitude: 200000, unit: "EMU" },
    },
    transform: {
      scaleX: -1.5,
      scaleY: -0.8,
      translateX: 0,
      translateY: 0,
      unit: "EMU",
    },
  } as unknown as slides_v1.Schema$PageElement;

  const box = extractBoxGeometry(element);

  assert.ok(Math.abs(box.width_emu - 100000 * 1.5) < 1);
  assert.ok(Math.abs(box.height_emu - 200000 * 0.8) < 1);
});

test("extractBoxGeometry combines scale and rotation without shrinking by cos(theta)", () => {
  const element = {
    size: {
      width: { magnitude: 100000, unit: "EMU" },
      height: { magnitude: 50000, unit: "EMU" },
    },
    transform: {
      scaleX: Math.cos(Math.PI / 4) * 2,
      scaleY: Math.cos(Math.PI / 4) * 3,
      shearX: -Math.sin(Math.PI / 4) * 3,
      shearY: Math.sin(Math.PI / 4) * 2,
      translateX: 0,
      translateY: 0,
      unit: "EMU",
    },
  } as unknown as slides_v1.Schema$PageElement;

  const box = extractBoxGeometry(element);

  assert.ok(Math.abs(box.width_emu - 200000) < 1);
  assert.ok(Math.abs(box.height_emu - 150000) < 1);
});

test("buildRichTextNode injects inheritedFontSizePt into runs lacking explicit fontSize", () => {
  const textContent = {
    textElements: [
      {
        startIndex: 0,
        paragraphMarker: {
          style: { alignment: "CENTER" },
        },
      },
      {
        startIndex: 0,
        endIndex: 14,
        textRun: {
          content: "Agenda Title\n",
          style: {
            weightedFontFamily: { fontFamily: "Roboto" },
            bold: true,
          },
        },
      },
    ],
  } as slides_v1.Schema$TextContent;

  const node = buildRichTextNode({
    nodeId: "inherited-1",
    objectId: "shape_placeholder",
    slideIndex: 0,
    elementType: "shape",
    textContent,
    box: {
      width_emu: 240 * 12700,
      height_emu: 36 * 12700,
      translate_x_emu: 0,
      translate_y_emu: 0,
      rotation_deg: 0,
    },
    inheritedFontSizePt: 28,
  });

  assert.ok(node);
  assert.equal(node.paragraphs[0]?.runs[0]?.text_style?.fontSize?.magnitude, 28);
  assert.equal(node.paragraphs[0]?.runs[0]?.text_style?.fontSize?.unit, "PT");
  assert.equal(node.visible_style?.max_font_size_pt, 28);
  assert.equal(node.visible_style?.min_font_size_pt, 28);
});

test("buildRichTextNode does NOT override existing explicit fontSize with inheritedFontSizePt", () => {
  const textContent = {
    textElements: [
      {
        startIndex: 0,
        paragraphMarker: {
          style: { alignment: "START" },
        },
      },
      {
        startIndex: 0,
        endIndex: 6,
        textRun: {
          content: "Hello\n",
          style: {
            fontSize: { magnitude: 18, unit: "PT" },
            bold: true,
          },
        },
      },
    ],
  } as slides_v1.Schema$TextContent;

  const node = buildRichTextNode({
    nodeId: "no-override-1",
    objectId: "shape_explicit",
    slideIndex: 0,
    elementType: "shape",
    textContent,
    box: {
      width_emu: 120 * 12700,
      height_emu: 36 * 12700,
      translate_x_emu: 0,
      translate_y_emu: 0,
      rotation_deg: 0,
    },
    inheritedFontSizePt: 28,
  });

  assert.ok(node);
  assert.equal(node.paragraphs[0]?.runs[0]?.text_style?.fontSize?.magnitude, 18);
});

test("buildPlaceholderFontSizeLookup extracts font sizes from masters and layouts", () => {
  const masters = [
    {
      pageElements: [
        {
          shape: {
            placeholder: { type: "TITLE", index: 0 },
            text: {
              textElements: [
                {
                  textRun: {
                    content: "Master Title\n",
                    style: { fontSize: { magnitude: 36, unit: "PT" } },
                  },
                },
              ],
            },
          },
        },
        {
          shape: {
            placeholder: { type: "BODY", index: 1 },
            text: {
              textElements: [
                {
                  textRun: {
                    content: "Master Body\n",
                    style: { fontSize: { magnitude: 18, unit: "PT" } },
                  },
                },
              ],
            },
          },
        },
      ],
    },
  ] as unknown as slides_v1.Schema$Page[];

  const layouts = [
    {
      pageElements: [
        {
          shape: {
            placeholder: { type: "TITLE", index: 0 },
            text: {
              textElements: [
                {
                  textRun: {
                    content: "Layout Title\n",
                    style: { fontSize: { magnitude: 28, unit: "PT" } },
                  },
                },
              ],
            },
          },
        },
      ],
    },
  ] as unknown as slides_v1.Schema$Page[];

  const lookup = buildPlaceholderFontSizeLookup(masters, layouts);

  assert.equal(lookup.get("TITLE|0"), 28);
  assert.equal(lookup.get("BODY|1"), 18);
});

test("buildPlaceholderFontSizeLookup layout takes precedence over master", () => {
  const masters = [
    {
      pageElements: [
        {
          shape: {
            placeholder: { type: "SUBTITLE" },
            text: {
              textElements: [
                {
                  textRun: {
                    content: "Master Sub\n",
                    style: { fontSize: { magnitude: 24, unit: "PT" } },
                  },
                },
              ],
            },
          },
        },
      ],
    },
  ] as unknown as slides_v1.Schema$Page[];

  const layouts = [
    {
      pageElements: [
        {
          shape: {
            placeholder: { type: "SUBTITLE" },
            text: {
              textElements: [
                {
                  textRun: {
                    content: "Layout Sub\n",
                    style: { fontSize: { magnitude: 20, unit: "PT" } },
                  },
                },
              ],
            },
          },
        },
      ],
    },
  ] as unknown as slides_v1.Schema$Page[];

  const lookup = buildPlaceholderFontSizeLookup(masters, layouts);

  assert.equal(lookup.get("SUBTITLE|-1"), 20);
});

test("extractBoxGeometry applies parentGroupScale to child element dimensions", () => {
  const childElement = {
    size: {
      width: { magnitude: 3000000, unit: "EMU" },
      height: { magnitude: 3000000, unit: "EMU" },
    },
    transform: {
      scaleX: 2.1998,
      scaleY: 0.1458,
      translateX: 842598,
      translateY: 4112325,
      unit: "EMU",
    },
  } as unknown as slides_v1.Schema$PageElement;

  const boxWithoutGroup = extractBoxGeometry(childElement);
  const boxWithGroup = extractBoxGeometry(childElement, 1.0515, 1.0);

  assert.ok(Math.abs(boxWithoutGroup.width_emu - 3000000 * 2.1998) < 1);
  assert.ok(Math.abs(boxWithGroup.width_emu - 3000000 * 2.1998 * 1.0515) < 1);
  assert.ok(Math.abs(boxWithGroup.height_emu - 3000000 * 0.1458 * 1.0) < 1);
});
