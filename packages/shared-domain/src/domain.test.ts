import test from "node:test";
import assert from "node:assert/strict";
import {
  billingPeriodKey,
  computeEntitlement,
  getQuotaLimits,
  matchPresetLanguage,
  parsePageRange,
  parsePageRangeDetailed,
  validateCreateJobRequest,
} from "./index";

test("computeEntitlement returns blocked access for blocked subscriptions", () => {
  const entitlement = computeEntitlement({
    plan_type: "pro_monthly",
    subscription_status: "blocked",
    cancel_at_period_end: false,
    current_period_end: null,
  });

  assert.deepEqual(entitlement, {
    access: "blocked",
    active: false,
    cancellation_notice: null,
  });
});

test("getQuotaLimits matches the frozen free-tier caps", () => {
  assert.deepEqual(getQuotaLimits("free"), {
    slides: 20,
    docs_pages: 5,
    sheets_cells: 2000,
  });
});

test("billingPeriodKey uses UTC boundaries", () => {
  assert.equal(billingPeriodKey(new Date("2026-01-31T23:59:59-08:00")), "2026-02");
});

test("matchPresetLanguage supports localized names, aliases, and BCP 47 tags", () => {
  assert.equal(matchPresetLanguage("法语"), "FR");
  assert.equal(matchPresetLanguage("zh-Hans"), "zh-Hans");
  assert.equal(matchPresetLanguage("zh-TW"), "zh-Hant");
  assert.equal(matchPresetLanguage("tlh"), "TLH");
});

test("parsePageRange rejects chinese punctuation, decimals, and zero pages", () => {
  const punctuation = parsePageRangeDetailed("1，3");
  assert.equal(punctuation.validation_errors[0]?.code, "non_ascii_punctuation");

  const decimal = parsePageRangeDetailed("3.5");
  assert.equal(decimal.validation_errors[0]?.code, "decimal_page");

  const zero = parsePageRangeDetailed("0");
  assert.equal(zero.validation_errors[0]?.code, "zero_page");
});

test("parsePageRange keeps legacy null-or-pages behavior while using richer parsing", () => {
  assert.deepEqual(parsePageRange("3,1,2-3"), [1, 2, 3]);
  assert.equal(parsePageRange("1,,3"), null);
});

test("validateCreateJobRequest surfaces detailed page-range validation for slides/docs", () => {
  const error = validateCreateJobRequest({
    host_type: "slides",
    document_id: "doc_123",
    document_name: "Deck",
    source_language_mode: "auto",
    target_language_input: "French",
    output_mode: "create_new_file",
    target_document_id: "target_123",
    range_mode: "custom",
    range_expression: "1，3",
    idempotency_key: "job-key",
  });

  assert.equal(
    error,
    "Range expression must use ASCII commas (,) and hyphens (-) only."
  );
});
