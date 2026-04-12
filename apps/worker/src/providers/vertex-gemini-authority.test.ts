import test from "node:test";
import assert from "node:assert/strict";
import type { WorkerConfig } from "@translay/shared-config";
import type {
  AuthorityTranslationNode,
  TranslationContextNodeSummary,
} from "@translay/shared-contracts";
import { __resetAccessTokenCacheForTests } from "./vertex-gemini";
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
      audience: "",
      invokerServiceAccount: "",
    },
  };
}

test("translateDeckAuthorityWithVertexGemini sends storyboard frames and parses authority nodes", async () => {
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
      storyboard: {
        frames: [
          {
            slide_index: 1,
            slide_object_id: "slide_1",
            mime_type: "image/png",
            base64_data: "ZmFrZQ==",
          },
        ],
      },
    });

    assert.equal(result.nodes[0]?.node_id, "n1");
    assert.equal(result.nodes[0]?.translated_full_text, "演示概览");
    assert.equal(result.nodes[0]?.preferred_terms_used, undefined);
    assert.equal(result.nodes[0]?.notes, undefined);
    assert.equal(fetchCalls.length, 2);

    const body = JSON.parse(String(fetchCalls[1]?.init?.body ?? "{}"));
    const parts = body.contents?.[0]?.parts as Array<Record<string, unknown>>;
    assert.equal(parts.length, 3);
    assert.match(String(parts[0]?.text ?? ""), /SOURCE NODE INDEX/);
    assert.match(String(parts[0]?.text ?? ""), /PROMPT SAFETY RULES:/);
    assert.equal(parts[1]?.text, "Storyboard frame for slide 1");
    assert.deepEqual(parts[2]?.inlineData, {
      mimeType: "image/png",
      data: "ZmFrZQ==",
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
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fillMissingAuthorityWithVertexGemini includes deck-wide authority context for terminology alignment", async () => {
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

test("translateDeckAuthorityWithVertexGemini batches authority requests at 20 nodes and reuses prior authority context", async () => {
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
      storyboard: {
        frames: [
          {
            slide_index: 1,
            slide_object_id: "slide_1",
            mime_type: "image/png",
            base64_data: "ZmFrZQ==",
          },
        ],
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

    assert.equal(result.nodes[0]?.translated_full_text, "680亿美元");
    assert.equal(result.nodes[0]?.segments[0]?.translated_text, "");
    assert.equal(result.nodes[0]?.segments[1]?.translated_text, "680亿美元");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("translateDeckAuthorityWithVertexGemini includes layout hints and visible style summaries in source node context", async () => {
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
          visible_style: {
            alignment: "CENTER",
            font_family: "Inter",
            min_font_size_pt: 22,
            max_font_size_pt: 30,
            fill_color_hex: "#112233",
            outline_color_hex: "#445566",
          },
          layout_hint: {
            node_id: "title-like",
            visual_role: "title",
            cluster_id: "hero-title",
            line_policy: "prefer_single_line",
            scale_sync: "sync_with_group",
            confidence: 0.96,
          },
        },
      ],
      storyboard: {
        frames: [
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

    assert.match(systemInstruction, /layout hint/i);
    assert.match(prompt, /"visual_role":\s*"title"/);
    assert.match(prompt, /"line_policy":\s*"prefer_single_line"/);
    assert.match(prompt, /"scale_sync":\s*"sync_with_group"/);
    assert.match(prompt, /"alignment":\s*"CENTER"/);
    assert.match(prompt, /"max_font_size_pt":\s*30/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("materializeTranslatedNodesWithVertexGemini includes layout hints and visible style summaries in source structure", async () => {
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
          visible_style: {
            alignment: "CENTER",
            font_family: "Inter",
            min_font_size_pt: 22,
            max_font_size_pt: 30,
            fill_color_hex: "#112233",
            outline_color_hex: "#445566",
          },
          layout_hint: {
            node_id: "title-like",
            visual_role: "title",
            cluster_id: "hero-title",
            line_policy: "prefer_single_line",
            scale_sync: "sync_with_group",
            confidence: 0.96,
          },
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

    assert.match(systemInstruction, /layout hint/i);
    assert.match(prompt, /"visual_role":\s*"title"/);
    assert.match(prompt, /"line_policy":\s*"prefer_single_line"/);
    assert.match(prompt, /"alignment":\s*"CENTER"/);
    assert.match(prompt, /"max_font_size_pt":\s*30/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
