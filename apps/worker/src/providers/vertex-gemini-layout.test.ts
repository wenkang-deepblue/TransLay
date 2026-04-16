import test from "node:test";
import assert from "node:assert/strict";
import type { WorkerConfig } from "@translay/shared-config";
import { __resetAccessTokenCacheForTests } from "./vertex-gemini";
import {
  buildLayoutSemanticContentParts,
  requestSlideLayoutSemanticsWithVertexGemini,
} from "./vertex-gemini-layout";

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
      llmOutputRetentionHours: 72,
    },
  };
}

test("buildLayoutSemanticContentParts includes a visual reference frame", () => {
  const parts = buildLayoutSemanticContentParts({
    slide_index: 1,
    slide_object_id: "slide_1",
    thumbnail: {
      slide_index: 1,
      slide_object_id: "slide_1",
      mime_type: "image/png",
      base64_data: "ZmFrZQ==",
    },
    nodes: [
      {
        node_id: "shape_1",
        element_type: "shape",
        archetype: "plain_text",
        text_excerpt: "Agenda",
        paragraph_count: 1,
        alignment: "CENTER",
        min_font_size_pt: 24,
        max_font_size_pt: 24,
        font_family: "Inter",
        fill_color_hex: "#112233",
        outline_color_hex: "#445566",
        box: {
          width_emu: 0,
          height_emu: 0,
          translate_x_emu: 0,
          translate_y_emu: 0,
          rotation_deg: 0,
        },
      },
    ],
  });

  assert.equal(parts.length, 3);
  assert.match(String(parts[0]?.text ?? ""), /VISIBLE NODE SUMMARIES/);
  assert.match(String(parts[0]?.text ?? ""), /PROMPT SAFETY RULES:/);
  assert.equal(parts[1]?.text, "Visual reference for slide 2");
  assert.deepEqual(parts[2]?.inlineData, {
    mimeType: "image/png",
    data: "ZmFrZQ==",
  });
});

test("requestSlideLayoutSemanticsWithVertexGemini sends multimodal prompt and parses raw JSON response", async () => {
  __resetAccessTokenCacheForTests();
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const debugEvents: unknown[] = [];
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
                      node_id: "shape_1",
                      visual_role: "title",
                      cluster_id: "cluster_title",
                      line_policy: "prefer_single_line",
                      scale_sync: "sync_with_group",
                      confidence: 0.95,
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
    const result = await requestSlideLayoutSemanticsWithVertexGemini(createConfig(), {
      model: "gemini-3.1-flash-lite-preview",
      slide_index: 1,
      slide_object_id: "slide_1",
      thumbnail: {
        slide_index: 1,
        slide_object_id: "slide_1",
        mime_type: "image/png",
        base64_data: "ZmFrZQ==",
      },
      nodes: [
        {
          node_id: "shape_1",
          element_type: "shape",
          archetype: "plain_text",
          text_excerpt: "Agenda",
          paragraph_count: 1,
          alignment: "CENTER",
          min_font_size_pt: 24,
          max_font_size_pt: 24,
          font_family: "Inter",
          fill_color_hex: "#112233",
          outline_color_hex: "#445566",
          box: {
            width_emu: 0,
            height_emu: 0,
            translate_x_emu: 0,
            translate_y_emu: 0,
            rotation_deg: 0,
          },
        },
      ],
      debugCapture: async (event) => {
        debugEvents.push(event);
      },
      debugLabel: "layout_test",
    });

    assert.deepEqual(result, [
      {
        node_id: "shape_1",
        visual_role: "title",
        cluster_id: "cluster_title",
        line_policy: "prefer_single_line",
        scale_sync: "sync_with_group",
        confidence: 0.95,
      },
    ]);
    assert.equal(fetchCalls.length, 2);

    const body = JSON.parse(String(fetchCalls[1]?.init?.body ?? "{}"));
    const parts = body.contents?.[0]?.parts as Array<Record<string, unknown>>;
    assert.equal(parts.length, 3);
    assert.match(String(parts[0]?.text ?? ""), /Infer best-effort layout semantics/);
    assert.match(String(body.systemInstruction?.parts?.[0]?.text ?? ""), /VISUAL FIDELITY PRINCIPLE:/);
    assert.match(
      String(body.systemInstruction?.parts?.[0]?.text ?? ""),
      /If a node is visually presented as a single-line high-salience text/
    );
    assert.match(
      String(body.systemInstruction?.parts?.[0]?.text ?? ""),
      /When uncertain between "prefer_single_line" and "allow_wrap"/
    );
    assert.match(
      String(body.systemInstruction?.parts?.[0]?.text ?? ""),
      /Agenda rows, summary \/ takeaways cards, next-step lists/
    );
    assert.match(
      String(body.systemInstruction?.parts?.[0]?.text ?? ""),
      /already visibly wrapped, stacked, or split\s+across lines/
    );
    assert.match(
      String(parts[0]?.text ?? ""),
      /Agenda items should usually share one cluster_id/
    );
    assert.match(
      String(parts[0]?.text ?? ""),
      /do not force "prefer_single_line" just because it is short/
    );
    assert.match(String(parts[0]?.text ?? ""), /PROMPT SAFETY RULES:/);
    assert.match(String(parts[0]?.text ?? ""), /Preserve source line treatment as a strong prior/);
    assert.match(String(parts[0]?.text ?? ""), /Use "fixed_multiline" only for intentionally multiline source nodes/);
    assert.equal(parts[1]?.text, "Visual reference for slide 2");
    assert.deepEqual(parts[2]?.inlineData, {
      mimeType: "image/png",
      data: "ZmFrZQ==",
    });
    assert.equal(body.generationConfig?.responseSchema?.minItems, 0);
    assert.equal(body.generationConfig?.responseSchema?.maxItems, 1);
    assert.equal(debugEvents.length, 1);
    assert.match(JSON.stringify(debugEvents[0]), /layout_test/);
    assert.match(JSON.stringify(debugEvents[0]), /"capture_status":"success"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
