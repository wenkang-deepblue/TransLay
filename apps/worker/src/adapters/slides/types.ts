import type { slides_v1 } from "googleapis";

export type SlideNodeArchetype =
  | "plain_text"
  | "bullet_list"
  | "metric_card"
  | "mixed_emphasis"
  | "table_cell"
  | "speaker_notes";

export type SlideRunStyleRole =
  | "default"
  | "emphasis"
  | "metric_value"
  | "metric_unit"
  | "prefix"
  | "suffix";

export type SlideTextStyleSnapshot = slides_v1.Schema$TextStyle;
export type SlideParagraphStyleSnapshot = slides_v1.Schema$ParagraphStyle;

export interface SlideBoxGeometry {
  readonly width_emu: number;
  readonly height_emu: number;
  readonly translate_x_emu: number;
  readonly translate_y_emu: number;
  readonly rotation_deg: number;
}

export interface SlideBulletMetadata {
  readonly list_id?: string;
  readonly glyph?: string;
  readonly nesting_level?: number;
}

export interface SlideTextRun {
  readonly run_id: string;
  readonly text: string;
  readonly start_index: number;
  readonly end_index: number;
  readonly style_role: SlideRunStyleRole;
  readonly text_style: SlideTextStyleSnapshot;
}

export interface SlideParagraph {
  readonly paragraph_id: string;
  readonly text: string;
  readonly start_index: number;
  readonly end_index: number;
  readonly bullet?: SlideBulletMetadata;
  readonly paragraph_style: SlideParagraphStyleSnapshot;
  readonly runs: SlideTextRun[];
}

/** Extracted text node from a Slides presentation. */
export interface SlideTextNode {
  readonly node_id: string;
  /** Flattened translatable text for the current translation stage. */
  readonly text: string;
  readonly full_text: string;
  readonly slide_index: number;
  /** Source element for write-back reference. */
  readonly element_type: "shape" | "table_cell" | "speaker_notes";
  readonly archetype: SlideNodeArchetype;
  readonly object_id: string;
  readonly box: SlideBoxGeometry;
  readonly paragraphs: SlideParagraph[];
  /** For table cells: row and column indices. */
  readonly row_index?: number;
  readonly col_index?: number;
}

/** Extraction result for a single slide. */
export interface SlideExtractionResult {
  readonly slide_index: number;
  readonly slide_object_id: string;
  readonly nodes: SlideTextNode[];
}

/** Full extraction result for the presentation. */
export interface PresentationExtractionResult {
  readonly presentation_id: string;
  readonly title: string;
  readonly total_slides: number;
  readonly extracted_slides: SlideExtractionResult[];
  readonly all_nodes: SlideTextNode[];
  /** Plain text summary of the entire presentation (all slides), for translation context. */
  readonly full_context_text: string;
}
