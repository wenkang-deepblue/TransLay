import type { slides_v1 } from "googleapis";
import {
  type JobWarning,
  type JobWarningReason,
  type JobWarningRiskLevel,
  type TranslatedNode,
} from "@translay/shared-contracts";
import type { SlideTextNode, SlideExtractionResult } from "./types";
import { getSlidesClient } from "./auth";
import {
  type FitPassResult,
  applyFitToParagraphStyle,
  applyFitToTextStyle,
  fitTranslatedNode,
  resolveSlideNodeFits,
} from "./fit-pass";

interface SlideDuplicatePlan {
  readonly sourceSlide: slides_v1.Schema$Page;
  readonly extractedSlide: SlideExtractionResult;
  readonly newSlideId: string;
  readonly objectIds: Record<string, string>;
}

interface NodeWriteRequestParams {
  readonly sourceNode: SlideTextNode;
  readonly translatedNode: TranslatedNode;
  readonly objectId: string;
  readonly cellLocation?: slides_v1.Schema$TableCellLocation;
  readonly fit?: FitPassResult;
}

export interface WriteBackResult {
  readonly outputUrl: string;
  readonly committedUnits: number;
  readonly warnings: readonly JobWarning[];
}

interface ReplacePlan {
  readonly requests: slides_v1.Schema$Request[];
  readonly warnings: JobWarning[];
}

interface NodeWriteArtifacts {
  readonly requests: slides_v1.Schema$Request[];
  readonly warnings: JobWarning[];
}

interface ParagraphWritePlan {
  readonly sourceParagraph: SlideTextNode["paragraphs"][number];
  readonly translatedParagraph: TranslatedNode["paragraphs"][number];
  readonly insertionStart: number;
  readonly insertionEnd: number;
  readonly styleRangeStart: number;
  readonly styleRangeEnd: number;
  readonly needsBullet: boolean;
  readonly bulletGlyph?: string;
}

interface SegmentWritePlan {
  readonly sourceRun: SlideTextNode["paragraphs"][number]["runs"][number];
  readonly translatedSegment: TranslatedNode["segments"][number];
  readonly start: number;
  readonly end: number;
}

interface BulletRangePlan {
  readonly start: number;
  readonly end: number;
  readonly glyph?: string;
}

interface RichTextWritePlan {
  readonly insertedText: string;
  readonly paragraphPlans: readonly ParagraphWritePlan[];
  readonly segmentPlans: readonly SegmentWritePlan[];
  readonly bulletRanges: readonly BulletRangePlan[];
}

const DEFAULT_BULLET_PRESET = "BULLET_DISC_CIRCLE_SQUARE";

export async function writeBackAppend(
  presentationId: string,
  extractedSlides: SlideExtractionResult[],
  translatedNodes: readonly TranslatedNode[],
  onCommitted?: (result: WriteBackResult) => Promise<void>
): Promise<WriteBackResult> {
  const { slides } = getSlidesClient();
  const translationMap = buildTranslationMap(translatedNodes);
  const outputUrl = `https://docs.google.com/presentation/d/${presentationId}/edit`;
  const warnings: JobWarning[] = [];

  if (extractedSlides.length === 0) {
    return { outputUrl, committedUnits: 0, warnings };
  }

  const pres = await slides.presentations.get({ presentationId });
  const allSlides = pres.data.slides ?? [];
  const sortedSlides = [...extractedSlides].sort(
    (a, b) => b.slide_index - a.slide_index
  );
  const duplicatePrefix = buildExecutionPrefix();

  const plans: SlideDuplicatePlan[] = [];
  for (const extracted of sortedSlides) {
    const sourceSlide = allSlides[extracted.slide_index];
    if (!sourceSlide?.objectId) {
      throw new Error(`Source slide ${extracted.slide_index} is missing an object ID`);
    }

    plans.push({
      sourceSlide,
      extractedSlide: extracted,
      newSlideId: buildDuplicateId(duplicatePrefix, extracted.slide_index, "slide"),
      objectIds: buildDuplicateObjectIds(
        sourceSlide,
        extracted.slide_index,
        duplicatePrefix
      ),
    });
  }

  let committedUnits = 0;
  for (const plan of plans) {
    let duplicated = false;
    try {
      await slides.presentations.batchUpdate({
        presentationId,
        requestBody: {
          requests: [
            {
              duplicateObject: {
                objectId: plan.sourceSlide.objectId!,
                objectIds: plan.objectIds,
              },
            },
            {
              updateSlidesPosition: {
                slideObjectIds: [plan.newSlideId],
                insertionIndex: plan.extractedSlide.slide_index + 1,
              },
            },
          ],
        },
      });
      duplicated = true;

      const replacePlan = buildReplacePlan(
        plan.sourceSlide,
        plan.extractedSlide.nodes,
        translationMap,
        (sourceObjectId) => plan.objectIds[sourceObjectId] ?? sourceObjectId
      );

      if (replacePlan.requests.length > 0) {
        await slides.presentations.batchUpdate({
          presentationId,
          requestBody: { requests: replacePlan.requests },
        });
      }

      warnings.push(...replacePlan.warnings);

      committedUnits += 1;
      if (onCommitted) {
        await onCommitted({ outputUrl, committedUnits, warnings });
      }
    } catch (err) {
      if (duplicated) {
        await cleanupDuplicatedSlides(slides, presentationId, [plan.newSlideId]);
      }
      throw err;
    }
  }

  return { outputUrl, committedUnits, warnings };
}

export async function writeBackNewFile(
  targetPresentationId: string,
  extractedSlides: SlideExtractionResult[],
  translatedNodes: readonly TranslatedNode[],
  onCommitted?: (result: WriteBackResult) => Promise<void>
): Promise<WriteBackResult> {
  const { slides } = getSlidesClient();
  const translationMap = buildTranslationMap(translatedNodes);
  const outputUrl = `https://docs.google.com/presentation/d/${targetPresentationId}/edit`;
  const warnings: JobWarning[] = [];
  if (extractedSlides.length === 0) {
    return { outputUrl, committedUnits: 0, warnings };
  }

  const newPres = await slides.presentations.get({
    presentationId: targetPresentationId,
  });
  const newSlides = newPres.data.slides ?? [];

  let committedUnits = 0;
  for (const extracted of extractedSlides) {
    const slide = newSlides[extracted.slide_index];
    if (!slide) {
      throw new Error(`Copied slide ${extracted.slide_index} is missing`);
    }

    const replacePlan = buildReplacePlan(
      slide,
      extracted.nodes,
      translationMap,
      (sourceObjectId) => sourceObjectId
    );

    if (replacePlan.requests.length > 0) {
      await slides.presentations.batchUpdate({
        presentationId: targetPresentationId,
        requestBody: { requests: replacePlan.requests },
      });
    }

    warnings.push(...replacePlan.warnings);

    committedUnits += 1;
    if (onCommitted) {
      await onCommitted({ outputUrl, committedUnits, warnings });
    }
  }

  return { outputUrl, committedUnits, warnings };
}

function buildTranslationMap(
  translatedNodes: readonly TranslatedNode[]
): Map<string, TranslatedNode> {
  const map = new Map<string, TranslatedNode>();
  for (const node of translatedNodes) {
    map.set(node.node_id, node);
  }
  return map;
}

function buildDuplicateObjectIds(
  slide: slides_v1.Schema$Page,
  slideIndex: number,
  duplicatePrefix: string
): Record<string, string> {
  const objectIds: Record<string, string> = {
    [slide.objectId!]: buildDuplicateId(duplicatePrefix, slideIndex, "slide"),
  };

  let pageElementCounter = 0;
  let notesCounter = 0;

  collectPageElementObjectIds(
    slide.pageElements ?? [],
    (objectId) => {
      objectIds[objectId] = buildDuplicateId(
        duplicatePrefix,
        slideIndex,
        `pe${pageElementCounter}`
      );
      pageElementCounter += 1;
    }
  );

  collectPageElementObjectIds(
    slide.slideProperties?.notesPage?.pageElements ?? [],
    (objectId) => {
      objectIds[objectId] = buildDuplicateId(
        duplicatePrefix,
        slideIndex,
        `note${notesCounter}`
      );
      notesCounter += 1;
    }
  );

  return objectIds;
}

function collectPageElementObjectIds(
  elements: readonly slides_v1.Schema$PageElement[],
  onObjectId: (objectId: string) => void
): void {
  for (const element of elements) {
    if (element.objectId) {
      onObjectId(element.objectId);
    }
    if (element.elementGroup?.children) {
      collectPageElementObjectIds(element.elementGroup.children, onObjectId);
    }
  }
}

function buildDuplicateId(
  duplicatePrefix: string,
  slideIndex: number,
  suffix: string
): string {
  return `tl_${duplicatePrefix}_s${slideIndex}_${suffix}`;
}

function buildExecutionPrefix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function buildReplacePlan(
  slide: slides_v1.Schema$Page,
  originalNodes: SlideTextNode[],
  translationMap: Map<string, TranslatedNode>,
  resolveObjectId: (sourceObjectId: string) => string
): ReplacePlan {
  const requests: slides_v1.Schema$Request[] = [];
  const warnings: JobWarning[] = [];
  const fitByNodeId = resolveSlideNodeFits(
    originalNodes,
    originalNodes
      .map((node) => translationMap.get(node.node_id))
      .filter((translatedNode): translatedNode is TranslatedNode => Boolean(translatedNode))
  );

  for (const node of originalNodes) {
    const translated = translationMap.get(node.node_id);
    if (translated === undefined) {
      continue;
    }

    const resolvedObjectId = resolveObjectId(node.object_id);
    if (!resolvedObjectId) {
      continue;
    }

    if (node.element_type === "speaker_notes") {
      const notesShape = findSpeakerNotesBody(slide, node.object_id);
      if (!notesShape?.shape?.text) {
        continue;
      }

      const artifacts = buildNodeWriteArtifacts({
        sourceNode: node,
        translatedNode: translated,
        objectId: resolvedObjectId,
        fit: fitByNodeId.get(node.node_id),
      });
      requests.push(...artifacts.requests);
      warnings.push(...artifacts.warnings);
      continue;
    }

    if (node.element_type === "table_cell") {
      const tableElement = findElement(slide, node.object_id);
      const tableCell =
        tableElement?.table?.tableRows?.[node.row_index ?? 0]?.tableCells?.[
          node.col_index ?? 0
        ];
      if (!tableCell?.text) {
        continue;
      }

      const artifacts = buildNodeWriteArtifacts({
        sourceNode: node,
        translatedNode: translated,
        objectId: resolvedObjectId,
        cellLocation: {
          rowIndex: node.row_index ?? 0,
          columnIndex: node.col_index ?? 0,
        },
        fit: fitByNodeId.get(node.node_id),
      });
      requests.push(...artifacts.requests);
      warnings.push(...artifacts.warnings);
      continue;
    }

    const element = findElement(slide, node.object_id);
    if (!element?.shape?.text) {
      continue;
    }

    const artifacts = buildNodeWriteArtifacts({
      sourceNode: node,
      translatedNode: translated,
      objectId: resolvedObjectId,
      fit: fitByNodeId.get(node.node_id),
    });
    requests.push(...artifacts.requests);
    warnings.push(...artifacts.warnings);
  }

  return { requests, warnings };
}

function buildNodeWriteRequests(
  params: NodeWriteRequestParams
): slides_v1.Schema$Request[] {
  return buildNodeWriteArtifacts(params).requests;
}

function buildNodeWriteArtifacts(
  params: NodeWriteRequestParams
): NodeWriteArtifacts {
  const plan = buildRichTextWritePlan(params.sourceNode, params.translatedNode);
  const fit = params.fit ?? fitTranslatedNode(params.sourceNode, params.translatedNode);
  const warnings = buildNodeWarnings(params.sourceNode, params.translatedNode, fit);
  const requests: slides_v1.Schema$Request[] = [
    {
      deleteText: {
        objectId: params.objectId,
        cellLocation: params.cellLocation,
        textRange: { type: "ALL" },
      },
    },
  ];

  if (plan.insertedText.length > 0) {
    requests.push({
      insertText: {
        objectId: params.objectId,
        cellLocation: params.cellLocation,
        text: plan.insertedText,
        insertionIndex: 0,
      },
    });

    for (const bulletRange of plan.bulletRanges) {
      requests.push({
        createParagraphBullets: {
          objectId: params.objectId,
          cellLocation: params.cellLocation,
          bulletPreset: inferBulletPreset(bulletRange.glyph),
          textRange: {
            type: "FIXED_RANGE",
            startIndex: bulletRange.start,
            endIndex: bulletRange.end,
          },
        },
      });
    }

    for (const paragraphPlan of plan.paragraphPlans) {
      if (Object.keys(paragraphPlan.sourceParagraph.paragraph_style).length === 0) {
        continue;
      }

      requests.push({
        updateParagraphStyle: {
          objectId: params.objectId,
          cellLocation: params.cellLocation,
          style: applyFitToParagraphStyle(paragraphPlan.sourceParagraph.paragraph_style, fit),
          fields: "*",
          textRange: {
            type: "FIXED_RANGE",
            startIndex: paragraphPlan.styleRangeStart,
            endIndex: paragraphPlan.styleRangeEnd,
          },
        },
      });
    }

    for (const segmentPlan of plan.segmentPlans) {
      if (Object.keys(segmentPlan.sourceRun.text_style).length === 0) {
        continue;
      }
      if (segmentPlan.start === segmentPlan.end) {
        continue;
      }

      requests.push({
        updateTextStyle: {
          objectId: params.objectId,
          cellLocation: params.cellLocation,
          style: applyFitToTextStyle(
            segmentPlan.sourceRun.text_style,
            fit,
            getFallbackFontSizeForRun(params.sourceNode, segmentPlan.sourceRun.run_id)
          ),
          fields: "*",
          textRange: {
            type: "FIXED_RANGE",
            startIndex: segmentPlan.start,
            endIndex: segmentPlan.end,
          },
        },
      });
    }
  }

  return { requests, warnings };
}

export function __buildNodeWriteRequestsForTests(
  params: NodeWriteRequestParams
): slides_v1.Schema$Request[] {
  return buildNodeWriteRequests(params);
}

export function __buildNodeWarningsForTests(
  params: NodeWriteRequestParams
): readonly JobWarning[] {
  return buildNodeWriteArtifacts(params).warnings;
}

function buildRichTextWritePlan(
  sourceNode: SlideTextNode,
  translatedNode: TranslatedNode
): RichTextWritePlan {
  const translatedParagraphById = new Map(
    translatedNode.paragraphs.map((paragraph) => [paragraph.paragraph_id, paragraph] as const)
  );
  const translatedSegmentById = new Map(
    translatedNode.segments.map((segment) => [segment.segment_id, segment] as const)
  );
  const consumedParagraphIds = new Set<string>();
  const consumedSegmentIds = new Set<string>();
  const paragraphPlans: ParagraphWritePlan[] = [];
  const segmentPlans: SegmentWritePlan[] = [];
  let insertedText = "";
  let insertionCursor = 0;

  for (let index = 0; index < sourceNode.paragraphs.length; index += 1) {
    const sourceParagraph = sourceNode.paragraphs[index];
    const translatedParagraph = translatedParagraphById.get(sourceParagraph.paragraph_id);
    if (!translatedParagraph) {
      throw new Error(
        `Translated node "${translatedNode.node_id}" is missing paragraph "${sourceParagraph.paragraph_id}"`
      );
    }

    consumedParagraphIds.add(sourceParagraph.paragraph_id);

    if (index > 0) {
      insertedText += "\n";
      insertionCursor += 1;
    }

    const needsBullet = translatedParagraph.bullet_behavior === "preserve";
    const bulletPrefix = needsBullet
      ? "\t".repeat(sourceParagraph.bullet?.nesting_level ?? 0)
      : "";
    const insertionStart = insertionCursor;
    insertedText += bulletPrefix + translatedParagraph.translated_text;
    insertionCursor += bulletPrefix.length + translatedParagraph.translated_text.length;
    const insertionEnd = insertionCursor;

    const styleRangeStart = insertionStart + bulletPrefix.length;
    const styleRangeEnd = insertionEnd;

    let segmentCursor = styleRangeStart;
    for (const sourceRun of sourceParagraph.runs) {
      const translatedSegment = translatedSegmentById.get(sourceRun.run_id);
      if (!translatedSegment) {
        throw new Error(
          `Translated node "${translatedNode.node_id}" is missing segment "${sourceRun.run_id}"`
        );
      }

      consumedSegmentIds.add(sourceRun.run_id);
      const start = segmentCursor;
      segmentCursor += translatedSegment.translated_text.length;
      const end = segmentCursor;
      segmentPlans.push({
        sourceRun,
        translatedSegment,
        start,
        end,
      });
    }

    if (segmentCursor !== styleRangeEnd) {
      throw new Error(
        `Translated paragraph "${translatedParagraph.paragraph_id}" does not match its segment reconstruction`
      );
    }

    paragraphPlans.push({
      sourceParagraph,
      translatedParagraph,
      insertionStart,
      insertionEnd,
      styleRangeStart,
      styleRangeEnd,
      needsBullet,
      bulletGlyph: sourceParagraph.bullet?.glyph,
    });
  }

  if (consumedParagraphIds.size !== translatedNode.paragraphs.length) {
    throw new Error(
      `Translated node "${translatedNode.node_id}" contains unexpected paragraphs for writer rebuild`
    );
  }

  if (consumedSegmentIds.size !== translatedNode.segments.length) {
    throw new Error(
      `Translated node "${translatedNode.node_id}" contains unexpected segments for writer rebuild`
    );
  }

  if (paragraphPlans.map((plan) => plan.translatedParagraph.translated_text).join("\n") !== translatedNode.translated_full_text) {
    throw new Error(
      `Translated node "${translatedNode.node_id}" full text does not match paragraph reconstruction`
    );
  }

  return {
    insertedText,
    paragraphPlans,
    segmentPlans,
    bulletRanges: buildBulletRanges(paragraphPlans),
  };
}

function buildBulletRanges(
  paragraphPlans: readonly ParagraphWritePlan[]
): BulletRangePlan[] {
  const ranges: BulletRangePlan[] = [];
  let activeRange: BulletRangePlan | null = null;

  for (const paragraphPlan of paragraphPlans) {
    if (!paragraphPlan.needsBullet) {
      if (activeRange) {
        ranges.push(activeRange);
        activeRange = null;
      }
      continue;
    }

    if (!activeRange) {
      activeRange = {
        start: paragraphPlan.insertionStart,
        end: paragraphPlan.insertionEnd,
        glyph: paragraphPlan.bulletGlyph,
      };
      continue;
    }

    activeRange = {
      start: activeRange.start,
      end: paragraphPlan.insertionEnd,
      glyph: activeRange.glyph ?? paragraphPlan.bulletGlyph,
    };
  }

  if (activeRange) {
    ranges.push(activeRange);
  }

  return ranges;
}

function inferBulletPreset(glyph?: string): string {
  const normalized = glyph?.trim();
  if (!normalized) {
    return DEFAULT_BULLET_PRESET;
  }

  if (/^\d/.test(normalized)) {
    return "NUMBERED_DIGIT_ALPHA_ROMAN";
  }

  if (/^[A-Za-z]/.test(normalized)) {
    return "NUMBERED_UPPERALPHA_ALPHA_ROMAN";
  }

  return DEFAULT_BULLET_PRESET;
}

const KNOWN_JOB_WARNING_REASONS = new Set<JobWarningReason>([
  "possible_overflow",
  "mixed_style_alignment_low_confidence",
  "bullet_structure_rebuilt_with_compaction",
  "single_line_policy_degraded",
  "layout_semantics_fallback_applied",
  "manual_review_recommended",
]);

function buildNodeWarnings(
  sourceNode: SlideTextNode,
  translatedNode: TranslatedNode,
  fit: ReturnType<typeof fitTranslatedNode>
): JobWarning[] {
  const reasons: JobWarningReason[] = [];
  const pushReason = (reason: JobWarningReason) => {
    if (!reasons.includes(reason)) {
      reasons.push(reason);
    }
  };

  if (fit.risk !== "low") {
    pushReason("manual_review_recommended");
  }

  if (fit.risk === "high") {
    pushReason("possible_overflow");
  }

  if (fit.degradedSingleLine) {
    pushReason("single_line_policy_degraded");
  }

  if (fit.usedFallbackLayoutHint) {
    pushReason("layout_semantics_fallback_applied");
  }

  if (sourceNode.archetype === "bullet_list" && fit.applyTighterParagraphSpacing) {
    pushReason("bullet_structure_rebuilt_with_compaction");
  }

  for (const riskFlag of translatedNode.risk_flags ?? []) {
    if (KNOWN_JOB_WARNING_REASONS.has(riskFlag as JobWarningReason)) {
      pushReason(riskFlag as JobWarningReason);
    }
  }

  return reasons.map((risk_reason) => ({
    node_id: sourceNode.node_id,
    slide_index: sourceNode.slide_index,
    archetype: sourceNode.archetype,
    risk_level: resolveWarningRiskLevel(fit.risk, risk_reason),
    risk_reason,
  }));
}

function resolveWarningRiskLevel(
  fitRisk: ReturnType<typeof fitTranslatedNode>["risk"],
  riskReason: JobWarningReason
): JobWarningRiskLevel {
  if (fitRisk === "high" || riskReason === "possible_overflow") {
    return "high";
  }

  return "medium";
}

function getFallbackFontSizeForRun(
  sourceNode: SlideTextNode,
  runId: string
): number | undefined {
  let maxFontSize: number | undefined;

  for (const paragraph of sourceNode.paragraphs) {
    for (const run of paragraph.runs) {
      const magnitude = run.text_style.fontSize?.magnitude;
      if (typeof magnitude === "number") {
        maxFontSize = maxFontSize === undefined ? magnitude : Math.max(maxFontSize, magnitude);
      }

      if (run.run_id === runId && typeof magnitude === "number") {
        return magnitude;
      }
    }
  }

  if (
    maxFontSize === undefined &&
    typeof sourceNode.visible_style?.max_font_size_pt === "number" &&
    sourceNode.visible_style.max_font_size_pt > 0
  ) {
    return sourceNode.visible_style.max_font_size_pt;
  }

  return maxFontSize;
}

function findElement(
  slide: slides_v1.Schema$Page,
  objectId: string
): slides_v1.Schema$PageElement | null {
  return findElementInCollection(slide.pageElements ?? [], objectId);
}

function findElementInCollection(
  elements: readonly slides_v1.Schema$PageElement[],
  objectId: string
): slides_v1.Schema$PageElement | null {
  for (const element of elements) {
    if (element.objectId === objectId) {
      return element;
    }
    if (element.elementGroup?.children) {
      const childMatch = findElementInCollection(element.elementGroup.children, objectId);
      if (childMatch) {
        return childMatch;
      }
    }
  }
  return null;
}

function findSpeakerNotesBody(
  slide: slides_v1.Schema$Page,
  objectId: string
): slides_v1.Schema$PageElement | null {
  const notesPage = slide.slideProperties?.notesPage;
  if (!notesPage) {
    return null;
  }

  const element = findElementInCollection(notesPage.pageElements ?? [], objectId);
  if (
    element?.objectId === objectId &&
    element.shape?.text &&
    element.shape.placeholder?.type === "BODY"
  ) {
    return element;
  }

  return null;
}

async function cleanupDuplicatedSlides(
  slides: ReturnType<typeof getSlidesClient>["slides"],
  presentationId: string,
  slideObjectIds: readonly string[]
): Promise<void> {
  if (slideObjectIds.length === 0) {
    return;
  }

  await slides.presentations.batchUpdate({
    presentationId,
    requestBody: {
      requests: slideObjectIds.map((objectId) => ({
        deleteObject: { objectId },
      })),
    },
  }).catch(() => undefined);
}
