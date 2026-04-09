export const PROVIDER_NAMES = ["vertex_gemini", "gemma3_translate"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/** Translation request sent from Worker to inference plane. */
export interface TranslationNode {
  readonly node_id: string;
  /** @internal MUST NOT be persisted, logged, or cached — zero-content-persistence rule. */
  readonly text: string;
}

export interface TranslationRequest {
  readonly provider: ProviderName;
  readonly model: string;
  readonly source_language: string;
  readonly target_language: string;
  readonly nodes: readonly TranslationNode[];
  /**
   * Full document text provided as read-only context for terminology consistency.
   * The model should use this to maintain consistent translations across pages.
   * @internal MUST NOT be persisted, logged, or cached — zero-content-persistence rule.
   */
  readonly context_text?: string;
}

/** Translation response from inference plane. */
export interface TranslatedNode {
  readonly node_id: string;
  /** @internal MUST NOT be persisted, logged, or cached — zero-content-persistence rule. */
  readonly translated_text: string;
}

export interface TranslationResponse {
  readonly provider_request_id: string;
  readonly nodes: readonly TranslatedNode[];
}
