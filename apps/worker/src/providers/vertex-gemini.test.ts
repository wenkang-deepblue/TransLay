import test from "node:test";
import assert from "node:assert/strict";
import type { WorkerConfig } from "@translay/shared-config";
import type { TranslationRequest } from "@translay/shared-contracts";
import {
  __resetAccessTokenCacheForTests,
  translateWithVertexGemini,
} from "./vertex-gemini";
import {
  __resetVertexCallBudgetForTests,
  __setVertexBudgetSleepForTests,
} from "./vertex-call-budget";

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
      poolMax: 20,
    },
    redis: {
      host: "localhost",
      port: 6379,
    },
    vertex: {
      model: "gemini-3.1-flash-lite-preview",
      location: "global",
    },
    gemmaGpu: {
      url: "",
    },
    cloudTasks: {
      queueName: "YOUR_CLOUD_TASKS_QUEUE",
      location: "us-central1",
      workerUrl: "https://worker.example.com",
      audience: "",
      invokerServiceAccount: "",
    },
    debug: {
      captureLlmOutputs: false,
      allowDevTestRawOutputPersistence: false,
      llmOutputRetentionHours: 72,
    },
    security: {
      kmsKeyName: null,
    },
  };
}

test("translateWithVertexGemini sends system instructions and a constrained JSON schema", async () => {
  __resetAccessTokenCacheForTests();
  __resetVertexCallBudgetForTests();
  __setVertexBudgetSleepForTests(async () => {});
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
              bullet: { nesting_level: 0 },
              style_roles: ["default"],
              segments: [
                {
                  segment_id: "r0",
                  text: "Presentation overview",
                  style_role: "default",
                },
              ],
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
              parts: [
                {
                  text: JSON.stringify([
                    {
                      node_id: "n1",
                      translated_full_text: "演示概览",
                      paragraphs: [
                        {
                          paragraph_id: "p0",
                          translated_text: "演示概览",
                          bullet_behavior: "preserve",
                        },
                      ],
                      segments: [
                        {
                          segment_id: "r0",
                          translated_text: "演示概览",
                          style_role: "default",
                        },
                      ],
                      risk_flags: [],
                    },
                  ]),
                },
              ],
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

    assert.equal(result.nodes[0]?.translated_full_text, "演示概览");
    assert.deepEqual(result.nodes[0]?.paragraphs, [
      {
        paragraph_id: "p0",
        translated_text: "演示概览",
        bullet_behavior: "preserve",
      },
    ]);
    assert.deepEqual(result.nodes[0]?.segments, [
      {
        segment_id: "r0",
        translated_text: "演示概览",
        style_role: "default",
      },
    ]);
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
    assert.match(userPrompt, /TARGET NODE STRUCTURE/i);
    assert.match(userPrompt, /segment_id/);
    assert.match(userPrompt, /bullet_behavior/);
    assert.match(userPrompt, /PROMPT SAFETY RULES:/);
    assert.match(userPrompt, /<BEGIN_OPAQUE_USER_DATA_JSON>/);
    assert.match(userPrompt, /<END_OPAQUE_USER_DATA_JSON>/);
    assert.match(userPrompt, /Translate only the target nodes/i);
    assert.doesNotMatch(userPrompt, /for reference only/i);
    assert.doesNotMatch(
      userPrompt,
      /The same term must be translated the same way throughout/i
    );

    assert.equal(body.generationConfig?.responseMimeType, "application/json");
    assert.equal(body.generationConfig?.maxOutputTokens, 65535);
    assert.deepEqual(body.safetySettings, [
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
    ]);
    assert.equal(responseSchema.type, "ARRAY");
    assert.equal(responseSchema.minItems, 1);
    assert.equal(responseSchema.maxItems, 1);
    assert.ok((responseSchema.items as Record<string, unknown>).properties);
    const itemSchema = responseSchema.items as {
      properties: Record<string, unknown>;
      required: string[];
    };
    assert.deepEqual(itemSchema.required, [
      "node_id",
      "translated_full_text",
      "paragraphs",
      "segments",
    ]);
    assert.ok("risk_flags" in itemSchema.properties);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("translateWithVertexGemini retries retryable Vertex responses before succeeding", async () => {
  __resetAccessTokenCacheForTests();
  __resetVertexCallBudgetForTests();
  __setVertexBudgetSleepForTests(async () => {});
  const request: TranslationRequest = {
    provider: "vertex_gemini",
    model: "gemini-3.1-flash-lite-preview",
    source_language: "English",
    target_language: "Chinese",
    context_pack: {
      deck_title: "Q3 Product Presentation",
      source_language: "English",
      target_language: "Chinese",
      deck_plaintext_context: "[Slide 1] Product presentation",
      glossary_candidates: [],
      nodes: [
        {
          node_id: "n1",
          archetype: "plain_text",
          slide_index: 1,
          full_text: "Presentation overview",
          paragraphs: [
            {
              paragraph_id: "p0",
              text: "Presentation overview",
              style_roles: ["default"],
              segments: [
                {
                  segment_id: "r0",
                  text: "Presentation overview",
                  style_role: "default",
                },
              ],
            },
          ],
        },
      ],
    },
    nodes: [{ node_id: "n1", text: "Presentation overview" }],
  };

  const originalFetch = globalThis.fetch;
  let modelAttempts = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("metadata.google.internal")) {
      return new Response(JSON.stringify({ access_token: "test-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    modelAttempts += 1;
    if (modelAttempts === 1) {
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "1",
        },
      });
    }

    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify([
                    {
                      node_id: "n1",
                      translated_full_text: "演示概览",
                      paragraphs: [
                        {
                          paragraph_id: "p0",
                          translated_text: "演示概览",
                          bullet_behavior: "none",
                        },
                      ],
                      segments: [
                        {
                          segment_id: "r0",
                          translated_text: "演示概览",
                          style_role: "default",
                        },
                      ],
                    },
                  ]),
                },
              ],
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
    assert.equal(result.nodes[0]?.translated_full_text, "演示概览");
    assert.equal(modelAttempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("translateWithVertexGemini rejects empty bullet paragraphs in structured output", async () => {
  __resetAccessTokenCacheForTests();
  __resetVertexCallBudgetForTests();
  __setVertexBudgetSleepForTests(async () => {});
  const request: TranslationRequest = {
    provider: "vertex_gemini",
    model: "gemini-3.1-flash-lite-preview",
    source_language: "English",
    target_language: "Spanish",
    context_pack: {
      deck_title: "Board deck",
      source_language: "English",
      target_language: "Spanish",
      deck_plaintext_context: "[Slide 1] Revenue grew\n[Slide 1] Enterprise expansion",
      glossary_candidates: [],
      nodes: [
        {
          node_id: "bullet-1",
          archetype: "bullet_list",
          slide_index: 1,
          full_text: "Revenue grew\nEnterprise expansion",
          paragraphs: [
            {
              paragraph_id: "p0",
              text: "Revenue grew",
              bullet: { nesting_level: 0 },
              style_roles: ["default"],
              segments: [
                {
                  segment_id: "r0",
                  text: "Revenue grew",
                  style_role: "default",
                },
              ],
            },
            {
              paragraph_id: "p1",
              text: "Enterprise expansion",
              bullet: { nesting_level: 0 },
              style_roles: ["default"],
              segments: [
                {
                  segment_id: "r1",
                  text: "Enterprise expansion",
                  style_role: "default",
                },
              ],
            },
          ],
        },
      ],
    },
    nodes: [{ node_id: "bullet-1", text: "Revenue grew\nEnterprise expansion" }],
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
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify([
                    {
                      node_id: "bullet-1",
                      translated_full_text: "Los ingresos crecieron\n",
                      paragraphs: [
                        {
                          paragraph_id: "p0",
                          translated_text: "Los ingresos crecieron",
                          bullet_behavior: "preserve",
                        },
                        {
                          paragraph_id: "p1",
                          translated_text: "",
                          bullet_behavior: "preserve",
                        },
                      ],
                      segments: [
                        {
                          segment_id: "r0",
                          translated_text: "Los ingresos crecieron",
                          style_role: "default",
                        },
                        {
                          segment_id: "r1",
                          translated_text: "",
                          style_role: "default",
                        },
                      ],
                    },
                  ]),
                },
              ],
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
    await assert.rejects(
      () => translateWithVertexGemini(createConfig(), request),
      /empty paragraph/i
    );
  } finally {
    globalThis.fetch = originalFetch;
    __resetAccessTokenCacheForTests();
  }
});

test("translateWithVertexGemini preserves source boundary whitespace, rebuilds structured text, and emits debug capture", async () => {
  __resetAccessTokenCacheForTests();
  const request: TranslationRequest = {
    provider: "vertex_gemini",
    model: "gemini-3.1-flash-lite-preview",
    source_language: "English",
    target_language: "Chinese",
    context_pack: {
      deck_title: "Whitespace deck",
      source_language: "English",
      target_language: "Chinese",
      deck_plaintext_context: "[Slide 1] Alpha\n[Slide 1] Beta",
      glossary_candidates: [],
      nodes: [
        {
          node_id: "n1",
          archetype: "plain_text",
          slide_index: 1,
          full_text: "   Alpha\n  Beta",
          paragraphs: [
            {
              paragraph_id: "p0",
              text: "   Alpha",
              bullet: undefined,
              style_roles: ["default"],
              segments: [
                {
                  segment_id: "r0",
                  text: "   Alpha",
                  style_role: "default",
                },
              ],
            },
            {
              paragraph_id: "p1",
              text: "  Beta",
              bullet: undefined,
              style_roles: ["default"],
              segments: [
                {
                  segment_id: "r1",
                  text: "  Beta",
                  style_role: "default",
                },
              ],
            },
          ],
        },
      ],
    },
    nodes: [{ node_id: "n1", text: "   Alpha\n  Beta" }],
  };

  const debugEvents: Array<{ raw_output_text?: string }> = [];
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
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify([
                    {
                      node_id: "n1",
                      translated_full_text: "wrong",
                      paragraphs: [
                        {
                          paragraph_id: "p0",
                          translated_text: "wrong-1",
                          bullet_behavior: "none",
                        },
                        {
                          paragraph_id: "p1",
                          translated_text: "wrong-2",
                          bullet_behavior: "none",
                        },
                      ],
                      segments: [
                        {
                          segment_id: "r0",
                          translated_text: "甲",
                          style_role: "default",
                        },
                        {
                          segment_id: "r1",
                          translated_text: "乙",
                          style_role: "default",
                        },
                      ],
                    },
                  ]),
                },
              ],
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
    const result = await translateWithVertexGemini(createConfig(), request, {
      stage: "translation",
      callLabel: "unit_translation",
      debugCapture: async (event) => {
        debugEvents.push(event);
      },
    });

    assert.equal(result.nodes[0]?.translated_full_text, "   甲\n  乙");
    assert.deepEqual(result.nodes[0]?.paragraphs, [
      {
        paragraph_id: "p0",
        translated_text: "   甲",
        bullet_behavior: "none",
      },
      {
        paragraph_id: "p1",
        translated_text: "  乙",
        bullet_behavior: "none",
      },
    ]);
    assert.deepEqual(result.nodes[0]?.segments, [
      {
        segment_id: "r0",
        translated_text: "   甲",
        style_role: "default",
      },
      {
        segment_id: "r1",
        translated_text: "  乙",
        style_role: "default",
      },
    ]);
    assert.equal(debugEvents.length, 1);
    assert.match(
      JSON.stringify(debugEvents[0]),
      /unit_translation/
    );
    assert.match(
      JSON.stringify(debugEvents[0]),
      /"capture_status":"success"/
    );
    assert.equal(debugEvents[0]?.raw_output_text, JSON.stringify([
      {
        node_id: "n1",
        translated_full_text: "wrong",
        paragraphs: [
          {
            paragraph_id: "p0",
            translated_text: "wrong-1",
            bullet_behavior: "none",
          },
          {
            paragraph_id: "p1",
            translated_text: "wrong-2",
            bullet_behavior: "none",
          },
        ],
        segments: [
          {
            segment_id: "r0",
            translated_text: "甲",
            style_role: "default",
          },
          {
            segment_id: "r1",
            translated_text: "乙",
            style_role: "default",
          },
        ],
      },
    ]));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("translateWithVertexGemini rejects segment count mismatch in structured output", async () => {
  __resetAccessTokenCacheForTests();
  const request: TranslationRequest = {
    provider: "vertex_gemini",
    model: "gemini-3.1-flash-lite-preview",
    source_language: "English",
    target_language: "French",
    context_pack: {
      deck_title: "Segment deck",
      source_language: "English",
      target_language: "French",
      deck_plaintext_context: "[Slide 1] ARR growth",
      glossary_candidates: [],
      nodes: [
        {
          node_id: "metric-1",
          archetype: "metric_card",
          slide_index: 1,
          full_text: "$68B ARR",
          paragraphs: [
            {
              paragraph_id: "p0",
              text: "$68B ARR",
              style_roles: ["prefix", "metric_value"],
              segments: [
                {
                  segment_id: "r0",
                  text: "$",
                  style_role: "prefix",
                },
                {
                  segment_id: "r1",
                  text: "68B ARR",
                  style_role: "metric_value",
                },
              ],
            },
          ],
        },
      ],
    },
    nodes: [{ node_id: "metric-1", text: "$68B ARR" }],
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
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify([
                    {
                      node_id: "metric-1",
                      translated_full_text: "68 Md ARR",
                      paragraphs: [
                        {
                          paragraph_id: "p0",
                          translated_text: "68 Md ARR",
                          bullet_behavior: "none",
                        },
                      ],
                      segments: [
                        {
                          segment_id: "r1",
                          translated_text: "68 Md ARR",
                          style_role: "metric_value",
                        },
                      ],
                    },
                  ]),
                },
              ],
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
    await assert.rejects(
      () => translateWithVertexGemini(createConfig(), request),
      /segment count does not match source structure/i
    );
  } finally {
    globalThis.fetch = originalFetch;
    __resetAccessTokenCacheForTests();
  }
});

test("translateWithVertexGemini rejects duplicate segment_id in structured output", async () => {
  __resetAccessTokenCacheForTests();
  const request: TranslationRequest = {
    provider: "vertex_gemini",
    model: "gemini-3.1-flash-lite-preview",
    source_language: "English",
    target_language: "German",
    context_pack: {
      deck_title: "Duplicate segment deck",
      source_language: "English",
      target_language: "German",
      deck_plaintext_context: "[Slide 1] Revenue growth",
      glossary_candidates: [],
      nodes: [
        {
          node_id: "plain-1",
          archetype: "plain_text",
          slide_index: 1,
          full_text: "Revenue growth",
          paragraphs: [
            {
              paragraph_id: "p0",
              text: "Revenue growth",
              style_roles: ["default", "emphasis"],
              segments: [
                {
                  segment_id: "r0",
                  text: "Revenue ",
                  style_role: "default",
                },
                {
                  segment_id: "r1",
                  text: "growth",
                  style_role: "emphasis",
                },
              ],
            },
          ],
        },
      ],
    },
    nodes: [{ node_id: "plain-1", text: "Revenue growth" }],
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
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify([
                    {
                      node_id: "plain-1",
                      translated_full_text: "Umsatzwachstum",
                      paragraphs: [
                        {
                          paragraph_id: "p0",
                          translated_text: "Umsatzwachstum",
                          bullet_behavior: "none",
                        },
                      ],
                      segments: [
                        {
                          segment_id: "r0",
                          translated_text: "Umsatz",
                          style_role: "default",
                        },
                        {
                          segment_id: "r0",
                          translated_text: "wachstum",
                          style_role: "emphasis",
                        },
                      ],
                    },
                  ]),
                },
              ],
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
    await assert.rejects(
      () => translateWithVertexGemini(createConfig(), request),
      /duplicate segment_id/i
    );
  } finally {
    globalThis.fetch = originalFetch;
    __resetAccessTokenCacheForTests();
  }
});

test("translateWithVertexGemini rebuilds paragraph text from segments when the model output disagrees", async () => {
  __resetAccessTokenCacheForTests();
  const request: TranslationRequest = {
    provider: "vertex_gemini",
    model: "gemini-3.1-flash-lite-preview",
    source_language: "English",
    target_language: "Japanese",
    context_pack: {
      deck_title: "Concatenation deck",
      source_language: "English",
      target_language: "Japanese",
      deck_plaintext_context: "[Slide 1] Customer growth",
      glossary_candidates: [],
      nodes: [
        {
          node_id: "plain-2",
          archetype: "plain_text",
          slide_index: 1,
          full_text: "Customer growth",
          paragraphs: [
            {
              paragraph_id: "p0",
              text: "Customer growth",
              style_roles: ["default", "emphasis"],
              segments: [
                {
                  segment_id: "r0",
                  text: "Customer ",
                  style_role: "default",
                },
                {
                  segment_id: "r1",
                  text: "growth",
                  style_role: "emphasis",
                },
              ],
            },
          ],
        },
      ],
    },
    nodes: [{ node_id: "plain-2", text: "Customer growth" }],
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
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify([
                    {
                      node_id: "plain-2",
                      translated_full_text: "顧客の成長",
                      paragraphs: [
                        {
                          paragraph_id: "p0",
                          translated_text: "顧客の成長",
                          bullet_behavior: "none",
                        },
                      ],
                      segments: [
                        {
                          segment_id: "r0",
                          translated_text: "顧客",
                          style_role: "default",
                        },
                        {
                          segment_id: "r1",
                          translated_text: "成長",
                          style_role: "emphasis",
                        },
                      ],
                    },
                  ]),
                },
              ],
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
    assert.equal(result.nodes[0]?.translated_full_text, "顧客 成長");
    assert.equal(result.nodes[0]?.paragraphs[0]?.translated_text, "顧客 成長");
    assert.deepEqual(result.nodes[0]?.segments, [
      {
        segment_id: "r0",
        translated_text: "顧客 ",
        style_role: "default",
      },
      {
        segment_id: "r1",
        translated_text: "成長",
        style_role: "emphasis",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    __resetAccessTokenCacheForTests();
  }
});

test("translateWithVertexGemini rejects empty node_id in structured output", async () => {
  __resetAccessTokenCacheForTests();
  const request: TranslationRequest = {
    provider: "vertex_gemini",
    model: "gemini-3.1-flash-lite-preview",
    source_language: "English",
    target_language: "Italian",
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
        candidates: [
          {
            content: {
              parts: [
                {
                  text: '[{"node_id":"","translated_full_text":"Ciao mondo","paragraphs":[{"paragraph_id":"p0","translated_text":"Ciao mondo","bullet_behavior":"none"}],"segments":[{"segment_id":"r0","translated_text":"Ciao mondo","style_role":"default"}]}]',
                },
              ],
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
    await assert.rejects(
      () => translateWithVertexGemini(createConfig(), request),
      /must be a non-empty string/i
    );
  } finally {
    globalThis.fetch = originalFetch;
    __resetAccessTokenCacheForTests();
  }
});

test("translateWithVertexGemini reuses cached access tokens across requests", async () => {
  __resetAccessTokenCacheForTests();

  const request: TranslationRequest = {
    provider: "vertex_gemini",
    model: "gemini-3.1-flash-lite-preview",
    source_language: "English",
    target_language: "French",
    context_pack: {
      deck_title: "Greeting deck",
      source_language: "English",
      target_language: "French",
      deck_plaintext_context: "[Slide 1] Hello world",
      glossary_candidates: [],
      nodes: [
        {
          node_id: "n1",
          archetype: "plain_text",
          slide_index: 1,
          full_text: "Hello world",
          paragraphs: [
            {
              paragraph_id: "p0",
              text: "Hello world",
              style_roles: ["default"],
              segments: [
                {
                  segment_id: "r0",
                  text: "Hello world",
                  style_role: "default",
                },
              ],
            },
          ],
        },
      ],
    },
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
              parts: [
                {
                  text: '[{"node_id":"n1","translated_full_text":"Bonjour le monde","paragraphs":[{"paragraph_id":"p0","translated_text":"Bonjour le monde","bullet_behavior":"none"}],"segments":[{"segment_id":"r0","translated_text":"Bonjour le monde","style_role":"default"}]}]',
                },
              ],
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
