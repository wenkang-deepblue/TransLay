import test from "node:test";
import assert from "node:assert/strict";
import type { TranslatedNode } from "@translay/shared-contracts";
import type { SlideTextNode } from "./types";
import {
  REQUIRED_REGRESSION_ARCHETYPES,
  REQUIRED_REGRESSION_LANGUAGES,
  SLIDES_FIDELITY_REGRESSION_SAMPLES,
  __containsNormalizedTextForTests,
  __countInsertedParagraphsForTests,
  __styleExpectationSatisfiedForTests,
  evaluateRegressionBaseline,
} from "./regression-baseline";

test("slides fidelity regression sample set covers required languages and archetypes", () => {
  const languages = new Set(
    SLIDES_FIDELITY_REGRESSION_SAMPLES.map((sample) => sample.target_language)
  );
  const archetypes = new Set(
    SLIDES_FIDELITY_REGRESSION_SAMPLES.map((sample) => sample.source_node.archetype)
  );

  assert.deepEqual([...languages].sort(), [...REQUIRED_REGRESSION_LANGUAGES].sort());
  assert.deepEqual([...archetypes].sort(), [...REQUIRED_REGRESSION_ARCHETYPES].sort());
});

test("slides fidelity regression baseline meets phase 4A.7 thresholds", () => {
  const baseline = evaluateRegressionBaseline(SLIDES_FIDELITY_REGRESSION_SAMPLES);

  assert.equal(baseline.empty_bullet_generation_rate, 0);
  assert.equal(baseline.bullet_count_error_rate, 0);
  assert.ok(
    baseline.paragraph_count_error_rate < 0.01,
    `paragraph_count_error_rate=${baseline.paragraph_count_error_rate}`
  );
  assert.ok(
    baseline.obvious_overflow_rate < 0.1,
    `obvious_overflow_rate=${baseline.obvious_overflow_rate}`
  );
  assert.ok(
    baseline.style_hierarchy_retention_rate > 0.85,
    `style_hierarchy_retention_rate=${baseline.style_hierarchy_retention_rate}`
  );
  assert.ok(
    baseline.major_manual_reflow_rate < 0.1,
    `major_manual_reflow_rate=${baseline.major_manual_reflow_rate}`
  );
  assert.equal(baseline.term_consistency_rate, 1);
});

test("paragraph counting ignores trailing newline so empty bullet does not inflate paragraph mismatch", () => {
  assert.equal(__countInsertedParagraphsForTests("One\nTwo\n"), 2);
  assert.equal(__countInsertedParagraphsForTests("One\nTwo"), 2);
});

test("style expectation matching uses text ranges instead of request index positions", () => {
  const sample = SLIDES_FIDELITY_REGRESSION_SAMPLES.find(
    (candidate) => candidate.sample_id === "es-mixed-arr"
  );
  assert.ok(sample);

  const satisfied = __styleExpectationSatisfiedForTests(sample, [
    {
      updateTextStyle: {
        objectId: sample.source_node.object_id,
        style: { bold: true },
        fields: "*",
        textRange: {
          type: "FIXED_RANGE",
          startIndex: 3,
          endIndex: "ARR impulsa el crecimiento".length,
        },
      },
    },
  ]);

  assert.equal(satisfied, true);
});

test("term consistency uses latin word boundaries and avoids substring false positives", () => {
  assert.equal(__containsNormalizedTextForTests("ARR impulsa el crecimiento", "arr"), true);
  assert.equal(__containsNormalizedTextForTests("arranque de ingresos", "arr"), false);
  assert.equal(__containsNormalizedTextForTests("年度經常性收入現已成為定價錨點", "年度經常性收入"), true);
});

test("bullet count metric compares preserved bullet paragraphs instead of all inserted paragraphs", () => {
  const sample = {
    sample_id: "bullet-mixed-paragraphs",
    target_language: "es",
    source_node: {
      node_id: "bullet-mixed-paragraphs",
      text: "Intro\nBullet item",
      full_text: "Intro\nBullet item",
      slide_index: 1,
      element_type: "shape",
      archetype: "bullet_list",
      object_id: "shape_bullet_mixed",
      box: {
        width_emu: 300 * 12700,
        height_emu: 100 * 12700,
        translate_x_emu: 0,
        translate_y_emu: 0,
        rotation_deg: 0,
      },
      paragraphs: [
        {
          paragraph_id: "p0",
          text: "Intro",
          start_index: 0,
          end_index: 5,
          paragraph_style: {},
          runs: [
            {
              run_id: "r0",
              text: "Intro",
              start_index: 0,
              end_index: 5,
              style_role: "default",
              text_style: { fontSize: { magnitude: 16, unit: "PT" } },
            },
          ],
        },
        {
          paragraph_id: "p1",
          text: "Bullet item",
          start_index: 6,
          end_index: 17,
          bullet: { nesting_level: 0 },
          paragraph_style: {},
          runs: [
            {
              run_id: "r1",
              text: "Bullet item",
              start_index: 6,
              end_index: 17,
              style_role: "default",
              text_style: { fontSize: { magnitude: 16, unit: "PT" } },
            },
          ],
        },
      ],
    } satisfies SlideTextNode,
    translated_node: {
      node_id: "bullet-mixed-paragraphs",
      translated_full_text: "Introduccion\nPunto",
      paragraphs: [
        {
          paragraph_id: "p0",
          translated_text: "Introduccion",
          bullet_behavior: "none",
        },
        {
          paragraph_id: "p1",
          translated_text: "Punto",
          bullet_behavior: "preserve",
        },
      ],
      segments: [
        {
          segment_id: "r0",
          translated_text: "Introduccion",
          style_role: "default",
        },
        {
          segment_id: "r1",
          translated_text: "Punto",
          style_role: "default",
        },
      ],
    } satisfies TranslatedNode,
  } as const;

  const baseline = evaluateRegressionBaseline([sample]);

  assert.equal(baseline.bullet_count_error_rate, 0);
  assert.equal(baseline.paragraph_count_error_rate, 0);
});
