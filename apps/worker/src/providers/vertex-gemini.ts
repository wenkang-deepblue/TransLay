import type { WorkerConfig } from "@translay/shared-config";
import type {
  TranslationContextPack,
  TranslationNode,
  TranslatedNode,
  TranslationRequest,
  TranslationResponse,
} from "@translay/shared-contracts";

const MAX_NODES_PER_BATCH = 50;
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 2 * 60 * 1000;

let cachedAccessToken:
  | {
      token: string;
      expiresAtMs: number;
    }
  | null = null;

export function __resetAccessTokenCacheForTests(): void {
  cachedAccessToken = null;
}

const TRANSLATION_SYSTEM_INSTRUCTION = `
You are a professional translator for presentation and document content.

Follow these rules for every request:
- Semantic correctness is the highest priority.
- Use the provided deck context pack to infer the document domain, audience, terminology, and local structure constraints.
- Maintain consistent terminology for repeated domain terms when they carry the same meaning.
- If the local sentence clearly requires a different meaning, choose the translation that preserves the local meaning even if wording differs elsewhere.
- Translate only the provided target nodes.
- Preserve every node_id exactly as given.
- Preserve line breaks, punctuation, list markers, and other meaningful formatting where possible.
- Do not omit, merge, split, or reorder nodes.
- Return only JSON that matches the provided response schema.
`.trim();

function buildResponseSchema(nodeCount: number) {
  return {
    type: "ARRAY",
    description:
      "Ordered translations for the requested nodes. Return exactly one item per input node.",
    minItems: nodeCount,
    maxItems: nodeCount,
    items: {
      type: "OBJECT",
      description:
        "A translated node paired with its original node identifier.",
      properties: {
        node_id: {
          type: "STRING",
          description: "The exact node_id from the input, unchanged.",
        },
        translated_text: {
          type: "STRING",
          description:
            "The translated text for that node, preserving meaning and important formatting.",
        },
      },
      required: ["node_id", "translated_text"],
      propertyOrdering: ["node_id", "translated_text"],
    },
  } as const;
}

/**
 * Translate nodes using Vertex AI Gemini.
 * Uses native responseSchema for guaranteed JSON structure.
 * Includes full-document context for terminology consistency.
 */
export async function translateWithVertexGemini(
  config: WorkerConfig,
  request: TranslationRequest
): Promise<TranslationResponse> {
  const { nodes, source_language, target_language, model } = request;

  if (nodes.length === 0) {
    return { provider_request_id: "empty", nodes: [] };
  }

  if (nodes.length > MAX_NODES_PER_BATCH) {
    return translateInBatches(config, request);
  }

  const prompt = buildPrompt(
    nodes,
    source_language,
    target_language,
    request.context_pack
  );

  const endpoint = buildVertexGenerateContentEndpoint(
    config.gcpProjectId,
    config.vertex.location,
    model
  );

  const accessToken = await getAccessToken();

  const body = {
    systemInstruction: {
      parts: [{ text: TRANSLATION_SYSTEM_INSTRUCTION }],
    },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json",
      responseSchema: buildResponseSchema(nodes.length),
    },
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorSummary = await summarizeVertexErrorResponse(res);
    throw new Error(
      errorSummary
        ? `Vertex AI request failed with status ${res.status}: ${errorSummary}`
        : `Vertex AI request failed with status ${res.status}`
    );
  }

  const data = (await res.json()) as VertexResponse;
  const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!responseText) {
    throw new Error("Vertex AI returned empty response");
  }

  const parsed = parseTranslationResponse(responseText, nodes);

  return {
    provider_request_id: `vertex_${Date.now()}`,
    nodes: parsed,
  };
}

function buildVertexGenerateContentEndpoint(
  projectId: string,
  location: string,
  model: string
): string {
  const baseUrl =
    location === "global"
      ? "https://aiplatform.googleapis.com"
      : `https://${location}-aiplatform.googleapis.com`;

  return `${baseUrl}/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;
}

async function summarizeVertexErrorResponse(res: Response): Promise<string> {
  const raw = (await res.text()).trim();
  if (!raw) {
    return "";
  }

  try {
    const parsed = JSON.parse(raw) as {
      error?: { code?: number; status?: string; message?: string };
    };
    const message = parsed.error?.message?.trim();
    const status = parsed.error?.status?.trim();
    const code = parsed.error?.code;

    const summary = [status, code ? `code ${code}` : null, message]
      .filter(Boolean)
      .join(" - ");

    return truncateErrorSummary(summary || raw);
  } catch {
    return truncateErrorSummary(raw);
  }
}

function truncateErrorSummary(message: string): string {
  const trimmed = message.replace(/\s+/g, " ").trim();
  return trimmed.length > 300 ? `${trimmed.slice(0, 297)}...` : trimmed;
}

async function translateInBatches(
  config: WorkerConfig,
  request: TranslationRequest
): Promise<TranslationResponse> {
  const allNodes = request.nodes;
  const results: TranslatedNode[] = [];

  for (let i = 0; i < allNodes.length; i += MAX_NODES_PER_BATCH) {
    const batch = allNodes.slice(i, i + MAX_NODES_PER_BATCH);
    // Each batch shares the same full-document context for consistency
    const batchRequest: TranslationRequest = { ...request, nodes: batch };
    const batchResponse = await translateWithVertexGemini(config, batchRequest);
    results.push(...batchResponse.nodes);
  }

  return {
    provider_request_id: `vertex_batch_${Date.now()}`,
    nodes: results,
  };
}

function buildPrompt(
  nodes: readonly TranslationNode[],
  sourceLang: string,
  targetLang: string,
  contextPack?: TranslationContextPack
): string {
  const nodesJson = nodes.map((n) => ({
    node_id: n.node_id,
    text: n.text,
  }));

  const contextBlock = contextPack
    ? `DECK CONTEXT PACK:
${JSON.stringify(compactContextPackForPrompt(contextPack), null, 2)}`
    : "DECK CONTEXT PACK:\n<not provided>";

  return `TASK:
Translate only the target nodes from ${sourceLang} to ${targetLang}.

TRANSLATION PRIORITIES:
1. Preserve the intended meaning of each node in its local sentence or slide context.
2. Use the deck context pack to keep terminology and style consistent when the meaning stays the same.
3. If a repeated source term has a different meaning locally, prefer the correct local meaning over forced consistency.
4. Keep the same number of nodes and preserve each node_id exactly.
5. Preserve line breaks, punctuation, and non-translatable content when possible.
6. If a node contains only numbers, punctuation, or other non-translatable content, return it unchanged.

${contextBlock}

TARGET NODES:
${JSON.stringify(nodesJson)}`;
}

function compactContextPackForPrompt(contextPack: TranslationContextPack) {
  const activeSlides = new Set(contextPack.nodes.map((node) => node.slide_index));
  const deckContextWithoutActiveSlides = contextPack.deck_plaintext_context
    .split("\n")
    .filter((line) => {
      const match = line.match(/^\[Slide (\d+)\]/);
      if (!match) {
        return true;
      }

      const slideIndex = Number.parseInt(match[1] ?? "", 10);
      return !activeSlides.has(slideIndex);
    })
    .join("\n");

  return {
    deck_title: contextPack.deck_title,
    source_language: contextPack.source_language,
    target_language: contextPack.target_language,
    deck_plaintext_context:
      deckContextWithoutActiveSlides || "<active group covers current deck context>",
    glossary_candidates: contextPack.glossary_candidates,
    nodes: contextPack.nodes.map((node) => ({
      node_id: node.node_id,
      archetype: node.archetype,
      slide_index: node.slide_index,
      paragraph_count: node.paragraphs.length,
      paragraphs: node.paragraphs.map((paragraph) => ({
        paragraph_id: paragraph.paragraph_id,
        bullet: paragraph.bullet,
        style_roles: paragraph.style_roles,
      })),
    })),
  };
}

/**
 * Parse translation response. With responseSchema, the output is
 * guaranteed to be valid JSON matching our schema — but we still
 * validate node count and ID integrity.
 */
function parseTranslationResponse(
  raw: string,
  originalNodes: readonly TranslationNode[]
): TranslatedNode[] {
  let parsed: unknown[];
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Failed to parse Vertex AI translation response as JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Vertex AI response is not an array");
  }

  if (parsed.length !== originalNodes.length) {
    throw new Error(
      `Node count mismatch: expected ${originalNodes.length}, got ${parsed.length}`
    );
  }

  const result: TranslatedNode[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i] as Record<string, unknown>;
    const nodeId = String(item.node_id ?? "");
    const translatedText = String(item.translated_text ?? "");

    if (nodeId !== originalNodes[i].node_id) {
      throw new Error(
        `Node ID mismatch at index ${i}: expected "${originalNodes[i].node_id}", got "${nodeId}"`
      );
    }

    result.push({ node_id: nodeId, translated_text: translatedText });
  }

  return result;
}

/** Get GCP access token using Application Default Credentials. */
async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedAccessToken && cachedAccessToken.expiresAtMs > now) {
    return cachedAccessToken.token;
  }

  // Cloud Run: use metadata server
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } }
  );

  if (res.ok) {
    const data = (await res.json()) as {
      access_token: string;
      expires_in?: number;
    };
    const expiresInMs = Math.max((data.expires_in ?? 3600) * 1000, ACCESS_TOKEN_REFRESH_BUFFER_MS);
    cachedAccessToken = {
      token: data.access_token,
      expiresAtMs: now + expiresInMs - ACCESS_TOKEN_REFRESH_BUFFER_MS,
    };
    return data.access_token;
  }

  // Local development fallback
  const { execSync } = await import("child_process");
  try {
    const token = execSync("gcloud auth print-access-token", {
      encoding: "utf-8",
    }).trim();
    cachedAccessToken = {
      token,
      expiresAtMs: now + 30 * 60 * 1000,
    };
    return token;
  } catch {
    throw new Error(
      "Cannot obtain GCP access token — ensure ADC or metadata server is available"
    );
  }
}

interface VertexResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}
