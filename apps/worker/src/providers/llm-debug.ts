export type LlmDebugCaptureStage =
  | "translation"
  | "layout_semantics"
  | "authority"
  | "authority_gap_fill"
  | "materialization"
  | "speaker_notes";

export type LlmDebugCaptureStatus =
  | "success"
  | "http_error"
  | "empty_response"
  | "parse_error";

export interface LlmDebugCaptureEvent {
  readonly provider: "vertex_gemini";
  readonly model: string;
  readonly stage: LlmDebugCaptureStage;
  readonly call_label: string;
  readonly slide_index?: number;
  readonly node_ids: readonly string[];
  readonly provider_request_id?: string;
  readonly capture_status: LlmDebugCaptureStatus;
  readonly http_status?: number;
  readonly error_summary?: string;
  /**
   * DEVELOPMENT / TESTING ONLY:
   * This can contain raw user-derived model output and must be removed or
   * disabled before production hardening.
   */
  readonly raw_output_text?: string;
}

const RAW_OUTPUT_ALLOWED_STAGES = new Set<LlmDebugCaptureStage>(["layout_semantics"]);

export type LlmDebugCaptureFn = (
  event: LlmDebugCaptureEvent
) => Promise<void> | void;

export async function emitLlmDebugCapture(
  debugCapture: LlmDebugCaptureFn | undefined,
  event: LlmDebugCaptureEvent
): Promise<void> {
  if (!debugCapture) {
    return;
  }

  try {
    await debugCapture(sanitizeLlmDebugCaptureEvent(event, process.env.NODE_ENV ?? "development"));
  } catch (error) {
    console.warn(
      `Failed to persist LLM debug output for ${event.call_label}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export function sanitizeLlmDebugCaptureEvent(
  event: LlmDebugCaptureEvent,
  nodeEnv: string
): LlmDebugCaptureEvent {
  const productionLike = nodeEnv === "production" || nodeEnv === "staging";
  if (productionLike || !RAW_OUTPUT_ALLOWED_STAGES.has(event.stage)) {
    return {
      ...event,
      raw_output_text: undefined,
    };
  }

  return event;
}
