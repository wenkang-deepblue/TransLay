import test from "node:test";
import assert from "node:assert/strict";
import type { slides_v1 } from "googleapis";
import {
  buildRichTextNode,
  extractBoxGeometry,
  extractTableCellVisibleStyleSummary,
  extractVisibleStyleSummary,
} from "./rich-text";

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
  assert.equal(node.box.width_emu, 120 * 12700);
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

test("extractBoxGeometry preserves EMU units and computes rotation sign correctly", () => {
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

  assert.equal(box.width_emu, 914400);
  assert.equal(box.height_emu, 457200);
  assert.equal(box.translate_x_emu, 1000);
  assert.equal(box.translate_y_emu, 2000);
  assert.ok(Math.abs(box.rotation_deg - 30) < 0.0001);
});
