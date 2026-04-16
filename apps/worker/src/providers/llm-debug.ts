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
}

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
    await debugCapture(event);
  } catch (error) {
    console.warn(
      `Failed to persist LLM debug output for ${event.call_label}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
