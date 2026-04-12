import type { slides_v1 } from "googleapis";
import type {
  SlideBoxGeometry,
  SlideBulletMetadata,
  SlideNodeArchetype,
  SlideParagraph,
  SlideRunStyleRole,
  SlideTextNode,
  SlideTextRun,
  SlideVisibleStyleSummary,
} from "./types";

const PT_TO_EMU = 12700;

type ExtractableElementType = SlideTextNode["element_type"];

interface BuildRichTextNodeParams {
  readonly nodeId: string;
  readonly objectId: string;
  readonly slideIndex: number;
  readonly elementType: ExtractableElementType;
  readonly textContent: slides_v1.Schema$TextContent;
  readonly box: SlideBoxGeometry;
  readonly visibleStyle?: SlideVisibleStyleSummary;
  readonly rowIndex?: number;
  readonly colIndex?: number;
}

interface MutableSlideParagraph {
  paragraph_id: string;
  text: string;
  start_index: number;
  end_index: number;
  bullet?: SlideBulletMetadata;
  paragraph_style: slides_v1.Schema$ParagraphStyle;
  runs: SlideTextRun[];
}

export function buildRichTextNode(
  params: BuildRichTextNodeParams
): SlideTextNode | null {
  const fullText = extractPlainText(params.textContent);
  if (!fullText.trim()) {
    return null;
  }

  const extractedParagraphs = extractParagraphs(params.textContent);
  const archetype = classifyNodeArchetype(
    params.elementType,
    fullText,
    extractedParagraphs
  );
  const paragraphs = assignStyleRoles(extractedParagraphs, archetype);
  const visibleStyle = params.visibleStyle ?? summarizeVisibleStyleFromParagraphs(paragraphs);

  return {
    node_id: params.nodeId,
    text: fullText,
    full_text: fullText,
    slide_index: params.slideIndex,
    element_type: params.elementType,
    archetype,
    object_id: params.objectId,
    box: params.box,
    paragraphs,
    visible_style: visibleStyle,
    row_index: params.rowIndex,
    col_index: params.colIndex,
  };
}

export function extractPlainText(
  textContent: slides_v1.Schema$TextContent
): string {
  return (textContent.textElements ?? [])
    .map((element) => element.textRun?.content ?? "")
    .join("");
}

export function extractParagraphs(
  textContent: slides_v1.Schema$TextContent
): SlideParagraph[] {
  const paragraphs: MutableSlideParagraph[] = [];
  let current: MutableSlideParagraph | null = null;

  for (const element of textContent.textElements ?? []) {
    if (element.paragraphMarker) {
      if (current) {
        paragraphs.push(finalizeParagraph(current));
      }

      current = createParagraph(
        paragraphs.length,
        element.startIndex ?? current?.end_index ?? 0,
        cloneIfPresent(element.paragraphMarker.style),
        extractBulletMetadata(element.paragraphMarker)
      );
      continue;
    }

    const rawText = element.textRun?.content ?? "";
    if (!rawText) {
      continue;
    }

    if (!current) {
      current = createParagraph(paragraphs.length, element.startIndex ?? 0);
    }

    appendRunToParagraph(current, element, rawText);

    if (rawText.includes("\n")) {
      paragraphs.push(finalizeParagraph(current));
      current = null;
    }
  }

  if (current) {
    paragraphs.push(finalizeParagraph(current));
  }

  return paragraphs.filter((paragraph) => paragraph.text.length > 0 || paragraph.bullet);
}

export function extractBoxGeometry(
  element: slides_v1.Schema$PageElement
): SlideBoxGeometry {
  const transform = element.transform;

  return {
    width_emu: dimensionToEmu(element.size?.width),
    height_emu: dimensionToEmu(element.size?.height),
    translate_x_emu: magnitudeToEmu(transform?.translateX, transform?.unit),
    translate_y_emu: magnitudeToEmu(transform?.translateY, transform?.unit),
    rotation_deg: affineRotationDeg(transform),
  };
}

export function extractVisibleStyleSummary(
  element: slides_v1.Schema$PageElement,
  textContent: slides_v1.Schema$TextContent
): SlideVisibleStyleSummary | undefined {
  const base = summarizeVisibleStyleFromParagraphs(extractParagraphs(textContent));
  const fillColorHex = extractThemeAgnosticColorHex(
    element.shape?.shapeProperties?.shapeBackgroundFill?.solidFill?.color
  );
  const outlineColorHex = extractThemeAgnosticColorHex(
    element.shape?.shapeProperties?.outline?.outlineFill?.solidFill?.color
  );

  if (!base && !fillColorHex && !outlineColorHex) {
    return undefined;
  }

  return {
    ...base,
    fill_color_hex: fillColorHex,
    outline_color_hex: outlineColorHex,
  };
}

export function extractTableCellVisibleStyleSummary(
  cell: unknown,
  textContent: slides_v1.Schema$TextContent
): SlideVisibleStyleSummary | undefined {
  const base = summarizeVisibleStyleFromParagraphs(extractParagraphs(textContent));
  const fillColorHex = extractTableCellFillColorHex(cell);

  if (!base && !fillColorHex) {
    return undefined;
  }

  return {
    ...base,
    fill_color_hex: fillColorHex,
  };
}

export function classifyNodeArchetype(
  elementType: ExtractableElementType,
  fullText: string,
  paragraphs: readonly SlideParagraph[]
): SlideNodeArchetype {
  if (elementType === "speaker_notes") {
    return "speaker_notes";
  }

  if (elementType === "table_cell") {
    return "table_cell";
  }

  if (paragraphs.some((paragraph) => paragraph.bullet)) {
    return "bullet_list";
  }

  if (looksLikeMetricCard(fullText, paragraphs)) {
    return "metric_card";
  }

  if (hasMixedTextStyles(paragraphs)) {
    return "mixed_emphasis";
  }

  return "plain_text";
}

function createParagraph(
  paragraphIndex: number,
  startIndex: number,
  paragraphStyle?: slides_v1.Schema$ParagraphStyle,
  bullet?: SlideBulletMetadata
): MutableSlideParagraph {
  return {
    paragraph_id: `p${paragraphIndex}`,
    text: "",
    start_index: startIndex,
    end_index: startIndex,
    bullet,
    paragraph_style: paragraphStyle ?? {},
    runs: [],
  };
}

function appendRunToParagraph(
  paragraph: MutableSlideParagraph,
  element: slides_v1.Schema$TextElement,
  rawText: string
): void {
  const visibleText = rawText.replace(/\n/g, "");
  const startIndex = element.startIndex ?? paragraph.end_index;
  const endIndex = startIndex + visibleText.length;

  if (visibleText.length > 0) {
    paragraph.runs.push({
      run_id: `${paragraph.paragraph_id}_r${paragraph.runs.length}`,
      text: visibleText,
      start_index: startIndex,
      end_index: endIndex,
      style_role: "default",
      text_style: cloneIfPresent(element.textRun?.style) ?? {},
    });
    paragraph.text += visibleText;
    paragraph.end_index = endIndex;
    return;
  }

  const fallbackEnd = element.endIndex ?? paragraph.end_index;
  paragraph.end_index = Math.max(paragraph.end_index, fallbackEnd);
}

function finalizeParagraph(paragraph: MutableSlideParagraph): SlideParagraph {
  return {
    paragraph_id: paragraph.paragraph_id,
    text: paragraph.text,
    start_index: paragraph.start_index,
    end_index: paragraph.end_index,
    bullet: paragraph.bullet,
    paragraph_style: paragraph.paragraph_style,
    runs: paragraph.runs,
  };
}

function extractBulletMetadata(
  paragraphMarker: slides_v1.Schema$ParagraphMarker
): SlideBulletMetadata | undefined {
  const bullet = paragraphMarker.bullet as
    | (slides_v1.Schema$Bullet & { nestingLevel?: number | null })
    | undefined;

  if (!bullet) {
    return undefined;
  }

  return {
    list_id: bullet.listId ?? undefined,
    glyph: bullet.glyph ?? undefined,
    nesting_level: bullet.nestingLevel ?? undefined,
  };
}

function assignStyleRoles(
  paragraphs: readonly SlideParagraph[],
  archetype: SlideNodeArchetype
): SlideParagraph[] {
  if (paragraphs.length === 0) {
    return [...paragraphs];
  }

  const baselineSignature = mostCommonStyleSignature(paragraphs);

  return paragraphs.map((paragraph) => ({
    ...paragraph,
    runs: paragraph.runs.map((run, index) => ({
      ...run,
      style_role: resolveRunStyleRole(run, index, paragraph.runs, archetype, baselineSignature),
    })),
  }));
}

function resolveRunStyleRole(
  run: SlideTextRun,
  runIndex: number,
  runs: readonly SlideTextRun[],
  archetype: SlideNodeArchetype,
  baselineSignature: string
): SlideRunStyleRole {
  if (archetype === "metric_card") {
    return resolveMetricRunStyleRole(run, runIndex, runs);
  }

  if (styleSignature(run.text_style) !== baselineSignature) {
    return "emphasis";
  }

  return "default";
}

function resolveMetricRunStyleRole(
  run: SlideTextRun,
  runIndex: number,
  runs: readonly SlideTextRun[]
): SlideRunStyleRole {
  const trimmed = run.text.trim();
  if (!trimmed) {
    return "default";
  }

  const valueRunIndex = runs.findIndex((candidate) =>
    /\d/.test(candidate.text)
  );

  if (/^[\p{Sc}$€£¥₹₩₪₽₫฿]+$/u.test(trimmed)) {
    return "prefix";
  }

  if (/\d/.test(trimmed)) {
    return "metric_value";
  }

  if (valueRunIndex !== -1 && runIndex > valueRunIndex && trimmed.length <= 6) {
    return "metric_unit";
  }

  if (valueRunIndex !== -1 && runIndex < valueRunIndex) {
    return "prefix";
  }

  return "suffix";
}

function summarizeVisibleStyleFromParagraphs(
  paragraphs: readonly SlideParagraph[]
): SlideVisibleStyleSummary | undefined {
  const fontSizes = paragraphs
    .flatMap((paragraph) => paragraph.runs)
    .map((run) => run.text_style.fontSize?.magnitude)
    .filter((value): value is number => typeof value === "number" && value > 0);

  const alignment = paragraphs.find((paragraph) => Boolean(paragraph.paragraph_style.alignment))
    ?.paragraph_style.alignment;
  const fontFamily = paragraphs
    .flatMap((paragraph) => paragraph.runs)
    .map((run) => run.text_style.weightedFontFamily?.fontFamily)
    .find((value): value is string => typeof value === "string" && value.length > 0);

  if (!alignment && !fontFamily && fontSizes.length === 0) {
    return undefined;
  }

  return {
    alignment: typeof alignment === "string" ? alignment : undefined,
    font_family: fontFamily,
    min_font_size_pt: fontSizes.length > 0 ? Math.min(...fontSizes) : undefined,
    max_font_size_pt: fontSizes.length > 0 ? Math.max(...fontSizes) : undefined,
  };
}

function mostCommonStyleSignature(paragraphs: readonly SlideParagraph[]): string {
  const counts = new Map<string, number>();

  for (const run of paragraphs.flatMap((paragraph) => paragraph.runs)) {
    if (!run.text.trim()) {
      continue;
    }

    const signature = styleSignature(run.text_style);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }

  let winner = "none";
  let maxCount = 0;

  for (const [signature, count] of counts) {
    if (count > maxCount) {
      winner = signature;
      maxCount = count;
    }
  }

  return winner;
}

function hasMixedTextStyles(paragraphs: readonly SlideParagraph[]): boolean {
  const signatures = new Set<string>();

  for (const run of paragraphs.flatMap((paragraph) => paragraph.runs)) {
    if (!run.text.trim()) {
      continue;
    }

    signatures.add(styleSignature(run.text_style));
    if (signatures.size > 1) {
      return true;
    }
  }

  return false;
}

function looksLikeMetricCard(
  fullText: string,
  paragraphs: readonly SlideParagraph[]
): boolean {
  const normalized = fullText.replace(/\s+/g, " ").trim();
  if (!normalized || !/\d/.test(normalized)) {
    return false;
  }

  const fontSizes = paragraphs
    .flatMap((paragraph) => paragraph.runs)
    .map((run) => run.text_style?.fontSize?.magnitude)
    .filter((size): size is number => typeof size === "number" && size > 0);

  const maxFontSize = fontSizes.length > 0 ? Math.max(...fontSizes) : 0;
  const minFontSize = fontSizes.length > 0 ? Math.min(...fontSizes) : 0;
  const sizeRatio =
    minFontSize > 0 ? maxFontSize / minFontSize : 1;

  return (
    normalized.length <= 96 &&
    paragraphs.length <= 3 &&
    (sizeRatio >= 1.35 ||
      /^[\p{Sc}$€£¥₹₩₪₽₫฿]?\s*[\d.,]+(?:\s*[A-Za-z%]{1,4}|[KMBT])?$/u.test(normalized) ||
      /[\d.,]+(?:万|亿|千|百|万元|亿美元|百萬|億)/u.test(normalized))
  );
}

function styleSignature(style?: slides_v1.Schema$TextStyle): string {
  if (!style) {
    return "none";
  }

  return JSON.stringify({
    fontSize: style.fontSize?.magnitude ?? null,
    fontUnit: style.fontSize?.unit ?? null,
    fontFamily: style.weightedFontFamily?.fontFamily ?? null,
    bold: style.bold ?? null,
    italic: style.italic ?? null,
    underline: style.underline ?? null,
    strikethrough: style.strikethrough ?? null,
    smallCaps: style.smallCaps ?? null,
    foregroundColor: colorSignature(style.foregroundColor),
  });
}

function colorSignature(color?: slides_v1.Schema$OptionalColor): string | null {
  const rgb = color?.opaqueColor?.rgbColor;
  if (!rgb) {
    return null;
  }

  return `${rgb.red ?? 0}:${rgb.green ?? 0}:${rgb.blue ?? 0}`;
}

function extractThemeAgnosticColorHex(color: unknown): string | undefined {
  if (!isRecord(color)) {
    return undefined;
  }

  const rgbColor = color.rgbColor;
  if (!isRecord(rgbColor)) {
    return undefined;
  }

  const red = clampColorChannel(rgbColor.red);
  const green = clampColorChannel(rgbColor.green);
  const blue = clampColorChannel(rgbColor.blue);
  if (red === null || green === null || blue === null) {
    return undefined;
  }

  return `#${toHexChannel(red)}${toHexChannel(green)}${toHexChannel(blue)}`;
}

function clampColorChannel(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

function toHexChannel(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractTableCellFillColorHex(cell: unknown): string | undefined {
  if (!isRecord(cell)) {
    return undefined;
  }

  const tableCellProperties = cell.tableCellProperties;
  if (!isRecord(tableCellProperties)) {
    return undefined;
  }

  const tableCellBackgroundFill = tableCellProperties.tableCellBackgroundFill;
  if (!isRecord(tableCellBackgroundFill)) {
    return undefined;
  }

  const solidFill = tableCellBackgroundFill.solidFill;
  if (!isRecord(solidFill)) {
    return undefined;
  }

  return extractThemeAgnosticColorHex(solidFill.color);
}

function dimensionToEmu(dimension?: slides_v1.Schema$Dimension): number {
  if (!dimension) {
    return 0;
  }

  return magnitudeToEmu(dimension.magnitude, dimension.unit);
}

function magnitudeToEmu(
  magnitude?: number | null,
  unit?: string | null
): number {
  if (typeof magnitude !== "number") {
    return 0;
  }

  if (unit === "EMU" || !unit) {
    return magnitude;
  }

  if (unit === "PT") {
    return magnitude * PT_TO_EMU;
  }

  return magnitude;
}

function affineRotationDeg(
  transform?: slides_v1.Schema$AffineTransform
): number {
  if (!transform) {
    return 0;
  }

  const radians = Math.atan2(-(transform.shearX ?? 0), transform.scaleX ?? 1);
  return radians * (180 / Math.PI);
}

function cloneIfPresent<T>(value?: T | null): T | undefined {
  if (!value) {
    return undefined;
  }

  return structuredClone(value);
}
