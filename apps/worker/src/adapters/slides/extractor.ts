import type { slides_v1 } from "googleapis";
import type {
  SlideTextNode,
  SlideExtractionResult,
  PresentationExtractionResult,
} from "./types";
import { getSlidesClient } from "./auth";
import {
  buildRichTextNode,
  extractBoxGeometry,
  extractPlainText,
} from "./rich-text";

/**
 * Extract structured text nodes from a Google Slides™ presentation.
 * Respects page range filters for translation targets.
 * Always extracts full presentation text as context for terminology consistency.
 * Does NOT persist any extracted content.
 */
export async function extractSlides(
  presentationId: string,
  pageIndices: number[] | null
): Promise<PresentationExtractionResult> {
  const { slides } = getSlidesClient();

  const pres = await slides.presentations.get({ presentationId });
  const presData = pres.data;
  const allSlides = presData.slides ?? [];
  const title = presData.title ?? "Untitled";

  // Always build full-document context from ALL slides
  const contextParts: string[] = [];
  for (let i = 0; i < allSlides.length; i++) {
    const slide = allSlides[i];
    const slideTexts: string[] = [];
    for (const element of slide.pageElements ?? []) {
      collectPlainText(element, slideTexts);
    }
    const notesPage = slide.slideProperties?.notesPage;
    if (notesPage) {
      for (const element of notesPage.pageElements ?? []) {
        if (isSpeakerNotesBodyShape(element)) {
          const t = extractPlainText(element.shape.text).trim();
          if (t) slideTexts.push(t);
        }
      }
    }
    if (slideTexts.length > 0) {
      contextParts.push(`[Slide ${i + 1}] ${slideTexts.join(" | ")}`);
    }
  }
  const fullContextText = contextParts.join("\n");

  // Extract structured nodes only from target slides
  const targetSlides =
    pageIndices
      ? allSlides.filter((_, i) => pageIndices.includes(i + 1))
      : allSlides;

  const extracted: SlideExtractionResult[] = [];
  const allNodes: SlideTextNode[] = [];

  for (const slide of targetSlides) {
    const slideIndex = allSlides.indexOf(slide);
    const slideObjectId = slide.objectId ?? `slide_${slideIndex}`;
    const nodes: SlideTextNode[] = [];

    for (const element of slide.pageElements ?? []) {
      extractFromElement(element, slideIndex, nodes);
    }

    const notesPage = slide.slideProperties?.notesPage;
    if (notesPage) {
      extractSpeakerNotes(notesPage, slideIndex, nodes);
    }

    extracted.push({ slide_index: slideIndex, slide_object_id: slideObjectId, nodes });
    allNodes.push(...nodes);
  }

  return {
    presentation_id: presentationId,
    title,
    total_slides: allSlides.length,
    extracted_slides: extracted,
    all_nodes: allNodes,
    full_context_text: fullContextText,
  };
}

/** Recursively collect plain text from a page element (for context building). */
function collectPlainText(
  element: slides_v1.Schema$PageElement,
  out: string[]
): void {
  if (element.shape?.text) {
    const t = extractPlainText(element.shape.text).trim();
    if (t) out.push(t);
  }
  if (element.table) {
    for (const row of element.table.tableRows ?? []) {
      for (const cell of row.tableCells ?? []) {
        if (cell.text) {
          const t = extractPlainText(cell.text).trim();
          if (t) out.push(t);
        }
      }
    }
  }
  if (element.elementGroup?.children) {
    for (const child of element.elementGroup.children) {
      collectPlainText(child, out);
    }
  }
}

function extractFromElement(
  element: slides_v1.Schema$PageElement,
  slideIndex: number,
  nodes: SlideTextNode[]
): void {
  const objectId = element.objectId ?? "";
  const box = extractBoxGeometry(element);

  if (element.shape?.text) {
    const node = buildRichTextNode({
      nodeId: `s${slideIndex}_shape_${objectId}`,
      objectId,
      slideIndex,
      elementType: "shape",
      textContent: element.shape.text,
      box,
    });
    if (node) {
      nodes.push(node);
    }
  }

  if (element.table) {
    const table = element.table;
    for (let r = 0; r < (table.rows ?? 0); r++) {
      const row = table.tableRows?.[r];
      if (!row) continue;
      for (let c = 0; c < (row.tableCells?.length ?? 0); c++) {
        const cell = row.tableCells?.[c];
        if (!cell?.text) continue;
        const node = buildRichTextNode({
          nodeId: `s${slideIndex}_table_${objectId}_r${r}_c${c}`,
          objectId,
          slideIndex,
          elementType: "table_cell",
          textContent: cell.text,
          box,
          rowIndex: r,
          colIndex: c,
        });
        if (node) {
          nodes.push(node);
        }
      }
    }
  }

  if (element.elementGroup?.children) {
    for (const child of element.elementGroup.children) {
      extractFromElement(child, slideIndex, nodes);
    }
  }
}

function extractSpeakerNotes(
  notesPage: slides_v1.Schema$Page,
  slideIndex: number,
  nodes: SlideTextNode[]
): void {
  for (const element of notesPage.pageElements ?? []) {
    if (isSpeakerNotesBodyShape(element)) {
      const node = buildRichTextNode({
        nodeId: `s${slideIndex}_notes_${element.objectId ?? "notes"}`,
        objectId: element.objectId ?? "",
        slideIndex,
        elementType: "speaker_notes",
        textContent: element.shape.text,
        box: extractBoxGeometry(element),
      });
      if (node) {
        nodes.push(node);
      }
    }
  }
}

function isSpeakerNotesBodyShape(
  element: slides_v1.Schema$PageElement
): element is slides_v1.Schema$PageElement & {
  objectId: string;
  shape: NonNullable<slides_v1.Schema$PageElement["shape"]> & {
    text: slides_v1.Schema$TextContent;
  };
} {
  return (
    Boolean(element.objectId) &&
    Boolean(element.shape?.text) &&
    element.shape?.placeholder?.type === "BODY"
  );
}

