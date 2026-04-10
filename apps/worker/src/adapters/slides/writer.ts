import type { slides_v1 } from "googleapis";
import type { TranslatedNode } from "@translay/shared-contracts";
import type { SlideTextNode, SlideExtractionResult } from "./types";
import { getSlidesClient } from "./auth";

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
}

export interface WriteBackResult {
  readonly outputUrl: string;
  readonly committedUnits: number;
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

  if (extractedSlides.length === 0) {
    return { outputUrl, committedUnits: 0 };
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

      const replaceRequests = buildReplaceRequests(
        plan.sourceSlide,
        plan.extractedSlide.nodes,
        translationMap,
        (sourceObjectId) => plan.objectIds[sourceObjectId] ?? sourceObjectId
      );

      if (replaceRequests.length > 0) {
        await slides.presentations.batchUpdate({
          presentationId,
          requestBody: { requests: replaceRequests },
        });
      }

      committedUnits += 1;
      if (onCommitted) {
        await onCommitted({ outputUrl, committedUnits });
      }
    } catch (err) {
      if (duplicated) {
        await cleanupDuplicatedSlides(slides, presentationId, [plan.newSlideId]);
      }
      throw err;
    }
  }

  return { outputUrl, committedUnits };
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
  if (extractedSlides.length === 0) {
    return { outputUrl, committedUnits: 0 };
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

    const replaceRequests = buildReplaceRequests(
      slide,
      extracted.nodes,
      translationMap,
      (sourceObjectId) => sourceObjectId
    );

    if (replaceRequests.length > 0) {
      await slides.presentations.batchUpdate({
        presentationId: targetPresentationId,
        requestBody: { requests: replaceRequests },
      });
    }

    committedUnits += 1;
    if (onCommitted) {
      await onCommitted({ outputUrl, committedUnits });
    }
  }

  return { outputUrl, committedUnits };
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

function buildReplaceRequests(
  slide: slides_v1.Schema$Page,
  originalNodes: SlideTextNode[],
  translationMap: Map<string, TranslatedNode>,
  resolveObjectId: (sourceObjectId: string) => string
): slides_v1.Schema$Request[] {
  const requests: slides_v1.Schema$Request[] = [];

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

      requests.push(
        ...buildNodeWriteRequests({
          sourceNode: node,
          translatedNode: translated,
          objectId: resolvedObjectId,
        })
      );
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

      requests.push(
        ...buildNodeWriteRequests({
          sourceNode: node,
          translatedNode: translated,
          objectId: resolvedObjectId,
          cellLocation: {
            rowIndex: node.row_index ?? 0,
            columnIndex: node.col_index ?? 0,
          },
        })
      );
      continue;
    }

    const element = findElement(slide, node.object_id);
    if (!element?.shape?.text) {
      continue;
    }

    requests.push(
      ...buildNodeWriteRequests({
        sourceNode: node,
        translatedNode: translated,
        objectId: resolvedObjectId,
      })
    );
  }

  return requests;
}

function buildNodeWriteRequests(
  params: NodeWriteRequestParams
): slides_v1.Schema$Request[] {
  const plan = buildRichTextWritePlan(params.sourceNode, params.translatedNode);
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
          style: structuredClone(paragraphPlan.sourceParagraph.paragraph_style),
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

      requests.push({
        updateTextStyle: {
          objectId: params.objectId,
          cellLocation: params.cellLocation,
          style: structuredClone(segmentPlan.sourceRun.text_style),
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

  return requests;
}

export function __buildNodeWriteRequestsForTests(
  params: NodeWriteRequestParams
): slides_v1.Schema$Request[] {
  return buildNodeWriteRequests(params);
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
