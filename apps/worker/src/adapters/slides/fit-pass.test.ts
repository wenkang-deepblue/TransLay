import test from "node:test";
import assert from "node:assert/strict";
import type { TranslatedNode } from "@translay/shared-contracts";
import type { SlideTextNode } from "./types";
import {
  applyFitToTextStyle,
  estimateOverflow,
  fitTranslatedNode,
  measureTextWeight,
} from "./fit-pass";

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
      width_emu: 100 * 12700,
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
        paragraph_style: {},
        runs: [
          {
            run_id: "r0",
            text: overrides.full_text,
            start_index: 0,
            end_index: overrides.full_text.length,
            style_role: "default",
            text_style: {
              fontSize: { magnitude: 16, unit: "PT" },
            },
          },
        ],
      },
    ],
    row_index: overrides.row_index,
    col_index: overrides.col_index,
  };
}

function createTranslatedNode(
  overrides: Partial<TranslatedNode> & Pick<TranslatedNode, "node_id" | "translated_full_text">
): TranslatedNode {
  return {
    node_id: overrides.node_id,
    translated_full_text: overrides.translated_full_text,
    paragraphs:
      overrides.paragraphs ?? [
        {
          paragraph_id: "p0",
          translated_text: overrides.translated_full_text,
          bullet_behavior: "none",
        },
      ],
    segments:
      overrides.segments ?? [
        {
          segment_id: "r0",
          translated_text: overrides.translated_full_text,
          style_role: "default",
        },
      ],
    risk_flags: overrides.risk_flags,
  };
}

function riskRank(risk: "low" | "medium" | "high"): number {
  return { low: 0, medium: 1, high: 2 }[risk];
}

test("fitTranslatedNode scales down long metric-card translations and reduces overflow score", () => {
  const sourceNode = createNode({
    node_id: "metric_1",
    text: "$68B ARR",
    full_text: "$68B ARR",
    slide_index: 1,
    element_type: "shape",
    archetype: "metric_card",
    object_id: "metric_1",
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
        paragraph_style: {},
        runs: [
          {
            run_id: "r0",
            text: "$68B",
            start_index: 0,
            end_index: 4,
            style_role: "metric_value",
            text_style: { fontSize: { magnitude: 28, unit: "PT" }, bold: true },
          },
          {
            run_id: "r1",
            text: " ARR",
            start_index: 4,
            end_index: 8,
            style_role: "metric_unit",
            text_style: { fontSize: { magnitude: 14, unit: "PT" } },
          },
        ],
      },
    ],
  });

  const translatedNode = createTranslatedNode({
    node_id: "metric_1",
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
  });

  const baselineOverflow = estimateOverflow(sourceNode, translatedNode, 1);
  const fit = fitTranslatedNode(sourceNode, translatedNode);
  const fittedOverflow = estimateOverflow(sourceNode, translatedNode, fit.scale);

  assert.ok(baselineOverflow > 1);
  assert.ok(fit.scale < 1);
  assert.ok(fittedOverflow <= baselineOverflow);
});

test("fitTranslatedNode uses stricter thresholds for metric cards than bullet lists", () => {
  const bulletNode = createNode({
    node_id: "bullet_1",
    text: "Growth accelerated",
    full_text: "Growth accelerated",
    slide_index: 1,
    element_type: "shape",
    archetype: "bullet_list",
    object_id: "bullet_1",
    box: {
      width_emu: 96 * 12700,
      height_emu: 44 * 12700,
      translate_x_emu: 0,
      translate_y_emu: 0,
      rotation_deg: 0,
    },
    paragraphs: [
      {
        paragraph_id: "p0",
        text: "Growth accelerated",
        start_index: 0,
        end_index: 18,
        bullet: { nesting_level: 0 },
        paragraph_style: {},
        runs: [
          {
            run_id: "r0",
            text: "Growth accelerated",
            start_index: 0,
            end_index: 18,
            style_role: "default",
            text_style: { fontSize: { magnitude: 18, unit: "PT" } },
          },
        ],
      },
    ],
  });

  const metricNode = createNode({
    ...bulletNode,
    node_id: "metric_2",
    archetype: "metric_card",
    object_id: "metric_2",
    paragraphs: [
      {
        paragraph_id: "p0",
        text: "Growth accelerated",
        start_index: 0,
        end_index: 18,
        paragraph_style: {},
        runs: [
          {
            run_id: "r0",
            text: "Growth",
            start_index: 0,
            end_index: 6,
            style_role: "metric_value",
            text_style: { fontSize: { magnitude: 28, unit: "PT" } },
          },
          {
            run_id: "r1",
            text: " accelerated",
            start_index: 6,
            end_index: 18,
            style_role: "metric_unit",
            text_style: { fontSize: { magnitude: 14, unit: "PT" } },
          },
        ],
      },
    ],
  });

  const translatedNode = createTranslatedNode({
    node_id: "translated",
    translated_full_text: "Crecimiento acelerado para clientes empresariales",
  });

  const bulletFit = fitTranslatedNode(bulletNode, {
    ...translatedNode,
    node_id: "bullet_1",
  });
  const metricFit = fitTranslatedNode(metricNode, {
    ...translatedNode,
    node_id: "metric_2",
    segments: [
      {
        segment_id: "r0",
        translated_text: "Crecimiento acelerado",
        style_role: "metric_value",
      },
      {
        segment_id: "r1",
        translated_text: " para clientes empresariales",
        style_role: "metric_unit",
      },
    ],
  });

  assert.ok(
    estimateOverflow(metricNode, {
      ...translatedNode,
      node_id: "metric_2",
      segments: [
        {
          segment_id: "r0",
          translated_text: "Crecimiento acelerado",
          style_role: "metric_value",
        },
        {
          segment_id: "r1",
          translated_text: " para clientes empresariales",
          style_role: "metric_unit",
        },
      ],
    }, 1) >
      estimateOverflow(bulletNode, {
        ...translatedNode,
        node_id: "bullet_1",
      }, 1)
  );
  assert.ok(riskRank(metricFit.risk) >= riskRank(bulletFit.risk));
});

test("fitTranslatedNode marks severe overflow as high risk and requests tighter paragraph spacing", () => {
  const sourceNode = createNode({
    node_id: "cell_critical",
    text: "Q1",
    full_text: "Q1",
    slide_index: 2,
    element_type: "table_cell",
    archetype: "table_cell",
    object_id: "table_1",
    box: {
      width_emu: 44 * 12700,
      height_emu: 18 * 12700,
      translate_x_emu: 0,
      translate_y_emu: 0,
      rotation_deg: 0,
    },
    paragraphs: [
      {
        paragraph_id: "p0",
        text: "Q1",
        start_index: 0,
        end_index: 2,
        paragraph_style: { lineSpacing: 110 },
        runs: [
          {
            run_id: "r0",
            text: "Q1",
            start_index: 0,
            end_index: 2,
            style_role: "default",
            text_style: { fontSize: { magnitude: 16, unit: "PT" } },
          },
        ],
      },
    ],
  });

  const translatedNode = createTranslatedNode({
    node_id: "cell_critical",
    translated_full_text:
      "primer trimestre con crecimiento interanual significativamente superior",
  });

  const fit = fitTranslatedNode(sourceNode, translatedNode);

  assert.equal(fit.risk, "high");
  assert.equal(fit.applyTighterParagraphSpacing, true);
  assert.ok(fit.avoidExpansion);
});

test("fitTranslatedNode shrinks dense CJK metric values to stay within the original card", () => {
  const sourceNode = createNode({
    node_id: "metric_cjk",
    text: "3M",
    full_text: "3M",
    slide_index: 4,
    element_type: "shape",
    archetype: "metric_card",
    object_id: "metric_cjk",
    box: {
      width_emu: 52 * 12700,
      height_emu: 26 * 12700,
      translate_x_emu: 0,
      translate_y_emu: 0,
      rotation_deg: 0,
    },
    paragraphs: [
      {
        paragraph_id: "p0",
        text: "3M",
        start_index: 0,
        end_index: 2,
        paragraph_style: {},
        runs: [
          {
            run_id: "r0",
            text: "3M",
            start_index: 0,
            end_index: 2,
            style_role: "metric_value",
            text_style: { fontSize: { magnitude: 48, unit: "PT" }, bold: true },
          },
        ],
      },
    ],
  });

  const translatedNode = createTranslatedNode({
    node_id: "metric_cjk",
    translated_full_text: "300万",
    segments: [
      {
        segment_id: "r0",
        translated_text: "300万",
        style_role: "metric_value",
      },
    ],
  });

  const fit = fitTranslatedNode(sourceNode, translatedNode);

  assert.ok(fit.scale < 1);
  assert.ok(fit.scale <= 0.72);
  assert.ok(riskRank(fit.risk) >= riskRank("medium"));
});

test("applyFitToTextStyle injects fallback font size for inherited theme runs when shrinking", () => {
  const scaled = applyFitToTextStyle(
    {
      bold: true,
    },
    {
      scale: 0.8,
      risk: "medium",
      applyTighterParagraphSpacing: false,
      compactness: "normal",
      avoidExpansion: true,
    },
    20
  );

  assert.equal(scaled.bold, true);
  assert.equal(scaled.fontSize?.magnitude, 16);
  assert.equal(scaled.fontSize?.unit, "PT");
});

test("measureTextWeight distinguishes uppercase ascii, spaces, and CJK characters", () => {
  const lower = measureTextWeight("abc");
  const upper = measureTextWeight("ABC");
  const compact = measureTextWeight("AA");
  const spaced = measureTextWeight("A A");
  const cjk = measureTextWeight("中文");
  const mixed = measureTextWeight("ARR 中文");

  assert.ok(upper > lower);
  assert.ok(spaced > compact);
  assert.ok(cjk > 2);
  assert.ok(mixed > upper);
});
