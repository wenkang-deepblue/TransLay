/** Extracted text node from a Slides presentation. */
export interface SlideTextNode {
  readonly node_id: string;
  readonly text: string;
  readonly slide_index: number;
  /** Source element for write-back reference. */
  readonly element_type: "shape" | "table_cell" | "speaker_notes";
  readonly object_id: string;
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
