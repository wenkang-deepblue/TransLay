import test from "node:test";
import assert from "node:assert/strict";
import type { WorkerConfig } from "@translay/shared-config";
import type { TranslationRequest } from "@translay/shared-contracts";
import {
  __resetAccessTokenCacheForTests,
  translateWithVertexGemini,
} from "./vertex-gemini";

function createConfig(): WorkerConfig {
  return {
    port: 8080,
    nodeEnv: "test",
    gcpProjectId: "YOUR_GCP_PROJECT_ID",
    gcpRegion: "us-central1",
    db: {
      host: "localhost",
      port: 5432,
      name: "translay",
      user: "postgres",
      password: "postgres",
    },
    redis: {
      host: "localhost",
      port: 6379,
    },
    vertex: {
      model: "gemini-3.1-flash-lite-preview",
      maxInputTokens: 50_000,
      location: "global",
    },
    gemmaGpu: {
      url: "",
    },
    cloudTasks: {
      audience: "",
      invokerServiceAccount: "",
    },
  };
}

test("translateWithVertexGemini sends system instructions and a constrained JSON schema", async () => {
  __resetAccessTokenCacheForTests();
  const request: TranslationRequest = {
    provider: "vertex_gemini",
    model: "gemini-3.1-flash-lite-preview",
    source_language: "English",
    target_language: "Chinese",
    context_pack: {
      deck_title: "Q3 Product Presentation",
      source_language: "English",
      target_language: "Chinese",
      deck_plaintext_context:
        "[Slide 1] Product presentation\n[Slide 2] Presentation goals",
      glossary_candidates: [
        {
          source_term: "ARR",
          occurrences: 3,
        },
      ],
      nodes: [
        {
          node_id: "n1",
          archetype: "bullet_list",
          slide_index: 1,
          full_text: "Presentation overview",
          paragraphs: [
            {
              paragraph_id: "p0",
              text: "Presentation overview",
              style_roles: ["default"],
            },
          ],
        },
      ],
    },
    nodes: [{ node_id: "n1", text: "Presentation overview" }],
  };

  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    fetchCalls.push({ url, init });

    if (url.includes("metadata.google.internal")) {
      return new Response(JSON.stringify({ access_token: "test-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: '[{"node_id":"n1","translated_text":"演示概览"}]' }],
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }) as typeof fetch;

  try {
    const result = await translateWithVertexGemini(createConfig(), request);

    assert.equal(result.nodes[0]?.translated_text, "演示概览");
    assert.equal(fetchCalls.length, 2);
    assert.equal(
      fetchCalls[1]?.url,
      "https://aiplatform.googleapis.com/v1/projects/YOUR_GCP_PROJECT_ID/locations/global/publishers/google/models/gemini-3.1-flash-lite-preview:generateContent"
    );

    const body = JSON.parse(String(fetchCalls[1]?.init?.body ?? "{}"));
    const systemInstruction = body.systemInstruction?.parts?.[0]?.text as string;
    const userPrompt = body.contents?.[0]?.parts?.[0]?.text as string;
    const responseSchema = body.generationConfig?.responseSchema as Record<string, unknown>;

    assert.match(
      systemInstruction,
      /Semantic correctness is the highest priority/i
    );
    assert.match(
      systemInstruction,
      /Maintain consistent terminology for repeated domain terms/i
    );
    assert.match(userPrompt, /DECK CONTEXT PACK/i);
    assert.match(userPrompt, /Q3 Product Presentation/);
    assert.match(userPrompt, /ARR/);
    assert.match(userPrompt, /bullet_list/);
    assert.match(userPrompt, /Presentation overview/);
    const [, deckContextSection = ""] =
      userPrompt.match(/DECK CONTEXT PACK:\n([\s\S]*?)\n\nTARGET NODES:/) ?? [];
    assert.doesNotMatch(deckContextSection, /"full_text"/);
    assert.doesNotMatch(deckContextSection, /"text":/);
    assert.equal(
      [...userPrompt.matchAll(/Presentation overview/g)].length,
      1
    );
    assert.match(userPrompt, /Translate only the target nodes/i);
    assert.doesNotMatch(userPrompt, /for reference only/i);
    assert.doesNotMatch(
      userPrompt,
      /The same term must be translated the same way throughout/i
    );

    assert.equal(body.generationConfig?.responseMimeType, "application/json");
    assert.equal(responseSchema.type, "ARRAY");
    assert.equal(responseSchema.minItems, 1);
    assert.equal(responseSchema.maxItems, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("translateWithVertexGemini reuses cached access tokens across requests", async () => {
  __resetAccessTokenCacheForTests();

  const request: TranslationRequest = {
    provider: "vertex_gemini",
    model: "gemini-3.1-flash-lite-preview",
    source_language: "English",
    target_language: "French",
    nodes: [{ node_id: "n1", text: "Hello world" }],
  };

  const originalFetch = globalThis.fetch;
  let metadataCalls = 0;
  let vertexCalls = 0;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);

    if (url.includes("metadata.google.internal")) {
      metadataCalls += 1;
      return new Response(
        JSON.stringify({ access_token: "cached-token", expires_in: 3600 }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    vertexCalls += 1;
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: '[{"node_id":"n1","translated_text":"Bonjour le monde"}]' }],
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }) as typeof fetch;

  try {
    await translateWithVertexGemini(createConfig(), request);
    await translateWithVertexGemini(createConfig(), request);

    assert.equal(metadataCalls, 1);
    assert.equal(vertexCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    __resetAccessTokenCacheForTests();
  }
});

test("translateWithVertexGemini surfaces sanitized Vertex error details", async () => {
  __resetAccessTokenCacheForTests();
  const request: TranslationRequest = {
    provider: "vertex_gemini",
    model: "gemini-3.1-flash-lite-preview",
    source_language: "English",
    target_language: "German",
    nodes: [{ node_id: "n1", text: "Hello world" }],
  };

  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);

    if (url.includes("metadata.google.internal")) {
      return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: "Quota exceeded for generateContent",
        },
      }),
      {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }
    );
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => translateWithVertexGemini(createConfig(), request),
      /Vertex AI request failed with status 429: RESOURCE_EXHAUSTED - code 429 - Quota exceeded for generateContent/
    );
  } finally {
    globalThis.fetch = originalFetch;
    __resetAccessTokenCacheForTests();
  }
});
