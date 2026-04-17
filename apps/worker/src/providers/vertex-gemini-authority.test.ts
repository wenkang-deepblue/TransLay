import test from "node:test";
import assert from "node:assert/strict";
import type { WorkerConfig } from "@translay/shared-config";
import type {
  AuthorityTranslationNode,
  TranslationContextNodeSummary,
} from "@translay/shared-contracts";
import { __resetAccessTokenCacheForTests } from "./vertex-gemini";
import {
  __resetVertexCallBudgetForTests,
  __setVertexBudgetSleepForTests,
} from "./vertex-call-budget";
import {
  fillMissingAuthorityWithVertexGemini,
  materializeTranslatedNodesWithVertexGemini,
  translateDeckAuthorityWithVertexGemini,
} from "./vertex-gemini-authority";

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
  };
}

function createMaterializationNodeSummary(
  overrides: Partial<TranslationContextNodeSummary> & {
    readonly node_id: string;
    readonly archetype: TranslationContextNodeSummary["archetype"];
    readonly slide_index: number;
    readonly paragraphs: TranslationContextNodeSummary["paragraphs"];
  }
): TranslationContextNodeSummary {
  return {
    node_id: overrides.node_id,
    archetype: overrides.archetype,
    slide_index: overrides.slide_index,
    full_text:
      overrides.full_text ??
      overrides.paragraphs.map((paragraph) => paragraph.text).join("\n"),
    paragraphs: overrides.paragraphs,
  };
}

test("translateDeckAuthorityWithVertexGemini sends deck overview and local window frames and parses authority nodes", async () => {
  __resetAccessTokenCacheForTests();
  __resetVertexCallBudgetForTests();
  __setVertexBudgetSleepForTests(async () => {});
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const debugEvents: Array<{ raw_output_text?: string }> = [];
  const lifecycleNodeBatches: string[][] = [];
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
                      slide_index: 1,
                      translated_full_text: "演示概览",
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
    const result = await translateDeckAuthorityWithVertexGemini(createConfig(), {
      model: "gemini-3.1-flash-lite-preview",
      source_language: "English",
      target_language: "Chinese",
      deck_title: "Q3 Product Presentation",
      deck_plaintext_context: "[Slide 1] Presentation overview",
      glossary_candidates: [{ source_term: "ARR", occurrences: 3 }],
      nodes: [
        {
          node_id: "n1",
          slide_index: 1,
          object_id: "shape_1",
          element_type: "shape",
          archetype: "plain_text",
          full_text: "Presentation overview",
        },
      ],
      visual_context: {
        deck_overview_frames: [
          {
            slide_index: 0,
            slide_object_id: "slide_0",
            mime_type: "image/png",
            base64_data: "b3ZlcnZpZXc=",
          },
        ],
        local_window_frames: [
          {
            slide_index: 1,
            slide_object_id: "slide_1",
            mime_type: "image/png",
            base64_data: "bG9jYWw=",
          },
        ],
      },
      debugCapture: async (event) => {
        debugEvents.push(event);
      },
      with_chunk_lifecycle: async (nodes, run) => {
        lifecycleNodeBatches.push(nodes.map((node) => node.node_id));
        return run();
      },
      debugLabel: "authority_test",
    });

    assert.equal(result.nodes[0]?.node_id, "n1");
    assert.equal(result.nodes[0]?.translated_full_text, "演示概览");
    assert.equal(result.nodes[0]?.preferred_terms_used, undefined);
    assert.equal(result.nodes[0]?.notes, undefined);
    assert.equal(fetchCalls.length, 2);

    const body = JSON.parse(String(fetchCalls[1]?.init?.body ?? "{}"));
    const parts = body.contents?.[0]?.parts as Array<Record<string, unknown>>;
    assert.equal(parts.length, 5);
    assert.match(String(parts[0]?.text ?? ""), /SOURCE NODE INDEX/);
    assert.match(String(parts[0]?.text ?? ""), /PROMPT SAFETY RULES:/);
    assert.equal(parts[1]?.text, "Deck overview frame for slide 0");
    assert.deepEqual(parts[2]?.inlineData, {
      mimeType: "image/png",
      data: "b3ZlcnZpZXc=",
    });
    assert.equal(parts[3]?.text, "Local visual reference for slide 1");
    assert.deepEqual(parts[4]?.inlineData, {
      mimeType: "image/png",
      data: "bG9jYWw=",
    });

    const schema = body.generationConfig?.responseSchema as {
      items: { required: string[]; properties: Record<string, unknown> };
    };
    assert.equal(body.generationConfig?.maxOutputTokens, 65535);
    assert.deepEqual(body.safetySettings, [
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
    ]);
    assert.deepEqual(schema.items.required, [
      "node_id",
      "slide_index",
      "translated_full_text",
    ]);
    assert.ok("preferred_terms_used" in schema.items.properties);
    assert.ok("notes" in schema.items.properties);
    assert.ok(!("coverage_status" in schema.items.properties));
    assert.equal(debugEvents.length, 1);
    assert.match(JSON.stringify(debugEvents[0]), /authority_test/);
    assert.match(JSON.stringify(debugEvents[0]), /"capture_status":"success"/);
    assert.match(String(debugEvents[0]?.raw_output_text ?? ""), /"node_id":"n1"/);
    assert.deepEqual(lifecycleNodeBatches, [["n1"]]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fillMissingAuthorityWithVertexGemini includes deck-wide authority context for terminology alignment", async () => {
  __resetAccessTokenCacheForTests();
  __resetVertexCallBudgetForTests();
  __setVertexBudgetSleepForTests(async () => {});
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
                      node_id: "n3",
                      slide_index: 2,
                      translated_full_text: "年度经常性收入",
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
    const result = await fillMissingAuthorityWithVertexGemini(createConfig(), {
      model: "gemini-3.1-flash-lite-preview",
      source_language: "English",
      target_language: "Chinese",
      deck_title: "Q3 Product Presentation",
      slide_index: 2,
      slide_plaintext_context: "[Slide 2] ARR forecast",
      glossary_candidates: [{ source_term: "ARR", occurrences: 3 }],
      existing_authority_nodes: [
        {
          node_id: "n1",
          slide_index: 1,
          translated_full_text: "年度经常性收入",
        },
        {
          node_id: "n2",
          slide_index: 5,
          translated_full_text: "ARR 保持一致",
        },
      ],
      missing_nodes: [
        {
          node_id: "n3",
          slide_index: 2,
          object_id: "shape_3",
          element_type: "shape",
          archetype: "plain_text",
          full_text: "ARR forecast",
        },
      ],
      storyboard_frame: {
        slide_index: 2,
        slide_object_id: "slide_2",
        mime_type: "image/png",
        base64_data: "ZmFrZQ==",
      },
    });

    assert.equal(result.nodes[0]?.translated_full_text, "年度经常性收入");

    const body = JSON.parse(String(fetchCalls[1]?.init?.body ?? "{}"));
    const prompt = String(body.contents?.[0]?.parts?.[0]?.text ?? "");
    assert.match(prompt, /whole deck/);
    assert.match(prompt, /PROMPT SAFETY RULES:/);
    assert.match(prompt, /"slide_index": 1/);
    assert.match(prompt, /"slide_index": 5/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("translateDeckAuthorityWithVertexGemini splits a failed mixed-slide chunk into smaller retries", async () => {
  __resetAccessTokenCacheForTests();
  __resetVertexCallBudgetForTests();
  __setVertexBudgetSleepForTests(async () => {});
  const originalMaxAttempts = process.env.VERTEX_CALL_BUDGET_MAX_ATTEMPTS;
  process.env.VERTEX_CALL_BUDGET_MAX_ATTEMPTS = "1";
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
    const body = JSON.parse(String(init?.body ?? "{}"));
    const promptText = String(body.contents?.[0]?.parts?.[0]?.text ?? "");
    const sourceSection = promptText.slice(promptText.lastIndexOf("SOURCE NODE INDEX"));
    const includesFirstSlide = sourceSection.includes('"node_id": "n1"');
    const includesSecondSlide = sourceSection.includes('"node_id": "n2"');

    if (includesFirstSlide && includesSecondSlide) {
      return new Response(JSON.stringify({ error: { message: "layout too large" } }), {
        status: 503,
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
                  text: JSON.stringify(
                    includesFirstSlide
                      ? [
                          {
                            node_id: "n1",
                            slide_index: 0,
                            translated_full_text: "第一页",
                          },
                        ]
                      : [
                          {
                            node_id: "n2",
                            slide_index: 1,
                            translated_full_text: "第二页",
                          },
                        ]
                  ),
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
    const result = await translateDeckAuthorityWithVertexGemini(createConfig(), {
      model: "gemini-3.1-flash-lite-preview",
      source_language: "English",
      target_language: "Chinese",
      deck_title: "Q3 Product Presentation",
      deck_plaintext_context: "[Slide 1] Intro\n[Slide 2] Metrics",
      glossary_candidates: [],
      nodes: [
        {
          node_id: "n1",
          slide_index: 0,
          object_id: "shape_1",
          element_type: "shape",
          archetype: "plain_text",
          full_text: "Intro",
        },
        {
          node_id: "n2",
          slide_index: 1,
          object_id: "shape_2",
          element_type: "shape",
          archetype: "plain_text",
          full_text: "Metrics",
        },
      ],
      visual_context: {
        deck_overview_frames: [],
      },
    });

    assert.deepEqual(
      result.nodes.map((node) => node.node_id).sort(),
      ["n1", "n2"]
    );
    assert.equal(modelAttempts, 3);
  } finally {
    if (originalMaxAttempts === undefined) {
      delete process.env.VERTEX_CALL_BUDGET_MAX_ATTEMPTS;
    } else {
      process.env.VERTEX_CALL_BUDGET_MAX_ATTEMPTS = originalMaxAttempts;
    }
    __resetVertexCallBudgetForTests();
    globalThis.fetch = originalFetch;
  }
});

test("translateDeckAuthorityWithVertexGemini surfaces quota exhaustion instead of downgrading to partial success", async () => {
  __resetAccessTokenCacheForTests();
  __resetVertexCallBudgetForTests();
  __setVertexBudgetSleepForTests(async () => {});
  const originalFetch = globalThis.fetch;
  let modelAttempts = 0;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("metadata.google.internal")) {
      return new Response(JSON.stringify({ access_token: "test-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    modelAttempts += 1;
    return new Response(JSON.stringify({ error: { message: "resource exhausted" } }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "1",
      },
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      () =>
        translateDeckAuthorityWithVertexGemini(createConfig(), {
          model: "gemini-3.1-flash-lite-preview",
          source_language: "English",
          target_language: "Chinese",
          deck_title: "Q3 Product Presentation",
          deck_plaintext_context: "[Slide 1] Intro\n[Slide 2] Metrics",
          glossary_candidates: [],
          nodes: [
            {
              node_id: "n1",
              slide_index: 0,
              object_id: "shape_1",
              element_type: "shape",
              archetype: "plain_text",
              full_text: "Intro",
            },
            {
              node_id: "n2",
              slide_index: 1,
              object_id: "shape_2",
              element_type: "shape",
              archetype: "plain_text",
              full_text: "Metrics",
            },
          ],
          visual_context: {
            deck_overview_frames: [],
          },
        }),
      (error: unknown) => {
        assert.equal((error as Error & { code?: unknown }).code, "VERTEX_QUOTA_EXHAUSTED");
        return true;
      }
    );
    assert.equal(modelAttempts, 6);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("translateDeckAuthorityWithVertexGemini batches authority requests at 20 nodes and rebuilds local window frames per chunk", async () => {
  __resetAccessTokenCacheForTests();
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const localWindowNodeIds: string[][] = [];
  const lifecycleNodeBatches: string[][] = [];
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

    const body = JSON.parse(String(init?.body ?? "{}"));
    const maxItems = Number(body?.generationConfig?.responseSchema?.maxItems ?? 0);
    const prompt = String(body?.contents?.[0]?.parts?.[0]?.text ?? "");
    const [, sourceNodeSection = ""] =
      prompt.match(/SOURCE NODE INDEX:\n([\s\S]*)$/) ?? [];
    const nodeIds = [...sourceNodeSection.matchAll(/"node_id":\s*"(n\d+)"/g)].map(
      (match) => match[1]
    );

    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify(
                    nodeIds.slice(0, maxItems).map((nodeId) => ({
                      node_id: nodeId,
                      slide_index: 1,
                      translated_full_text: `${nodeId}-translated`,
                    }))
                  ),
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
    const result = await translateDeckAuthorityWithVertexGemini(createConfig(), {
      model: "gemini-3.1-flash-lite-preview",
      source_language: "English",
      target_language: "Chinese",
      deck_title: "Q3 Product Presentation",
      deck_plaintext_context: "[Slide 1] Presentation overview",
      glossary_candidates: [{ source_term: "ARR", occurrences: 3 }],
      nodes: Array.from({ length: 21 }, (_, index) => ({
        node_id: `n${index + 1}`,
        slide_index: 1,
        object_id: `shape_${index + 1}`,
        element_type: "shape" as const,
        archetype: "plain_text",
        full_text: `Presentation overview ${index + 1}`,
      })),
      visual_context: {
        deck_overview_frames: [
          {
            slide_index: 0,
            slide_object_id: "slide_0",
            mime_type: "image/png",
            base64_data: "b3ZlcnZpZXc=",
          },
        ],
      },
      build_local_window_frames: async (nodes) => {
        localWindowNodeIds.push(nodes.map((node) => node.node_id));
        return [
          {
            slide_index: 1,
            slide_object_id: "slide_1",
            mime_type: "image/png",
            base64_data: Buffer.from(nodes.map((node) => node.node_id).join(",")).toString("base64"),
          },
        ];
      },
      with_chunk_lifecycle: async (nodes, run) => {
        lifecycleNodeBatches.push(nodes.map((node) => node.node_id));
        return run();
      },
    });

    assert.equal(result.nodes.length, 21);
    assert.equal(result.nodes[0]?.translated_full_text, "n1-translated");
    assert.equal(result.nodes[20]?.translated_full_text, "n21-translated");

    const generateCalls = fetchCalls.filter(
      (call) => !call.url.includes("metadata.google.internal")
    );
    assert.equal(generateCalls.length, 2);

    const firstBody = JSON.parse(String(generateCalls[0]?.init?.body ?? "{}"));
    const secondBody = JSON.parse(String(generateCalls[1]?.init?.body ?? "{}"));
    assert.equal(firstBody.generationConfig?.maxOutputTokens, 65535);
    assert.equal(secondBody.generationConfig?.maxOutputTokens, 65535);
    assert.equal(firstBody.generationConfig?.responseSchema?.maxItems, 20);
    assert.equal(secondBody.generationConfig?.responseSchema?.maxItems, 1);
    assert.match(
      String(secondBody.contents?.[0]?.parts?.[0]?.text ?? ""),
      /ALREADY TRANSLATED AUTHORITY NODES/
    );
    assert.match(
      String(secondBody.contents?.[0]?.parts?.[0]?.text ?? ""),
      /n20-translated/
    );
    assert.deepEqual(localWindowNodeIds, [
      Array.from({ length: 20 }, (_, index) => `n${index + 1}`),
      ["n21"],
    ]);
    assert.deepEqual(lifecycleNodeBatches, [
      Array.from({ length: 20 }, (_, index) => `n${index + 1}`),
      ["n21"],
    ]);
    assert.equal(firstBody.contents?.[0]?.parts?.[1]?.text, "Deck overview frame for slide 0");
    assert.equal(firstBody.contents?.[0]?.parts?.[3]?.text, "Local visual reference for slide 1");
    assert.deepEqual(firstBody.contents?.[0]?.parts?.[4]?.inlineData, {
      mimeType: "image/png",
      data: Buffer.from(Array.from({ length: 20 }, (_, index) => `n${index + 1}`).join(",")).toString("base64"),
    });
    assert.deepEqual(secondBody.contents?.[0]?.parts?.[4]?.inlineData, {
      mimeType: "image/png",
      data: Buffer.from("n21").toString("base64"),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("materializeTranslatedNodesWithVertexGemini structures authority text into translated nodes", async () => {
  __resetAccessTokenCacheForTests();
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
                      translated_full_text: "演示\n概览",
                      paragraphs: [
                        {
                          paragraph_id: "p0",
                          translated_text: "演示",
                          bullet_behavior: "none",
                        },
                        {
                          paragraph_id: "p1",
                          translated_text: "概览",
                          bullet_behavior: "none",
                        },
                      ],
                      segments: [
                        {
                          segment_id: "r0",
                          translated_text: "演示",
                          style_role: "default",
                        },
                        {
                          segment_id: "r1",
                          translated_text: "概览",
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

  const nodeSummaries: TranslationContextNodeSummary[] = [
    {
      node_id: "n1",
      archetype: "plain_text",
      slide_index: 1,
      full_text: "Presentation overview",
      paragraphs: [
        {
          paragraph_id: "p0",
          text: "Presentation",
          style_roles: ["default"],
          segments: [
            {
              segment_id: "r0",
              text: "Presentation",
              style_role: "default",
            },
          ],
        },
        {
          paragraph_id: "p1",
          text: "overview",
          style_roles: ["default"],
          segments: [
            {
              segment_id: "r1",
              text: "overview",
              style_role: "default",
            },
          ],
        },
      ],
    },
  ];
  const authorityNodes: AuthorityTranslationNode[] = [
    {
      node_id: "n1",
      slide_index: 1,
      translated_full_text: "演示\n概览",
    },
  ];

  try {
    const result = await materializeTranslatedNodesWithVertexGemini(createConfig(), {
      model: "gemini-3.1-flash-lite-preview",
      source_language: "English",
      target_language: "Chinese",
      deck_title: "Q3 Product Presentation",
      glossary_candidates: [],
      node_summaries: nodeSummaries,
      authority_nodes: authorityNodes,
    });

    assert.equal(result.nodes[0]?.translated_full_text, "演示\n概览");
    assert.equal(result.nodes[0]?.paragraphs.length, 2);
    assert.equal(result.nodes[0]?.segments.length, 2);

    const body = JSON.parse(String(fetchCalls[1]?.init?.body ?? "{}"));
    const prompt = String(body.contents?.[0]?.parts?.[0]?.text ?? "");
    assert.match(prompt, /AUTHORITY TEXT/);
    assert.match(prompt, /translated_full_text/);
    assert.match(prompt, /SOURCE STRUCTURE/);
    assert.match(prompt, /PROMPT SAFETY RULES:/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("materializeTranslatedNodesWithVertexGemini repairs bullet behavior from source paragraph structure", async () => {
  __resetAccessTokenCacheForTests();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);

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
                      node_id: "mixed-bullets",
                      translated_full_text:
                        "Intro paragraph\nPrimary item A\nPrimary item B\nNested detail A\nNested detail B\nPrimary item C\nClosing paragraph",
                      paragraphs: [
                        {
                          paragraph_id: "p0",
                          translated_text: "Intro paragraph",
                          bullet_behavior: "none",
                        },
                        {
                          paragraph_id: "p1",
                          translated_text: "Primary item A",
                          bullet_behavior: "none",
                        },
                        {
                          paragraph_id: "p2",
                          translated_text: "Primary item B",
                          bullet_behavior: "preserve",
                        },
                        {
                          paragraph_id: "p3",
                          translated_text: "Nested detail A",
                          bullet_behavior: "none",
                        },
                        {
                          paragraph_id: "p4",
                          translated_text: "Nested detail B",
                          bullet_behavior: "preserve",
                        },
                        {
                          paragraph_id: "p5",
                          translated_text: "Primary item C",
                          bullet_behavior: "none",
                        },
                        {
                          paragraph_id: "p6",
                          translated_text: "Closing paragraph",
                          bullet_behavior: "preserve",
                        },
                      ],
                      segments: [
                        {
                          segment_id: "r0",
                          translated_text: "Intro paragraph",
                          style_role: "default",
                        },
                        {
                          segment_id: "r1",
                          translated_text: "Primary item A",
                          style_role: "default",
                        },
                        {
                          segment_id: "r2",
                          translated_text: "Primary item B",
                          style_role: "default",
                        },
                        {
                          segment_id: "r3",
                          translated_text: "Nested detail A",
                          style_role: "default",
                        },
                        {
                          segment_id: "r4",
                          translated_text: "Nested detail B",
                          style_role: "default",
                        },
                        {
                          segment_id: "r5",
                          translated_text: "Primary item C",
                          style_role: "default",
                        },
                        {
                          segment_id: "r6",
                          translated_text: "Closing paragraph",
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
    const result = await materializeTranslatedNodesWithVertexGemini(createConfig(), {
      model: "gemini-3.1-flash-lite-preview",
      source_language: "Chinese",
      target_language: "English",
      deck_title: "Knowledge Graph Deck",
      glossary_candidates: [],
      node_summaries: [
        createMaterializationNodeSummary({
          node_id: "mixed-bullets",
          archetype: "plain_text",
          slide_index: 49,
          paragraphs: [
            {
              paragraph_id: "p0",
              text: "介绍段",
              style_roles: ["default"],
              segments: [
                {
                  segment_id: "r0",
                  text: "介绍段",
                  style_role: "default",
                },
              ],
            },
            {
              paragraph_id: "p1",
              text: "一级要点 A",
              bullet: { nesting_level: 0 },
              style_roles: ["default"],
              segments: [
                {
                  segment_id: "r1",
                  text: "一级要点 A",
                  style_role: "default",
                },
              ],
            },
            {
              paragraph_id: "p2",
              text: "一级要点 B",
              bullet: { nesting_level: 0 },
              style_roles: ["default"],
              segments: [
                {
                  segment_id: "r2",
                  text: "一级要点 B",
                  style_role: "default",
                },
              ],
            },
            {
              paragraph_id: "p3",
              text: "二级细节 A",
              bullet: { nesting_level: 1 },
              style_roles: ["default"],
              segments: [
                {
                  segment_id: "r3",
                  text: "二级细节 A",
                  style_role: "default",
                },
              ],
            },
            {
              paragraph_id: "p4",
              text: "二级细节 B",
              bullet: { nesting_level: 1 },
              style_roles: ["default"],
              segments: [
                {
                  segment_id: "r4",
                  text: "二级细节 B",
                  style_role: "default",
                },
              ],
            },
            {
              paragraph_id: "p5",
              text: "一级要点 C",
              bullet: { nesting_level: 0 },
              style_roles: ["default"],
              segments: [
                {
                  segment_id: "r5",
                  text: "一级要点 C",
                  style_role: "default",
                },
              ],
            },
            {
              paragraph_id: "p6",
              text: "结束段",
              style_roles: ["default"],
              segments: [
                {
                  segment_id: "r6",
                  text: "结束段",
                  style_role: "default",
                },
              ],
            },
          ],
        }),
      ],
      authority_nodes: [
        {
          node_id: "mixed-bullets",
          slide_index: 49,
          translated_full_text:
            "Intro paragraph\nPrimary item A\nPrimary item B\nNested detail A\nNested detail B\nPrimary item C\nClosing paragraph",
        },
      ],
    });

    assert.deepEqual(result.nodes[0]?.paragraphs, [
      { paragraph_id: "p0", translated_text: "Intro paragraph", bullet_behavior: "none" },
      { paragraph_id: "p1", translated_text: "Primary item A", bullet_behavior: "preserve" },
      { paragraph_id: "p2", translated_text: "Primary item B", bullet_behavior: "preserve" },
      { paragraph_id: "p3", translated_text: "Nested detail A", bullet_behavior: "preserve" },
      { paragraph_id: "p4", translated_text: "Nested detail B", bullet_behavior: "preserve" },
      { paragraph_id: "p5", translated_text: "Primary item C", bullet_behavior: "preserve" },
      { paragraph_id: "p6", translated_text: "Closing paragraph", bullet_behavior: "none" },
    ]);
    assert.equal(
      result.nodes[0]?.translated_full_text,
      "Intro paragraph\nPrimary item A\nPrimary item B\nNested detail A\nNested detail B\nPrimary item C\nClosing paragraph"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("materializeTranslatedNodesWithVertexGemini accepts empty structural segments when paragraph text still reconstructs", async () => {
  __resetAccessTokenCacheForTests();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);

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
                      node_id: "metric-1",
                      translated_full_text: "680亿美元",
                      paragraphs: [
                        {
                          paragraph_id: "p0",
                          translated_text: "680亿美元",
                          bullet_behavior: "none",
                        },
                      ],
                      segments: [
                        {
                          segment_id: "r0",
                          translated_text: "",
                          style_role: "prefix",
                        },
                        {
                          segment_id: "r1",
                          translated_text: "680亿美元",
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

  const nodeSummaries: TranslationContextNodeSummary[] = [
    {
      node_id: "metric-1",
      archetype: "metric_card",
      slide_index: 3,
      full_text: "$ 68B",
      paragraphs: [
        {
          paragraph_id: "p0",
          text: "$ 68B",
          style_roles: ["prefix", "metric_value"],
          segments: [
            {
              segment_id: "r0",
              text: "$ ",
              style_role: "prefix",
            },
            {
              segment_id: "r1",
              text: "68B",
              style_role: "metric_value",
            },
          ],
        },
      ],
    },
  ];
  const authorityNodes: AuthorityTranslationNode[] = [
    {
      node_id: "metric-1",
      slide_index: 3,
      translated_full_text: "680亿美元",
    },
  ];

  try {
    const result = await materializeTranslatedNodesWithVertexGemini(createConfig(), {
      model: "gemini-3.1-flash-lite-preview",
      source_language: "English",
      target_language: "Chinese",
      deck_title: "Q3 Product Presentation",
      glossary_candidates: [],
      node_summaries: nodeSummaries,
      authority_nodes: authorityNodes,
    });

    assert.equal(result.nodes[0]?.translated_full_text, " 680亿美元");
    assert.equal(result.nodes[0]?.segments[0]?.translated_text, " ");
    assert.equal(result.nodes[0]?.segments[1]?.translated_text, "680亿美元");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("materializeTranslatedNodesWithVertexGemini repairs metric card role drift around numeric output", async () => {
  __resetAccessTokenCacheForTests();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);

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
                      node_id: "metric-role-drift",
                      translated_full_text: "400.000 $",
                      paragraphs: [
                        {
                          paragraph_id: "p0",
                          translated_text: "400.000 $",
                          bullet_behavior: "none",
                        },
                      ],
                      segments: [
                        {
                          segment_id: "r0",
                          translated_text: "400.000",
                          style_role: "metric_value",
                        },
                        {
                          segment_id: "r1",
                          translated_text: " ",
                          style_role: "prefix",
                        },
                        {
                          segment_id: "r2",
                          translated_text: "$",
                          style_role: "metric_unit",
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
    const result = await materializeTranslatedNodesWithVertexGemini(createConfig(), {
      model: "gemini-3.1-flash-lite-preview",
      source_language: "English",
      target_language: "German",
      deck_title: "Cloud Migration Deck",
      glossary_candidates: [],
      node_summaries: [
        createMaterializationNodeSummary({
          node_id: "metric-role-drift",
          archetype: "metric_card",
          slide_index: 10,
          paragraphs: [
            {
              paragraph_id: "p0",
              text: "$400K",
              style_roles: ["prefix", "metric_value", "metric_unit"],
              segments: [
                {
                  segment_id: "r0",
                  text: "",
                  style_role: "prefix",
                },
                {
                  segment_id: "r1",
                  text: "400K",
                  style_role: "metric_value",
                },
                {
                  segment_id: "r2",
                  text: "$",
                  style_role: "metric_unit",
                },
              ],
            },
          ],
        }),
      ],
      authority_nodes: [
        {
          node_id: "metric-role-drift",
          slide_index: 10,
          translated_full_text: "400.000 $",
        },
      ],
    });

    assert.equal(result.nodes[0]?.translated_full_text, "400.000 $");
    assert.equal(result.nodes[0]?.paragraphs[0]?.translated_text, "400.000 $");
    assert.deepEqual(
      result.nodes[0]?.segments.map((segment) => ({
        segment_id: segment.segment_id,
        translated_text: segment.translated_text,
        style_role: segment.style_role,
      })),
      [
        { segment_id: "r0", translated_text: "", style_role: "prefix" },
        { segment_id: "r1", translated_text: "400.000", style_role: "metric_value" },
        { segment_id: "r2", translated_text: " $", style_role: "metric_unit" },
      ]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("materializeTranslatedNodesWithVertexGemini repairs metric card when numeric core is stranded in prefix segment", async () => {
  __resetAccessTokenCacheForTests();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);

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
                      node_id: "metric-empty-value",
                      translated_full_text: "400.000 $",
                      paragraphs: [
                        {
                          paragraph_id: "p0",
                          translated_text: "400.000 $",
                          bullet_behavior: "none",
                        },
                      ],
                      segments: [
                        {
                          segment_id: "r0",
                          translated_text: "400.000 ",
                          style_role: "prefix",
                        },
                        {
                          segment_id: "r1",
                          translated_text: "",
                          style_role: "metric_value",
                        },
                        {
                          segment_id: "r2",
                          translated_text: "$",
                          style_role: "metric_unit",
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
    const result = await materializeTranslatedNodesWithVertexGemini(createConfig(), {
      model: "gemini-3.1-flash-lite-preview",
      source_language: "English",
      target_language: "German",
      deck_title: "Cloud Migration Deck",
      glossary_candidates: [],
      node_summaries: [
        createMaterializationNodeSummary({
          node_id: "metric-empty-value",
          archetype: "metric_card",
          slide_index: 10,
          paragraphs: [
            {
              paragraph_id: "p0",
              text: "$400K",
              style_roles: ["prefix", "metric_value", "metric_unit"],
              segments: [
                {
                  segment_id: "r0",
                  text: "",
                  style_role: "prefix",
                },
                {
                  segment_id: "r1",
                  text: "400K",
                  style_role: "metric_value",
                },
                {
                  segment_id: "r2",
                  text: "$",
                  style_role: "metric_unit",
                },
              ],
            },
          ],
        }),
      ],
      authority_nodes: [
        {
          node_id: "metric-empty-value",
          slide_index: 10,
          translated_full_text: "400.000 $",
        },
      ],
    });

    assert.equal(result.nodes[0]?.translated_full_text, "400.000 $");
    assert.equal(result.nodes[0]?.segments[0]?.translated_text, "");
    assert.equal(result.nodes[0]?.segments[1]?.translated_text, "400.000");
    assert.equal(result.nodes[0]?.segments[2]?.translated_text, " $");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("materializeTranslatedNodesWithVertexGemini repairs collapsed paragraph output for default-only multi-paragraph nodes", async () => {
  __resetAccessTokenCacheForTests();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);

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
                      node_id: "plain-multi",
                      translated_full_text: "Datenplattform fur KI und Analytik",
                      paragraphs: [
                        {
                          paragraph_id: "p0",
                          translated_text: "Datenplattform fur KI und Analytik",
                          bullet_behavior: "none",
                        },
                      ],
                      segments: [
                        {
                          segment_id: "r0",
                          translated_text: "Datenplattform fur KI und Analytik",
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
    const result = await materializeTranslatedNodesWithVertexGemini(createConfig(), {
      model: "gemini-3.1-flash-lite-preview",
      source_language: "English",
      target_language: "German",
      deck_title: "OCI Pitch Deck",
      glossary_candidates: [],
      node_summaries: [
        {
          node_id: "plain-multi",
          archetype: "plain_text",
          slide_index: 5,
          full_text: "Data platform\nfor AI and analytics",
          paragraphs: [
            {
              paragraph_id: "p0",
              text: "Data platform",
              style_roles: ["default"],
              segments: [
                {
                  segment_id: "r0",
                  text: "Data platform",
                  style_role: "default",
                },
              ],
            },
            {
              paragraph_id: "p1",
              text: "for AI and analytics",
              style_roles: ["default"],
              segments: [
                {
                  segment_id: "r1",
                  text: "for AI and analytics",
                  style_role: "default",
                },
              ],
            },
          ],
        },
      ],
      authority_nodes: [
        {
          node_id: "plain-multi",
          slide_index: 5,
          translated_full_text: "Datenplattform fur KI und Analytik",
        },
      ],
    });

    assert.equal(result.nodes[0]?.paragraphs.length, 2);
    assert.equal(result.nodes[0]?.paragraphs[0]?.paragraph_id, "p0");
    assert.equal(result.nodes[0]?.paragraphs[1]?.paragraph_id, "p1");
    assert.equal(
      result.nodes[0]?.translated_full_text,
      result.nodes[0]?.paragraphs.map((paragraph) => paragraph.translated_text).join("\n")
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const targetLanguage of [
  "German",
  "Simplified Chinese",
  "Japanese",
] as const) {
  test(`materializeTranslatedNodesWithVertexGemini uses the same trailing empty suffix rule across languages: ${targetLanguage}`, async () => {
    __resetAccessTokenCacheForTests();
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);

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
                        node_id: "dense-short-label",
                        translated_full_text: "2 周内完成迁移",
                        paragraphs: [
                          {
                            paragraph_id: "p0",
                            translated_text: "2 周内完成迁移",
                            bullet_behavior: "none",
                          },
                          {
                            paragraph_id: "p1",
                            translated_text: "",
                            bullet_behavior: "none",
                          },
                        ],
                        segments: [
                          {
                            segment_id: "r0",
                            translated_text: "2 周内完成迁移",
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
      const result = await materializeTranslatedNodesWithVertexGemini(createConfig(), {
        model: "gemini-3.1-flash-lite-preview",
        source_language: "English",
        target_language: targetLanguage,
        deck_title: "Cloud Migration Deck",
        glossary_candidates: [],
        node_summaries: [
          {
            node_id: "dense-short-label",
            archetype: "plain_text",
            slide_index: 10,
            full_text: "migrated in \n2 weeks",
            paragraphs: [
              {
                paragraph_id: "p0",
                text: "migrated in ",
                style_roles: ["default"],
                segments: [
                  {
                    segment_id: "r0",
                    text: "migrated in ",
                    style_role: "default",
                  },
                ],
              },
              {
                paragraph_id: "p1",
                text: "2 weeks",
                style_roles: ["default"],
                segments: [
                  {
                    segment_id: "r1",
                    text: "2 weeks",
                    style_role: "default",
                  },
                ],
              },
            ],
          },
        ],
        authority_nodes: [
          {
            node_id: "dense-short-label",
            slide_index: 10,
            translated_full_text: "2 周内完成迁移",
          },
        ],
      });

      assert.equal(result.nodes[0]?.paragraphs.length, 2);
      assert.ok((result.nodes[0]?.paragraphs[0]?.translated_text ?? "").trim().length > 0);
      assert.equal(result.nodes[0]?.paragraphs[1]?.translated_text ?? "", "");
      assert.equal(
        result.nodes[0]?.translated_full_text,
        result.nodes[0]?.paragraphs.map((paragraph) => paragraph.translated_text).join("\n")
      );
      assert.deepEqual(result.nodes[0]?.risk_flags, [
        "materialization_trailing_empty_suffix_accepted",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test("materializeTranslatedNodesWithVertexGemini prompt requires exact paragraph preservation for every node", async () => {
  __resetAccessTokenCacheForTests();
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
                      translated_full_text: "演示\n概览",
                      paragraphs: [
                        {
                          paragraph_id: "p0",
                          translated_text: "演示",
                          bullet_behavior: "none",
                        },
                        {
                          paragraph_id: "p1",
                          translated_text: "概览",
                          bullet_behavior: "none",
                        },
                      ],
                      segments: [
                        {
                          segment_id: "r0",
                          translated_text: "演示",
                          style_role: "default",
                        },
                        {
                          segment_id: "r1",
                          translated_text: "概览",
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
    await materializeTranslatedNodesWithVertexGemini(createConfig(), {
      model: "gemini-3.1-flash-lite-preview",
      source_language: "English",
      target_language: "Chinese",
      deck_title: "Q3 Product Presentation",
      glossary_candidates: [],
      node_summaries: [
        {
          node_id: "n1",
          archetype: "plain_text",
          slide_index: 1,
          full_text: "Presentation overview",
          paragraphs: [
            {
              paragraph_id: "p0",
              text: "Presentation",
              style_roles: ["default"],
              segments: [
                {
                  segment_id: "r0",
                  text: "Presentation",
                  style_role: "default",
                },
              ],
            },
            {
              paragraph_id: "p1",
              text: "overview",
              style_roles: ["default"],
              segments: [
                {
                  segment_id: "r1",
                  text: "overview",
                  style_role: "default",
                },
              ],
            },
          ],
        },
      ],
      authority_nodes: [
        {
          node_id: "n1",
          slide_index: 1,
          translated_full_text: "演示\n概览",
        },
      ],
    });

    const body = JSON.parse(String(fetchCalls[1]?.init?.body ?? "{}"));
    const systemInstruction = String(body.systemInstruction?.parts?.[0]?.text ?? "");
    const prompt = String(body.contents?.[0]?.parts?.[0]?.text ?? "");

    assert.match(systemInstruction, /Preserve the exact paragraph count/i);
    assert.match(prompt, /preserve the exact paragraph count for every node/i);
    assert.match(prompt, /Never merge, split, drop, or reorder paragraphs/i);
    assert.match(prompt, /Do not output empty middle paragraphs/i);
    assert.match(prompt, /Do not split by character count/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("materializeTranslatedNodesWithVertexGemini accepts trailing empty suffix only for safe plain_text nodes", async () => {
  __resetAccessTokenCacheForTests();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);

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
                      node_id: "plain-tail-empty",
                      translated_full_text: "Datenplattform",
                      paragraphs: [
                        {
                          paragraph_id: "p0",
                          translated_text: "Datenplattform",
                          bullet_behavior: "none",
                        },
                        {
                          paragraph_id: "p1",
                          translated_text: "",
                          bullet_behavior: "none",
                        },
                      ],
                      segments: [
                        {
                          segment_id: "r0",
                          translated_text: "Datenplattform",
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
    const result = await materializeTranslatedNodesWithVertexGemini(createConfig(), {
      model: "gemini-3.1-flash-lite-preview",
      source_language: "English",
      target_language: "German",
      deck_title: "Cloud Migration Deck",
      glossary_candidates: [],
      node_summaries: [
        createMaterializationNodeSummary({
          node_id: "plain-tail-empty",
          archetype: "plain_text",
          slide_index: 4,
          paragraphs: [
            {
              paragraph_id: "p0",
              text: "Data platform",
              style_roles: ["default"],
              segments: [
                {
                  segment_id: "r0",
                  text: "Data platform",
                  style_role: "default",
                },
              ],
            },
            {
              paragraph_id: "p1",
              text: "for AI and analytics",
              style_roles: ["default"],
              segments: [
                {
                  segment_id: "r1",
                  text: "for AI and analytics",
                  style_role: "default",
                },
              ],
            },
          ],
        }),
      ],
      authority_nodes: [
        {
          node_id: "plain-tail-empty",
          slide_index: 4,
          translated_full_text: "Datenplattform",
        },
      ],
    });

    assert.equal(result.nodes[0]?.translated_full_text, "Datenplattform\n");
    assert.deepEqual(
      result.nodes[0]?.paragraphs.map((paragraph) => paragraph.translated_text),
      ["Datenplattform", ""]
    );
    assert.deepEqual(
      result.nodes[0]?.risk_flags,
      ["materialization_trailing_empty_suffix_accepted"]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("materializeTranslatedNodesWithVertexGemini rejects empty middle paragraphs for safe plain_text nodes", async () => {
  __resetAccessTokenCacheForTests();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);

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
                      node_id: "plain-middle-empty",
                      translated_full_text: "Alpha\n\nBeta",
                      paragraphs: [
                        {
                          paragraph_id: "p0",
                          translated_text: "Alpha",
                          bullet_behavior: "none",
                        },
                        {
                          paragraph_id: "p1",
                          translated_text: "",
                          bullet_behavior: "none",
                        },
                        {
                          paragraph_id: "p2",
                          translated_text: "Beta",
                          bullet_behavior: "none",
                        },
                      ],
                      segments: [
                        {
                          segment_id: "r0",
                          translated_text: "Alpha",
                          style_role: "default",
                        },
                        {
                          segment_id: "r1",
                          translated_text: "",
                          style_role: "default",
                        },
                        {
                          segment_id: "r2",
                          translated_text: "Beta",
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
      () =>
        materializeTranslatedNodesWithVertexGemini(createConfig(), {
          model: "gemini-3.1-flash-lite-preview",
          source_language: "English",
          target_language: "German",
          deck_title: "Cloud Migration Deck",
          glossary_candidates: [],
          node_summaries: [
            createMaterializationNodeSummary({
              node_id: "plain-middle-empty",
              archetype: "plain_text",
              slide_index: 5,
              paragraphs: [
                {
                  paragraph_id: "p0",
                  text: "Alpha",
                  style_roles: ["default"],
                  segments: [
                    {
                      segment_id: "r0",
                      text: "Alpha",
                      style_role: "default",
                    },
                  ],
                },
                {
                  paragraph_id: "p1",
                  text: "Beta",
                  style_roles: ["default"],
                  segments: [
                    {
                      segment_id: "r1",
                      text: "Beta",
                      style_role: "default",
                    },
                  ],
                },
                {
                  paragraph_id: "p2",
                  text: "Gamma",
                  style_roles: ["default"],
                  segments: [
                    {
                      segment_id: "r2",
                      text: "Gamma",
                      style_role: "default",
                    },
                  ],
                },
              ],
            }),
          ],
          authority_nodes: [
            {
              node_id: "plain-middle-empty",
              slide_index: 5,
              translated_full_text: "Alpha Beta",
            },
          ],
        }),
      /contains an empty paragraph/i
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("materializeTranslatedNodesWithVertexGemini keeps trailing empty paragraphs strict for speaker notes and metric cards", async () => {
  __resetAccessTokenCacheForTests();
  const originalFetch = globalThis.fetch;

  const runCase = async (
    archetype: "speaker_notes" | "metric_card",
    nodeId: string
  ) => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);

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
                        node_id: nodeId,
                        translated_full_text: "Kompakter Text",
                        paragraphs: [
                          {
                            paragraph_id: "p0",
                            translated_text: "Kompakter Text",
                            bullet_behavior: "none",
                          },
                          {
                            paragraph_id: "p1",
                            translated_text: "",
                            bullet_behavior: "none",
                          },
                        ],
                        segments: [
                          {
                            segment_id: "r0",
                            translated_text: "Kompakter Text",
                            style_role: archetype === "metric_card" ? "metric_value" : "default",
                          },
                          {
                            segment_id: "r1",
                            translated_text: "",
                            style_role: archetype === "metric_card" ? "metric_unit" : "default",
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

    await assert.rejects(
      () =>
        materializeTranslatedNodesWithVertexGemini(createConfig(), {
          model: "gemini-3.1-flash-lite-preview",
          source_language: "English",
          target_language: "German",
          deck_title: "Cloud Migration Deck",
          glossary_candidates: [],
          node_summaries: [
            createMaterializationNodeSummary({
              node_id: nodeId,
              archetype,
              slide_index: 6,
              paragraphs: [
                {
                  paragraph_id: "p0",
                  text: archetype === "speaker_notes" ? "Explain the rollout plan." : "ARR",
                  style_roles: [archetype === "metric_card" ? "metric_value" : "default"],
                  segments: [
                    {
                      segment_id: "r0",
                      text: archetype === "speaker_notes" ? "Explain the rollout plan." : "ARR",
                      style_role: archetype === "metric_card" ? "metric_value" : "default",
                    },
                  ],
                },
                {
                  paragraph_id: "p1",
                  text: archetype === "speaker_notes" ? "Cover dependencies too." : "per month",
                  style_roles: [archetype === "metric_card" ? "metric_unit" : "default"],
                  segments: [
                    {
                      segment_id: "r1",
                      text: archetype === "speaker_notes" ? "Cover dependencies too." : "per month",
                      style_role: archetype === "metric_card" ? "metric_unit" : "default",
                    },
                  ],
                },
              ],
            }),
          ],
          authority_nodes: [
            {
              node_id: nodeId,
              slide_index: 6,
              translated_full_text: "Kompakter Text",
            },
          ],
        }),
      /contains an empty paragraph/i
    );
  };

  try {
    await runCase("speaker_notes", "notes-tail-empty");
    await runCase("metric_card", "metric-tail-empty");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("materializeTranslatedNodesWithVertexGemini prompt does not inject dense-language-specific guidance", async () => {
  __resetAccessTokenCacheForTests();
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
                      translated_full_text: "導入\n概要",
                      paragraphs: [
                        {
                          paragraph_id: "p0",
                          translated_text: "導入",
                          bullet_behavior: "none",
                        },
                        {
                          paragraph_id: "p1",
                          translated_text: "概要",
                          bullet_behavior: "none",
                        },
                      ],
                      segments: [
                        {
                          segment_id: "r0",
                          translated_text: "導入",
                          style_role: "default",
                        },
                        {
                          segment_id: "r1",
                          translated_text: "概要",
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

  const request = {
    model: "gemini-3.1-flash-lite-preview",
    source_language: "English",
    deck_title: "Q3 Product Presentation",
    glossary_candidates: [],
    node_summaries: [
      {
        node_id: "n1",
        archetype: "plain_text" as const,
        slide_index: 1,
        full_text: "Presentation overview",
        paragraphs: [
          {
            paragraph_id: "p0",
            text: "Presentation",
            style_roles: ["default"] as const,
            segments: [
              {
                segment_id: "r0",
                text: "Presentation",
                style_role: "default" as const,
              },
            ],
          },
          {
            paragraph_id: "p1",
            text: "overview",
            style_roles: ["default"] as const,
            segments: [
              {
                segment_id: "r1",
                text: "overview",
                style_role: "default" as const,
              },
            ],
          },
        ],
      },
    ],
    authority_nodes: [
      {
        node_id: "n1",
        slide_index: 1,
        translated_full_text: "導入概要",
      },
    ],
  };

  try {
    await materializeTranslatedNodesWithVertexGemini(createConfig(), {
      ...request,
      target_language: "Japanese",
    });
    await materializeTranslatedNodesWithVertexGemini(createConfig(), {
      ...request,
      target_language: "German",
      authority_nodes: [
        {
          node_id: "n1",
          slide_index: 1,
          translated_full_text: "Einfuhrung Uberblick",
        },
      ],
    });

    const japaneseBody = JSON.parse(String(fetchCalls[1]?.init?.body ?? "{}"));
    const germanBody = JSON.parse(String(fetchCalls[2]?.init?.body ?? "{}"));
    const japanesePrompt = String(japaneseBody.contents?.[0]?.parts?.[0]?.text ?? "");
    const germanPrompt = String(germanBody.contents?.[0]?.parts?.[0]?.text ?? "");

    assert.doesNotMatch(japanesePrompt, /short-label dense language guidance/i);
    assert.doesNotMatch(germanPrompt, /short-label dense language guidance/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("translateDeckAuthorityWithVertexGemini instructs speaker notes to preserve full meaning instead of compressing", async () => {
  __resetAccessTokenCacheForTests();
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
                      node_id: "notes-1",
                      slide_index: 2,
                      translated_full_text: "Vollstandige Sprechernotiz",
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
    await translateDeckAuthorityWithVertexGemini(createConfig(), {
      model: "gemini-3.1-flash-lite-preview",
      source_language: "English",
      target_language: "German",
      deck_title: "Speaker Notes Deck",
      deck_plaintext_context: "[Slide 2] Reminder to explain timeline",
      glossary_candidates: [],
      nodes: [
        {
          node_id: "notes-1",
          slide_index: 2,
          object_id: "notes_shape_1",
          element_type: "speaker_notes",
          archetype: "speaker_notes",
          full_text: "Reminder to explain timeline and implementation trade-offs.",
        },
      ],
      visual_context: {
        deck_overview_frames: [],
        local_window_frames: [],
      },
    });

    const body = JSON.parse(String(fetchCalls[1]?.init?.body ?? "{}"));
    const systemInstruction = String(body.systemInstruction?.parts?.[0]?.text ?? "");
    const prompt = String(body.contents?.[0]?.parts?.[0]?.text ?? "");

    assert.match(systemInstruction, /speaker notes/i);
    assert.match(systemInstruction, /Do not compress, summarize, or simplify notes/i);
    assert.match(prompt, /preserve the full meaning and operational detail/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("materializeTranslatedNodesWithVertexGemini normalizes speaker notes full text to preserved paragraphs", async () => {
  __resetAccessTokenCacheForTests();
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
                      node_id: "notes-1",
                      translated_full_text:
                        "Bitte erklaren Sie die Roadmap und die Einfuhrungsabhangigkeiten in einer zusammenhangenden Notiz.",
                      paragraphs: [
                        {
                          paragraph_id: "p0",
                          translated_text: "Bitte erklaren Sie die Roadmap.",
                          bullet_behavior: "none",
                        },
                        {
                          paragraph_id: "p1",
                          translated_text: "Erläutern Sie auch die Einfuhrungsabhangigkeiten.",
                          bullet_behavior: "none",
                        },
                      ],
                      segments: [
                        {
                          segment_id: "r0",
                          translated_text: "Bitte erklaren Sie die Roadmap.",
                          style_role: "default",
                        },
                        {
                          segment_id: "r1",
                          translated_text:
                            "Erläutern Sie auch die Einfuhrungsabhangigkeiten.",
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
    const result = await materializeTranslatedNodesWithVertexGemini(createConfig(), {
      model: "gemini-3.1-flash-lite-preview",
      source_language: "English",
      target_language: "German",
      deck_title: "Speaker Notes Deck",
      glossary_candidates: [],
      node_summaries: [
        {
          node_id: "notes-1",
          archetype: "speaker_notes",
          slide_index: 2,
          full_text: "Explain roadmap.\nAlso cover rollout dependencies.",
          paragraphs: [
            {
              paragraph_id: "p0",
              text: "Explain roadmap.",
              style_roles: ["default"],
              segments: [
                {
                  segment_id: "r0",
                  text: "Explain roadmap.",
                  style_role: "default",
                },
              ],
            },
            {
              paragraph_id: "p1",
              text: "Also cover rollout dependencies.",
              style_roles: ["default"],
              segments: [
                {
                  segment_id: "r1",
                  text: "Also cover rollout dependencies.",
                  style_role: "default",
                },
              ],
            },
          ],
        },
      ],
      authority_nodes: [
        {
          node_id: "notes-1",
          slide_index: 2,
          translated_full_text:
            "Bitte erklaren Sie die Roadmap und die Einfuhrungsabhangigkeiten in einer zusammenhangenden Notiz.",
        },
      ],
    });

    assert.equal(
      result.nodes[0]?.translated_full_text,
      "Bitte erklaren Sie die Roadmap.\nErläutern Sie auch die Einfuhrungsabhangigkeiten."
    );
    assert.deepEqual(
      result.nodes[0]?.paragraphs.map((paragraph) => paragraph.translated_text),
      [
        "Bitte erklaren Sie die Roadmap.",
        "Erläutern Sie auch die Einfuhrungsabhangigkeiten.",
      ]
    );

    const body = JSON.parse(String(fetchCalls[1]?.init?.body ?? "{}"));
    const systemInstruction = String(body.systemInstruction?.parts?.[0]?.text ?? "");
    const prompt = String(body.contents?.[0]?.parts?.[0]?.text ?? "");

    assert.match(systemInstruction, /For speaker_notes, keep the source paragraph boundaries/i);
    assert.match(prompt, /speaker_notes/i);
    assert.match(prompt, /keep the translation complete rather than concise/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("translateDeckAuthorityWithVertexGemini keeps layout-only metadata out of source node context", async () => {
  __resetAccessTokenCacheForTests();
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
                      node_id: "title-like",
                      slide_index: 1,
                      translated_full_text: "Umsatzwachstum",
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
    await translateDeckAuthorityWithVertexGemini(createConfig(), {
      model: "gemini-3.1-flash-lite-preview",
      source_language: "English",
      target_language: "German",
      deck_title: "Q3 Product Presentation",
      deck_plaintext_context: "[Slide 1] Revenue growth",
      glossary_candidates: [],
      nodes: [
        {
          node_id: "title-like",
          slide_index: 1,
          object_id: "shape_title",
          element_type: "shape",
          archetype: "plain_text",
          full_text: "Revenue growth",
        },
      ],
      visual_context: {
        deck_overview_frames: [],
        local_window_frames: [
          {
            slide_index: 1,
            slide_object_id: "slide_1",
            mime_type: "image/png",
            base64_data: "ZmFrZQ==",
          },
        ],
      },
    });

    const body = JSON.parse(String(fetchCalls[1]?.init?.body ?? "{}"));
    const systemInstruction = String(
      body.systemInstruction?.parts?.[0]?.text ?? ""
    );
    const prompt = String(body.contents?.[0]?.parts?.[0]?.text ?? "");

    assert.doesNotMatch(systemInstruction, /layout hint/i);
    assert.doesNotMatch(prompt, /"visual_role":\s*"title"/);
    assert.doesNotMatch(prompt, /"line_policy":\s*"prefer_single_line"/);
    assert.doesNotMatch(prompt, /"scale_sync":\s*"sync_with_group"/);
    assert.doesNotMatch(prompt, /"alignment":\s*"CENTER"/);
    assert.doesNotMatch(prompt, /"max_font_size_pt":\s*30/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("materializeTranslatedNodesWithVertexGemini keeps layout-only metadata out of source structure", async () => {
  __resetAccessTokenCacheForTests();
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
                      node_id: "title-like",
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
                          translated_text: "Umsatzwachstum",
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
    await materializeTranslatedNodesWithVertexGemini(createConfig(), {
      model: "gemini-3.1-flash-lite-preview",
      source_language: "English",
      target_language: "German",
      deck_title: "Q3 Product Presentation",
      glossary_candidates: [],
      node_summaries: [
        {
          node_id: "title-like",
          archetype: "plain_text",
          slide_index: 1,
          full_text: "Revenue growth",
          paragraphs: [
            {
              paragraph_id: "p0",
              text: "Revenue growth",
              style_roles: ["default"],
              segments: [
                {
                  segment_id: "r0",
                  text: "Revenue growth",
                  style_role: "default",
                },
              ],
            },
          ],
        },
      ],
      authority_nodes: [
        {
          node_id: "title-like",
          slide_index: 1,
          translated_full_text: "Umsatzwachstum",
        },
      ],
    });

    const body = JSON.parse(String(fetchCalls[1]?.init?.body ?? "{}"));
    const systemInstruction = String(
      body.systemInstruction?.parts?.[0]?.text ?? ""
    );
    const prompt = String(body.contents?.[0]?.parts?.[0]?.text ?? "");

    assert.doesNotMatch(systemInstruction, /layout hint/i);
    assert.doesNotMatch(prompt, /"visual_role":\s*"title"/);
    assert.doesNotMatch(prompt, /"line_policy":\s*"prefer_single_line"/);
    assert.doesNotMatch(prompt, /"alignment":\s*"CENTER"/);
    assert.doesNotMatch(prompt, /"max_font_size_pt":\s*30/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
