import test from "node:test";
import assert from "node:assert/strict";
import type { SlideExtractionResult } from "./types";
import {
  buildSlidingWindowSlideIndices,
  selectSlidingWindowSlides,
} from "./storyboard";

function createSlide(slideIndex: number): SlideExtractionResult {
  return {
    slide_index: slideIndex,
    slide_object_id: `slide_${slideIndex}`,
    nodes: [],
  };
}

test("buildSlidingWindowSlideIndices expands chunk slides to i-1 i i+1 without duplicates", () => {
  assert.deepEqual(buildSlidingWindowSlideIndices([2, 3], 5), [1, 2, 3, 4]);
  assert.deepEqual(buildSlidingWindowSlideIndices([0], 5), [0, 1]);
  assert.deepEqual(buildSlidingWindowSlideIndices([5], 5), [4, 5]);
  assert.deepEqual(buildSlidingWindowSlideIndices([1, 4], 5), [0, 1, 2, 3, 4, 5]);
});

test("selectSlidingWindowSlides returns sorted neighboring slide refs for active chunk slides", () => {
  const slides = [
    createSlide(0),
    createSlide(1),
    createSlide(2),
    createSlide(3),
    createSlide(4),
  ];

  assert.deepEqual(
    selectSlidingWindowSlides(slides, [1, 3]).map((slide) => slide.slide_index),
    [0, 1, 2, 3, 4]
  );
  assert.deepEqual(
    selectSlidingWindowSlides(slides, [2]).map((slide) => slide.slide_index),
    [1, 2, 3]
  );
});
