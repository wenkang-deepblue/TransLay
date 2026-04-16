import crypto from "node:crypto";
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
  extractTableCellVisibleStyleSummary,
  extractVisibleStyleSummary,
} from "./rich-text";

/**
 * Lookup key: "{placeholderType}|{placeholderIndex ?? -1}" → font size in PT.
 * Populated from slide masters and layouts so that placeholder elements whose
 * text runs carry no explicit fontSize can inherit the correct value.
 */
export type PlaceholderFontSizeLookup = Map<string, number>;

function placeholderLookupKey(
  type: string,
  index: number | null | undefined
): string {
  return `${type}|${index ?? -1}`;
}

/**
 * Build a lookup table that maps placeholder (type, index) → first explicit
 * font size found in the corresponding master / layout element.
 *
 * Walk order: layouts first (more specific) then masters (fallback).
 * The first hit per key wins so layout values take precedence.
 */
export function buildPlaceholderFontSizeLookup(
  masters: readonly slides_v1.Schema$Page[] | undefined,
  layouts: readonly slides_v1.Schema$Page[] | undefined
): PlaceholderFontSizeLookup {
  const lookup: PlaceholderFontSizeLookup = new Map();

  for (const layout of layouts ?? []) {
    collectPlaceholderFontSizes(layout.pageElements ?? [], lookup);
  }

  for (const master of masters ?? []) {
    collectPlaceholderFontSizes(master.pageElements ?? [], lookup);
  }

  return lookup;
}

function collectPlaceholderFontSizes(
  elements: readonly slides_v1.Schema$PageElement[],
  lookup: PlaceholderFontSizeLookup
): void {
  for (const element of elements) {
    const placeholder = element.shape?.placeholder;
    if (!placeholder?.type) {
      continue;
    }

    const key = placeholderLookupKey(placeholder.type, placeholder.index);
    if (lookup.has(key)) {
      continue;
    }

    const fontSize = firstExplicitFontSize(element.shape?.text);
    if (typeof fontSize === "number" && fontSize > 0) {
      lookup.set(key, fontSize);
    }
  }
}

function firstExplicitFontSize(
  textContent?: slides_v1.Schema$TextContent | null
): number | undefined {
  for (const element of textContent?.textElements ?? []) {
    const magnitude = element.textRun?.style?.fontSize?.magnitude;
    if (typeof magnitude === "number" && magnitude > 0) {
      return magnitude;
    }
  }
  return undefined;
}

/**
 * Resolve the inherited font size for an element with a placeholder property.
 */
function resolveInheritedFontSize(
  element: slides_v1.Schema$PageElement,
  lookup: PlaceholderFontSizeLookup
): number | undefined {
  const placeholder = element.shape?.placeholder;
  if (!placeholder?.type) {
    return undefined;
  }

  const indexedKey = placeholderLookupKey(placeholder.type, placeholder.index);
  const hit = lookup.get(indexedKey);
  if (hit !== undefined) {
    return hit;
  }

  const fallbackKey = placeholderLookupKey(placeholder.type, -1);
  return lookup.get(fallbackKey);
}

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
  const sourceSlides = allSlides.filter((slide) => !isGeneratedTranslationSlide(slide.objectId));

  const placeholderFontLookup = buildPlaceholderFontSizeLookup(
    presData.masters,
    presData.layouts
  );

  // Always build full-document context from ALL slides
  const contextParts: string[] = [];
  for (let i = 0; i < sourceSlides.length; i++) {
    const slide = sourceSlides[i];
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
      ? sourceSlides.filter((_, i) => pageIndices.includes(i + 1))
      : sourceSlides;

  const extracted: SlideExtractionResult[] = [];
  const allNodes: SlideTextNode[] = [];

  for (const slide of targetSlides) {
    const slideIndex = sourceSlides.indexOf(slide);
    const slideObjectId = slide.objectId ?? `slide_${slideIndex}`;
    const nodes: SlideTextNode[] = [];

    for (const element of slide.pageElements ?? []) {
      extractFromElement(element, slideIndex, nodes, placeholderFontLookup);
    }

    const notesPage = slide.slideProperties?.notesPage;
    if (notesPage) {
      extractSpeakerNotes(notesPage, slideIndex, nodes);
    }

    extracted.push({
      slide_index: slideIndex,
      slide_object_id: slideObjectId,
      slide_fingerprint: buildSlideFingerprint(slideObjectId, nodes),
      nodes,
    });
    allNodes.push(...nodes);
  }

  return {
    presentation_id: presentationId,
    title,
    total_slides: sourceSlides.length,
    extracted_slides: extracted,
    all_nodes: allNodes,
    full_context_text: fullContextText,
  };
}

function isGeneratedTranslationSlide(objectId: string | null | undefined): boolean {
  return typeof objectId === "string" && objectId.startsWith("tl_");
}

function buildSlideFingerprint(slideObjectId: string, nodes: readonly SlideTextNode[]): string {
  const hash = crypto.createHash("sha256");
  hash.update(
    JSON.stringify({
      slide_object_id: slideObjectId,
      node_ids: nodes.map((node) => node.node_id),
      object_ids: nodes.map((node) => node.object_id),
      element_types: nodes.map((node) => node.element_type),
    })
  );
  return hash.digest("hex");
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
  nodes: SlideTextNode[],
  placeholderFontLookup: PlaceholderFontSizeLookup,
  parentGroupScaleX?: number,
  parentGroupScaleY?: number
): void {
  const objectId = element.objectId ?? "";
  const box = extractBoxGeometry(element, parentGroupScaleX, parentGroupScaleY);

  if (element.shape?.text) {
    const inheritedFontSizePt = resolveInheritedFontSize(element, placeholderFontLookup);
    const node = buildRichTextNode({
      nodeId: `s${slideIndex}_shape_${objectId}`,
      objectId,
      slideIndex,
      elementType: "shape",
      textContent: element.shape.text,
      box,
      visibleStyle: extractVisibleStyleSummary(element, element.shape.text),
      inheritedFontSizePt,
    });
    if (node) {
      nodes.push(node);
    }
  }

  if (element.table) {
    const table = element.table;
    const rowCount = Math.max(1, table.rows ?? table.tableRows?.length ?? 1);
    const columnCount = Math.max(
      1,
      table.columns ?? Math.max(...(table.tableRows ?? []).map((row) => row.tableCells?.length ?? 0), 1)
    );
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
          box: deriveApproximateTableCellBox(box, rowCount, columnCount, r, c, cell),
          visibleStyle: extractTableCellVisibleStyleSummary(cell, cell.text),
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
    const groupScale = resolveGroupScale(element);
    for (const child of element.elementGroup.children) {
      extractFromElement(
        child,
        slideIndex,
        nodes,
        placeholderFontLookup,
        composeScale(parentGroupScaleX, groupScale.scaleX),
        composeScale(parentGroupScaleY, groupScale.scaleY)
      );
    }
  }
}

function resolveGroupScale(groupElement: slides_v1.Schema$PageElement): {
  scaleX: number;
  scaleY: number;
} {
  const t = groupElement.transform;
  if (!t) {
    return { scaleX: 1, scaleY: 1 };
  }
  return {
    scaleX: Math.sqrt((t.scaleX ?? 1) ** 2 + (t.shearY ?? 0) ** 2),
    scaleY: Math.sqrt((t.scaleY ?? 1) ** 2 + (t.shearX ?? 0) ** 2),
  };
}

function composeScale(
  parentScale: number | undefined,
  childScale: number
): number {
  if (typeof parentScale === "number" && parentScale > 0) {
    return parentScale * childScale;
  }
  return childScale;
}

/**
 * Slides API extraction does not expose stable per-cell geometry here, so use
 * a transform-aware table box and split it into approximate cell budgets.
 * This is intentionally conservative and still better than giving every cell
 * the full table box as its fit-pass budget.
 */
function deriveApproximateTableCellBox(
  tableBox: SlideTextNode["box"],
  rowCount: number,
  columnCount: number,
  rowIndex: number,
  colIndex: number,
  cell: slides_v1.Schema$TableCell
): SlideTextNode["box"] {
  const columnSpan =
    (cell as { columnSpan?: number | null }).columnSpan && (cell as { columnSpan?: number | null }).columnSpan! > 0
      ? (cell as { columnSpan?: number | null }).columnSpan!
      : 1;
  const rowSpan =
    (cell as { rowSpan?: number | null }).rowSpan && (cell as { rowSpan?: number | null }).rowSpan! > 0
      ? (cell as { rowSpan?: number | null }).rowSpan!
      : 1;
  const baseCellWidth = tableBox.width_emu / Math.max(1, columnCount);
  const baseCellHeight = tableBox.height_emu / Math.max(1, rowCount);

  return {
    width_emu: baseCellWidth * columnSpan,
    height_emu: baseCellHeight * rowSpan,
    translate_x_emu: tableBox.translate_x_emu + baseCellWidth * colIndex,
    translate_y_emu: tableBox.translate_y_emu + baseCellHeight * rowIndex,
    rotation_deg: tableBox.rotation_deg,
  };
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

