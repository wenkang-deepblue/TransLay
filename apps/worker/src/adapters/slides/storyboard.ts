import { getSlidesClient } from "./auth";
import type { SlideExtractionResult } from "./types";
import { fetchSlideThumbnails, type SlideThumbnail } from "./thumbnails";

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
  slides: readonly SlideExtractionResult[]
): Promise<DeckStoryboard> {
  const thumbnails = await fetchSlideThumbnails(presentationId, slides);
  return {
    frames: thumbnails.map(projectThumbnailToFrame),
  };
}

export async function buildPresentationStoryboard(
  presentationId: string
): Promise<DeckStoryboard> {
  const { slides } = getSlidesClient();
  const presentation = await slides.presentations.get({ presentationId });
  const allSlides = presentation.data.slides ?? [];
  const slideRefs: SlideExtractionResult[] = allSlides.map((slide, index) => ({
    slide_index: index,
    slide_object_id: slide.objectId ?? `slide_${index}`,
    nodes: [],
  }));
  return buildDeckStoryboard(presentationId, slideRefs);
}

function projectThumbnailToFrame(thumbnail: SlideThumbnail): StoryboardFrame {
  return {
    slide_index: thumbnail.slide_index,
    slide_object_id: thumbnail.slide_object_id,
    mime_type: thumbnail.mime_type,
    base64_data: thumbnail.base64_data,
  };
}
