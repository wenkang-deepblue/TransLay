import { getSlidesClient } from "./auth";
import type { SlideExtractionResult } from "./types";
import {
  fetchSlideThumbnail,
  fetchSlideThumbnails,
  type SlideThumbnail,
  type ThumbnailSize,
} from "./thumbnails";

export interface StoryboardFrame {
  readonly slide_index: number;
  readonly slide_object_id: string;
  readonly mime_type: string;
  /** @internal MUST NOT be persisted, logged, or cached — zero-content-persistence rule. */
  readonly base64_data: string;
}

export interface DeckStoryboard {
  readonly frames: readonly StoryboardFrame[];
}

export async function buildDeckStoryboard(
  presentationId: string,
  slides: readonly SlideExtractionResult[],
  options: {
    readonly size?: ThumbnailSize;
  } = {}
): Promise<DeckStoryboard> {
  const thumbnails = await fetchSlideThumbnails(presentationId, slides, options);
  return {
    frames: thumbnails.map(projectThumbnailToFrame),
  };
}

export async function buildPresentationStoryboard(
  presentationId: string,
  options: {
    readonly size?: ThumbnailSize;
  } = {}
): Promise<DeckStoryboard> {
  const { slides } = getSlidesClient();
  const presentation = await slides.presentations.get({ presentationId });
  const allSlides = presentation.data.slides ?? [];
  const slideRefs: SlideExtractionResult[] = allSlides.map((slide, index) => ({
    slide_index: index,
    slide_object_id: slide.objectId ?? `slide_${index}`,
    nodes: [],
  }));
  return buildDeckStoryboard(presentationId, slideRefs, options);
}

export async function buildSingleSlideStoryboardFrame(
  presentationId: string,
  slide: SlideExtractionResult,
  options: {
    readonly size?: ThumbnailSize;
  } = {}
): Promise<StoryboardFrame> {
  return projectThumbnailToFrame(await fetchSlideThumbnail(presentationId, slide, options));
}

export function buildSlidingWindowSlideIndices(
  activeSlideIndices: readonly number[],
  maxSlideIndex: number
): number[] {
  const expanded = new Set<number>();
  for (const slideIndex of activeSlideIndices) {
    const normalized = Math.max(0, Math.min(maxSlideIndex, slideIndex));
    if (normalized - 1 >= 0) {
      expanded.add(normalized - 1);
    }
    expanded.add(normalized);
    if (normalized + 1 <= maxSlideIndex) {
      expanded.add(normalized + 1);
    }
  }

  return [...expanded].sort((left, right) => left - right);
}

export function selectSlidingWindowSlides(
  slides: readonly SlideExtractionResult[],
  activeSlideIndices: readonly number[]
): SlideExtractionResult[] {
  if (slides.length === 0 || activeSlideIndices.length === 0) {
    return [];
  }

  const maxSlideIndex = slides.reduce(
    (maxIndex, slide) => Math.max(maxIndex, slide.slide_index),
    0
  );
  const selectedIndices = new Set(
    buildSlidingWindowSlideIndices(activeSlideIndices, maxSlideIndex)
  );

  return slides
    .filter((slide) => selectedIndices.has(slide.slide_index))
    .sort((left, right) => left.slide_index - right.slide_index);
}

function projectThumbnailToFrame(thumbnail: SlideThumbnail): StoryboardFrame {
  return {
    slide_index: thumbnail.slide_index,
    slide_object_id: thumbnail.slide_object_id,
    mime_type: thumbnail.mime_type,
    base64_data: thumbnail.base64_data,
  };
}
