import type { WorkerConfig } from "@translay/shared-config";
import type {
  TranslationRequest,
  TranslationResponse,
  ProviderName,
} from "@translay/shared-contracts";
import { translateWithVertexGemini } from "./vertex-gemini";

export interface ProviderRoute {
  readonly provider: ProviderName;
  readonly model: string;
  readonly strategy: "default" | "canary";
}

/**
 * Provider Router v1: routes all traffic to Vertex AI Gemini.
 * Extensible for future Gemma 3 Translate canary.
 */
export function selectRoute(config: WorkerConfig, _userId: string): ProviderRoute {
  // Phase 4: all traffic goes to Vertex AI Gemini
  return {
    provider: "vertex_gemini",
    model: config.vertex.model,
    strategy: "default",
  };
}

export async function translate(
  config: WorkerConfig,
  request: TranslationRequest
): Promise<TranslationResponse> {
  switch (request.provider) {
    case "vertex_gemini":
      return translateWithVertexGemini(config, request);
    case "gemma3_translate":
      // Future: route to GPU VM
      throw new Error("gemma3_translate provider not yet implemented");
    default: {
      const _exhaustive: never = request.provider;
      throw new Error(`Unknown provider: ${_exhaustive}`);
    }
  }
}
