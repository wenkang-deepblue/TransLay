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

interface TextStyleSnapshot {
  readonly textStyle?: slides_v1.Schema$TextStyle;
  readonly paragraphStyle?: slides_v1.Schema$ParagraphStyle;
}

export interface WriteBackResult {
  readonly outputUrl: string;
  readonly committedUnits: number;
}

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
): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of translatedNodes) {
    map.set(node.node_id, node.translated_full_text);
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
  translationMap: Map<string, string>,
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
        ...buildTextReplacementRequests(
          resolvedObjectId,
          translated,
          captureTextStyleSnapshot(notesShape.shape.text)
        )
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
        ...buildTextReplacementRequests(
          resolvedObjectId,
          translated,
          captureTextStyleSnapshot(tableCell.text),
          {
            rowIndex: node.row_index ?? 0,
            columnIndex: node.col_index ?? 0,
          }
        )
      );
      continue;
    }

    const element = findElement(slide, node.object_id);
    if (!element?.shape?.text) {
      continue;
    }

    requests.push(
      ...buildTextReplacementRequests(
        resolvedObjectId,
        translated,
        captureTextStyleSnapshot(element.shape.text)
      )
    );
  }

  return requests;
}

function buildTextReplacementRequests(
  objectId: string,
  translatedText: string,
  styleSnapshot: TextStyleSnapshot,
  cellLocation?: slides_v1.Schema$TableCellLocation
): slides_v1.Schema$Request[] {
  const requests: slides_v1.Schema$Request[] = [
    {
      deleteText: {
        objectId,
        cellLocation,
        textRange: { type: "ALL" },
      },
    },
  ];

  if (translatedText.length > 0) {
    requests.push({
      insertText: {
        objectId,
        cellLocation,
        text: translatedText,
        insertionIndex: 0,
      },
    });

    const textRange = {
      type: "FIXED_RANGE",
      startIndex: 0,
      endIndex: translatedText.length,
    } as const;

    if (styleSnapshot.textStyle) {
      requests.push({
        updateTextStyle: {
          objectId,
          cellLocation,
          style: styleSnapshot.textStyle,
          fields: "*",
          textRange,
        },
      });
    }

    if (styleSnapshot.paragraphStyle) {
      requests.push({
        updateParagraphStyle: {
          objectId,
          cellLocation,
          style: styleSnapshot.paragraphStyle,
          fields: "*",
          textRange,
        },
      });
    }
  }

  return requests;
}

function captureTextStyleSnapshot(
  textContent: slides_v1.Schema$TextContent
): TextStyleSnapshot {
  const textElements = textContent.textElements ?? [];
  const textRun = textElements.find((element) => element.textRun?.style)?.textRun;
  const paragraphMarker = textElements.find((element) => element.paragraphMarker?.style)?.paragraphMarker;

  return {
    textStyle: textRun?.style ? structuredClone(textRun.style) : undefined,
    paragraphStyle: paragraphMarker?.style
      ? structuredClone(paragraphMarker.style)
      : undefined,
  };
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
