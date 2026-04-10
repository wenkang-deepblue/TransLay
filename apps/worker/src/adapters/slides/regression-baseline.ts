import type { TranslatedNode } from "@translay/shared-contracts";
import { __buildNodeWarningsForTests, __buildNodeWriteRequestsForTests } from "./writer";
import { fitTranslatedNode } from "./fit-pass";
import type {
  SlideNodeArchetype,
  SlideParagraph,
  SlideRunStyleRole,
  SlideTextNode,
  SlideTextStyleSnapshot,
} from "./types";

export const REQUIRED_REGRESSION_LANGUAGES = [
  "es",
  "de",
  "zh-Hans",
  "zh-Hant",
] as const;
export type RegressionTargetLanguage = (typeof REQUIRED_REGRESSION_LANGUAGES)[number];

export const REQUIRED_REGRESSION_ARCHETYPES = [
  "bullet_list",
  "metric_card",
  "mixed_emphasis",
  "speaker_notes",
  "table_cell",
] as const satisfies readonly SlideNodeArchetype[];

interface SourceRunInput {
  readonly run_id: string;
  readonly text: string;
  readonly style_role: SlideRunStyleRole;
  readonly text_style: SlideTextStyleSnapshot;
}

interface SourceParagraphInput {
  readonly paragraph_id: string;
  readonly text: string;
  readonly bullet_level?: number;
  readonly runs: readonly SourceRunInput[];
}

interface SourceNodeInput {
  readonly node_id: string;
  readonly slide_index: number;
  readonly archetype: SlideTextNode["archetype"];
  readonly object_id: string;
  readonly element_type: SlideTextNode["element_type"];
  readonly box: SlideTextNode["box"];
  readonly paragraphs: readonly SourceParagraphInput[];
  readonly row_index?: number;
  readonly col_index?: number;
}

interface TranslatedParagraphInput {
  readonly paragraph_id: string;
  readonly translated_text: string;
  readonly bullet_behavior: "preserve" | "none";
}

interface TranslatedSegmentInput {
  readonly segment_id: string;
  readonly translated_text: string;
  readonly style_role: SlideRunStyleRole;
}

interface RegressionStyleExpectation {
  readonly kind: "metric_hierarchy" | "emphasis_roles";
}

interface RegressionTermExpectation {
  readonly key: string;
  readonly expected_translation: string;
}

export interface SlidesFidelityRegressionSample {
  readonly sample_id: string;
  readonly target_language: RegressionTargetLanguage;
  readonly source_node: SlideTextNode;
  readonly translated_node: TranslatedNode;
  readonly style_expectation?: RegressionStyleExpectation;
  readonly term_expectations?: readonly RegressionTermExpectation[];
}

export interface RegressionBaselineMetrics {
  readonly sample_count: number;
  readonly bullet_case_count: number;
  readonly style_case_count: number;
  readonly term_expectation_count: number;
  readonly empty_bullet_generation_rate: number;
  readonly bullet_count_error_rate: number;
  readonly paragraph_count_error_rate: number;
  readonly obvious_overflow_rate: number;
  readonly style_hierarchy_retention_rate: number;
  readonly major_manual_reflow_rate: number;
  readonly term_consistency_rate: number;
}

export const SLIDES_FIDELITY_REGRESSION_SAMPLES: readonly SlidesFidelityRegressionSample[] = [
  {
    sample_id: "es-bullet-arr",
    target_language: "es",
    source_node: createSourceNode({
      node_id: "es-bullet-arr",
      slide_index: 1,
      archetype: "bullet_list",
      object_id: "shape_es_bullet",
      element_type: "shape",
      box: createBox(360, 132),
      paragraphs: [
        {
          paragraph_id: "p0",
          text: "ARR expanded",
          bullet_level: 0,
          runs: [
            {
              run_id: "r0",
              text: "ARR expanded",
              style_role: "default",
              text_style: { fontSize: { magnitude: 20, unit: "PT" } },
            },
          ],
        },
        {
          paragraph_id: "p1",
          text: "ARR stayed above target",
          bullet_level: 0,
          runs: [
            {
              run_id: "r1",
              text: "ARR stayed above target",
              style_role: "default",
              text_style: { fontSize: { magnitude: 20, unit: "PT" } },
            },
          ],
        },
      ],
    }),
    translated_node: createTranslatedNode({
      node_id: "es-bullet-arr",
      paragraphs: [
        {
          paragraph_id: "p0",
          translated_text: "ARR se expandio",
          bullet_behavior: "preserve",
        },
        {
          paragraph_id: "p1",
          translated_text: "ARR siguio sobre la meta",
          bullet_behavior: "preserve",
        },
      ],
      segments: [
        {
          segment_id: "r0",
          translated_text: "ARR se expandio",
          style_role: "default",
        },
        {
          segment_id: "r1",
          translated_text: "ARR siguio sobre la meta",
          style_role: "default",
        },
      ],
    }),
    term_expectations: [
      { key: "arr", expected_translation: "arr" },
    ],
  },
  {
    sample_id: "es-mixed-arr",
    target_language: "es",
    source_node: createSourceNode({
      node_id: "es-mixed-arr",
      slide_index: 2,
      archetype: "mixed_emphasis",
      object_id: "shape_es_mixed",
      element_type: "shape",
      box: createBox(320, 96),
      paragraphs: [
        {
          paragraph_id: "p0",
          text: "ARR drives growth",
          runs: [
            {
              run_id: "r0",
              text: "ARR",
              style_role: "default",
              text_style: { fontSize: { magnitude: 22, unit: "PT" } },
            },
            {
              run_id: "r1",
              text: " drives growth",
              style_role: "emphasis",
              text_style: {
                fontSize: { magnitude: 22, unit: "PT" },
                bold: true,
              },
            },
          ],
        },
      ],
    }),
    translated_node: createTranslatedNode({
      node_id: "es-mixed-arr",
      paragraphs: [
        {
          paragraph_id: "p0",
          translated_text: "ARR impulsa el crecimiento",
          bullet_behavior: "none",
        },
      ],
      segments: [
        {
          segment_id: "r0",
          translated_text: "ARR",
          style_role: "default",
        },
        {
          segment_id: "r1",
          translated_text: " impulsa el crecimiento",
          style_role: "emphasis",
        },
      ],
    }),
    style_expectation: { kind: "emphasis_roles" },
    term_expectations: [
      { key: "arr", expected_translation: "arr" },
    ],
  },
  {
    sample_id: "de-metric-arr",
    target_language: "de",
    source_node: createSourceNode({
      node_id: "de-metric-arr",
      slide_index: 3,
      archetype: "metric_card",
      object_id: "shape_de_metric",
      element_type: "shape",
      box: createBox(340, 108),
      paragraphs: [
        {
          paragraph_id: "p0",
          text: "68B ARR",
          runs: [
            {
              run_id: "r0",
              text: "68B",
              style_role: "metric_value",
              text_style: {
                fontSize: { magnitude: 28, unit: "PT" },
                bold: true,
              },
            },
            {
              run_id: "r1",
              text: " ARR",
              style_role: "metric_unit",
              text_style: { fontSize: { magnitude: 14, unit: "PT" } },
            },
          ],
        },
      ],
    }),
    translated_node: createTranslatedNode({
      node_id: "de-metric-arr",
      paragraphs: [
        {
          paragraph_id: "p0",
          translated_text: "68 Mrd. $ ARR",
          bullet_behavior: "none",
        },
      ],
      segments: [
        {
          segment_id: "r0",
          translated_text: "68 Mrd. $",
          style_role: "metric_value",
        },
        {
          segment_id: "r1",
          translated_text: " ARR",
          style_role: "metric_unit",
        },
      ],
    }),
    style_expectation: { kind: "metric_hierarchy" },
    term_expectations: [
      { key: "arr", expected_translation: "arr" },
    ],
  },
  {
    sample_id: "de-bullet-arr",
    target_language: "de",
    source_node: createSourceNode({
      node_id: "de-bullet-arr",
      slide_index: 4,
      archetype: "bullet_list",
      object_id: "shape_de_bullet",
      element_type: "shape",
      box: createBox(360, 132),
      paragraphs: [
        {
          paragraph_id: "p0",
          text: "ARR held steady",
          bullet_level: 0,
          runs: [
            {
              run_id: "r0",
              text: "ARR held steady",
              style_role: "default",
              text_style: { fontSize: { magnitude: 20, unit: "PT" } },
            },
          ],
        },
        {
          paragraph_id: "p1",
          text: "ARR beat forecast",
          bullet_level: 0,
          runs: [
            {
              run_id: "r1",
              text: "ARR beat forecast",
              style_role: "default",
              text_style: { fontSize: { magnitude: 20, unit: "PT" } },
            },
          ],
        },
      ],
    }),
    translated_node: createTranslatedNode({
      node_id: "de-bullet-arr",
      paragraphs: [
        {
          paragraph_id: "p0",
          translated_text: "ARR blieb stabil",
          bullet_behavior: "preserve",
        },
        {
          paragraph_id: "p1",
          translated_text: "ARR uebertraf die Prognose",
          bullet_behavior: "preserve",
        },
      ],
      segments: [
        {
          segment_id: "r0",
          translated_text: "ARR blieb stabil",
          style_role: "default",
        },
        {
          segment_id: "r1",
          translated_text: "ARR uebertraf die Prognose",
          style_role: "default",
        },
      ],
    }),
    term_expectations: [
      { key: "arr", expected_translation: "arr" },
    ],
  },
  {
    sample_id: "zh-hans-notes-arr",
    target_language: "zh-Hans",
    source_node: createSourceNode({
      node_id: "zh-hans-notes-arr",
      slide_index: 5,
      archetype: "speaker_notes",
      object_id: "notes_zh_hans",
      element_type: "speaker_notes",
      box: createBox(300, 120),
      paragraphs: [
        {
          paragraph_id: "p0",
          text: "Annual recurring revenue is now stable across the deck",
          runs: [
            {
              run_id: "r0",
              text: "Annual recurring revenue is now stable across the deck",
              style_role: "default",
              text_style: { fontSize: { magnitude: 16, unit: "PT" } },
            },
          ],
        },
      ],
    }),
    translated_node: createTranslatedNode({
      node_id: "zh-hans-notes-arr",
      paragraphs: [
        {
          paragraph_id: "p0",
          translated_text: "年度经常性收入现已在整份演示中保持稳定",
          bullet_behavior: "none",
        },
      ],
      segments: [
        {
          segment_id: "r0",
          translated_text: "年度经常性收入现已在整份演示中保持稳定",
          style_role: "default",
        },
      ],
    }),
    term_expectations: [{ key: "arr", expected_translation: "年度经常性收入" }],
  },
  {
    sample_id: "zh-hans-table-arr",
    target_language: "zh-Hans",
    source_node: createSourceNode({
      node_id: "zh-hans-table-arr",
      slide_index: 5,
      archetype: "table_cell",
      object_id: "table_zh_hans",
      element_type: "table_cell",
      box: createBox(180, 48),
      row_index: 1,
      col_index: 1,
      paragraphs: [
        {
          paragraph_id: "p0",
          text: "Annual recurring revenue",
          runs: [
            {
              run_id: "r0",
              text: "Annual recurring revenue",
              style_role: "default",
              text_style: { fontSize: { magnitude: 14, unit: "PT" } },
            },
          ],
        },
      ],
    }),
    translated_node: createTranslatedNode({
      node_id: "zh-hans-table-arr",
      paragraphs: [
        {
          paragraph_id: "p0",
          translated_text: "年度经常性收入",
          bullet_behavior: "none",
        },
      ],
      segments: [
        {
          segment_id: "r0",
          translated_text: "年度经常性收入",
          style_role: "default",
        },
      ],
    }),
    term_expectations: [{ key: "arr", expected_translation: "年度经常性收入" }],
  },
  {
    sample_id: "zh-hant-notes-arr",
    target_language: "zh-Hant",
    source_node: createSourceNode({
      node_id: "zh-hant-notes-arr",
      slide_index: 6,
      archetype: "speaker_notes",
      object_id: "notes_zh_hant",
      element_type: "speaker_notes",
      box: createBox(300, 120),
      paragraphs: [
        {
          paragraph_id: "p0",
          text: "Annual recurring revenue now anchors pricing",
          runs: [
            {
              run_id: "r0",
              text: "Annual recurring revenue now anchors pricing",
              style_role: "default",
              text_style: { fontSize: { magnitude: 16, unit: "PT" } },
            },
          ],
        },
      ],
    }),
    translated_node: createTranslatedNode({
      node_id: "zh-hant-notes-arr",
      paragraphs: [
        {
          paragraph_id: "p0",
          translated_text: "年度經常性收入現已成為定價錨點",
          bullet_behavior: "none",
        },
      ],
      segments: [
        {
          segment_id: "r0",
          translated_text: "年度經常性收入現已成為定價錨點",
          style_role: "default",
        },
      ],
    }),
    term_expectations: [{ key: "arr", expected_translation: "年度經常性收入" }],
  },
  {
    sample_id: "zh-hant-table-arr",
    target_language: "zh-Hant",
    source_node: createSourceNode({
      node_id: "zh-hant-table-arr",
      slide_index: 6,
      archetype: "table_cell",
      object_id: "table_zh_hant",
      element_type: "table_cell",
      box: createBox(180, 48),
      row_index: 2,
      col_index: 1,
      paragraphs: [
        {
          paragraph_id: "p0",
          text: "Annual recurring revenue",
          runs: [
            {
              run_id: "r0",
              text: "Annual recurring revenue",
              style_role: "default",
              text_style: { fontSize: { magnitude: 14, unit: "PT" } },
            },
          ],
        },
      ],
    }),
    translated_node: createTranslatedNode({
      node_id: "zh-hant-table-arr",
      paragraphs: [
        {
          paragraph_id: "p0",
          translated_text: "年度經常性收入",
          bullet_behavior: "none",
        },
      ],
      segments: [
        {
          segment_id: "r0",
          translated_text: "年度經常性收入",
          style_role: "default",
        },
      ],
    }),
    term_expectations: [{ key: "arr", expected_translation: "年度經常性收入" }],
  },
] as const;

export function evaluateRegressionBaseline(
  samples: readonly SlidesFidelityRegressionSample[]
): RegressionBaselineMetrics {
  let bulletCaseCount = 0;
  let styleCaseCount = 0;
  let termExpectationCount = 0;
  let emptyBulletCases = 0;
  let bulletCountErrors = 0;
  let paragraphCountErrors = 0;
  let obviousOverflowCases = 0;
  let styleRetentionFailures = 0;
  let majorManualReflowCases = 0;
  let consistentTermMatches = 0;

  for (const sample of samples) {
    const requests = __buildNodeWriteRequestsForTests({
      sourceNode: sample.source_node,
      translatedNode: sample.translated_node,
      objectId: sample.source_node.object_id,
    });
    const warnings = __buildNodeWarningsForTests({
      sourceNode: sample.source_node,
      translatedNode: sample.translated_node,
      objectId: sample.source_node.object_id,
    });
    const insertedText = requests.find((request) => request.insertText)?.insertText?.text ?? "";
    const insertedParagraphCount = countInsertedParagraphs(insertedText);
    const fit = fitTranslatedNode(sample.source_node, sample.translated_node);

    if (insertedParagraphCount !== sample.translated_node.paragraphs.length) {
      paragraphCountErrors += 1;
    }

    if (sample.source_node.archetype === "bullet_list") {
      bulletCaseCount += 1;

      if (insertedText.endsWith("\n")) {
        emptyBulletCases += 1;
      }

      const sourceBulletCount = sample.source_node.paragraphs.filter(
        (paragraph) => paragraph.bullet !== undefined
      ).length;
      const translatedBulletCount = sample.translated_node.paragraphs.filter(
        (paragraph) => paragraph.bullet_behavior === "preserve"
      ).length;
      if (sourceBulletCount !== translatedBulletCount) {
        bulletCountErrors += 1;
      }
    }

    if (warnings.some((warning) => warning.risk_reason === "possible_overflow")) {
      obviousOverflowCases += 1;
    }

    if (fit.risk === "high") {
      majorManualReflowCases += 1;
    }

    if (sample.style_expectation) {
      styleCaseCount += 1;
      if (!styleExpectationSatisfied(sample, requests)) {
        styleRetentionFailures += 1;
      }
    }

    for (const expectation of sample.term_expectations ?? []) {
      termExpectationCount += 1;
      if (
        containsNormalizedText(
          sample.translated_node.translated_full_text,
          expectation.expected_translation
        )
      ) {
        consistentTermMatches += 1;
      }
    }
  }

  return {
    sample_count: samples.length,
    bullet_case_count: bulletCaseCount,
    style_case_count: styleCaseCount,
    term_expectation_count: termExpectationCount,
    empty_bullet_generation_rate: rate(emptyBulletCases, bulletCaseCount),
    bullet_count_error_rate: rate(bulletCountErrors, bulletCaseCount),
    paragraph_count_error_rate: rate(paragraphCountErrors, samples.length),
    obvious_overflow_rate: rate(obviousOverflowCases, samples.length),
    style_hierarchy_retention_rate:
      styleCaseCount === 0 ? 1 : 1 - styleRetentionFailures / styleCaseCount,
    major_manual_reflow_rate: rate(majorManualReflowCases, samples.length),
    term_consistency_rate: termExpectationCount === 0 ? 1 : consistentTermMatches / termExpectationCount,
  };
}

function styleExpectationSatisfied(
  sample: SlidesFidelityRegressionSample,
  requests: ReturnType<typeof __buildNodeWriteRequestsForTests>
): boolean {
  const textStyleRequests = requests
    .filter((request) => request.updateTextStyle)
    .map((request) => request.updateTextStyle!);

  switch (sample.style_expectation?.kind) {
    case "metric_hierarchy": {
      const metricValueRunId = findRunIdByStyleRole(sample.source_node, "metric_value");
      const metricUnitRunId = findRunIdByStyleRole(sample.source_node, "metric_unit");
      if (!metricValueRunId || !metricUnitRunId) {
        return false;
      }

      const valueRequest = findTextStyleRequestForRunId(
        sample,
        textStyleRequests,
        metricValueRunId
      );
      const unitRequest = findTextStyleRequestForRunId(
        sample,
        textStyleRequests,
        metricUnitRunId
      );
      const sourceValueSize = getSourceRunFontSize(sample.source_node, "metric_value");
      const sourceUnitSize = getSourceRunFontSize(sample.source_node, "metric_unit");
      const valueSize = valueRequest?.style?.fontSize?.magnitude;
      const unitSize = unitRequest?.style?.fontSize?.magnitude;

      if (
        typeof sourceValueSize !== "number" ||
        typeof sourceUnitSize !== "number" ||
        typeof valueSize !== "number" ||
        typeof unitSize !== "number"
      ) {
        return false;
      }

      const sourceRatio = sourceValueSize / sourceUnitSize;
      const fittedRatio = valueSize / unitSize;
      return valueSize > unitSize && Math.abs(sourceRatio - fittedRatio) <= 0.15;
    }

    case "emphasis_roles": {
      const defaultRunId = findRunIdByStyleRole(sample.source_node, "default");
      const emphasisRunId = findRunIdByStyleRole(sample.source_node, "emphasis");
      if (!defaultRunId || !emphasisRunId) {
        return false;
      }

      const defaultRequest = findTextStyleRequestForRunId(
        sample,
        textStyleRequests,
        defaultRunId
      );
      const emphasisRequest = findTextStyleRequestForRunId(
        sample,
        textStyleRequests,
        emphasisRunId
      );
      return (
        emphasisRequest !== undefined &&
        emphasisRequest?.style?.bold === true &&
        emphasisRequest.textRange?.startIndex !== emphasisRequest.textRange?.endIndex &&
        defaultRequest?.style?.bold !== true
      );
    }

    default:
      return true;
  }
}

function getSourceRunFontSize(
  sourceNode: SlideTextNode,
  styleRole: SlideRunStyleRole
): number | undefined {
  for (const paragraph of sourceNode.paragraphs) {
    for (const run of paragraph.runs) {
      if (run.style_role === styleRole) {
        return run.text_style.fontSize?.magnitude ?? undefined;
      }
    }
  }
  return undefined;
}

function countInsertedParagraphs(insertedText: string): number {
  if (insertedText.length === 0) {
    return 0;
  }

  const normalized = insertedText.endsWith("\n")
    ? insertedText.slice(0, -1)
    : insertedText;
  return normalized.split("\n").length;
}

function containsNormalizedText(text: string, expected: string): boolean {
  const normalizedText = text.toLocaleLowerCase();
  const normalizedExpected = expected.toLocaleLowerCase();

  if (isLatinWordExpectation(normalizedExpected)) {
    const escaped = escapeRegExp(normalizedExpected);
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(normalizedText);
  }

  return normalizedText.includes(normalizedExpected);
}

function rate(numerator: number, denominator: number): number {
  if (denominator === 0) {
    return 0;
  }

  return numerator / denominator;
}

function findRunIdByStyleRole(
  sourceNode: SlideTextNode,
  styleRole: SlideRunStyleRole
): string | undefined {
  for (const paragraph of sourceNode.paragraphs) {
    for (const run of paragraph.runs) {
      if (run.style_role === styleRole) {
        return run.run_id;
      }
    }
  }

  return undefined;
}

function findTextStyleRequestForRunId(
  sample: SlidesFidelityRegressionSample,
  textStyleRequests: Array<
    NonNullable<ReturnType<typeof __buildNodeWriteRequestsForTests>[number]["updateTextStyle"]>
  >,
  runId: string
):
  | NonNullable<ReturnType<typeof __buildNodeWriteRequestsForTests>[number]["updateTextStyle"]>
  | undefined {
  const range = buildExpectedSegmentRangeByRunId(sample).get(runId);
  if (!range) {
    return undefined;
  }

  return textStyleRequests.find(
    (request) =>
      request.textRange?.startIndex === range.start &&
      request.textRange?.endIndex === range.end
  );
}

function buildExpectedSegmentRangeByRunId(
  sample: SlidesFidelityRegressionSample
): Map<string, { start: number; end: number }> {
  const translatedParagraphById = new Map(
    sample.translated_node.paragraphs.map((paragraph) => [paragraph.paragraph_id, paragraph] as const)
  );
  const translatedSegmentById = new Map(
    sample.translated_node.segments.map((segment) => [segment.segment_id, segment] as const)
  );
  const rangeByRunId = new Map<string, { start: number; end: number }>();
  let insertionCursor = 0;

  for (let index = 0; index < sample.source_node.paragraphs.length; index += 1) {
    const sourceParagraph = sample.source_node.paragraphs[index];
    const translatedParagraph = translatedParagraphById.get(sourceParagraph.paragraph_id);
    if (!translatedParagraph) {
      throw new Error(
        `Regression sample "${sample.sample_id}" is missing paragraph "${sourceParagraph.paragraph_id}"`
      );
    }

    if (index > 0) {
      insertionCursor += 1;
    }

    const bulletPrefixLength =
      translatedParagraph.bullet_behavior === "preserve"
        ? sourceParagraph.bullet?.nesting_level ?? 0
        : 0;
    let segmentCursor = insertionCursor + bulletPrefixLength;

    for (const sourceRun of sourceParagraph.runs) {
      const translatedSegment = translatedSegmentById.get(sourceRun.run_id);
      if (!translatedSegment) {
        throw new Error(
          `Regression sample "${sample.sample_id}" is missing segment "${sourceRun.run_id}"`
        );
      }

      const start = segmentCursor;
      segmentCursor += translatedSegment.translated_text.length;
      rangeByRunId.set(sourceRun.run_id, { start, end: segmentCursor });
    }

    insertionCursor += bulletPrefixLength + translatedParagraph.translated_text.length;
  }

  return rangeByRunId;
}

function isLatinWordExpectation(expected: string): boolean {
  return /^[a-z0-9]+(?:[ _-][a-z0-9]+)*$/i.test(expected);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function __countInsertedParagraphsForTests(insertedText: string): number {
  return countInsertedParagraphs(insertedText);
}

export function __containsNormalizedTextForTests(text: string, expected: string): boolean {
  return containsNormalizedText(text, expected);
}

export function __styleExpectationSatisfiedForTests(
  sample: SlidesFidelityRegressionSample,
  requests: ReturnType<typeof __buildNodeWriteRequestsForTests>
): boolean {
  return styleExpectationSatisfied(sample, requests);
}

function createSourceNode(input: SourceNodeInput): SlideTextNode {
  const paragraphs: SlideParagraph[] = [];
  const fullTextParts: string[] = [];
  let cursor = 0;

  for (let index = 0; index < input.paragraphs.length; index += 1) {
    const paragraphInput = input.paragraphs[index];
    const paragraphStart = cursor;
    const paragraphEnd = paragraphStart + paragraphInput.text.length;
    const runs = paragraphInput.runs.map((run) => {
      const previousText = paragraphInput.runs
        .slice(0, paragraphInput.runs.indexOf(run))
        .map((entry) => entry.text)
        .join("");
      const runStart = paragraphStart + previousText.length;
      const runEnd = runStart + run.text.length;
      return {
        run_id: run.run_id,
        text: run.text,
        start_index: runStart,
        end_index: runEnd,
        style_role: run.style_role,
        text_style: structuredClone(run.text_style),
      };
    });

    paragraphs.push({
      paragraph_id: paragraphInput.paragraph_id,
      text: paragraphInput.text,
      start_index: paragraphStart,
      end_index: paragraphEnd,
      bullet:
        typeof paragraphInput.bullet_level === "number"
          ? { nesting_level: paragraphInput.bullet_level }
          : undefined,
      paragraph_style: {},
      runs,
    });

    fullTextParts.push(paragraphInput.text);
    cursor = paragraphEnd + (index < input.paragraphs.length - 1 ? 1 : 0);
  }

  const fullText = fullTextParts.join("\n");
  return {
    node_id: input.node_id,
    text: fullText,
    full_text: fullText,
    slide_index: input.slide_index,
    element_type: input.element_type,
    archetype: input.archetype,
    object_id: input.object_id,
    box: input.box,
    paragraphs,
    row_index: input.row_index,
    col_index: input.col_index,
  };
}

function createTranslatedNode(input: {
  readonly node_id: string;
  readonly paragraphs: readonly TranslatedParagraphInput[];
  readonly segments: readonly TranslatedSegmentInput[];
}): TranslatedNode {
  return {
    node_id: input.node_id,
    translated_full_text: input.paragraphs.map((paragraph) => paragraph.translated_text).join("\n"),
    paragraphs: input.paragraphs.map((paragraph) => ({
      paragraph_id: paragraph.paragraph_id,
      translated_text: paragraph.translated_text,
      bullet_behavior: paragraph.bullet_behavior,
    })),
    segments: input.segments.map((segment) => ({
      segment_id: segment.segment_id,
      translated_text: segment.translated_text,
      style_role: segment.style_role,
    })),
  };
}

function createBox(widthPt: number, heightPt: number): SlideTextNode["box"] {
  return {
    width_emu: widthPt * 12700,
    height_emu: heightPt * 12700,
    translate_x_emu: 0,
    translate_y_emu: 0,
    rotation_deg: 0,
  };
}
