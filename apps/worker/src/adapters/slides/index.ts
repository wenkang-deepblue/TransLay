export { extractSlides } from "./extractor";
export { writeBackAppend, writeBackExistingSlides, writeBackNewFile } from "./writer";
export type { ExistingSlideWriteTarget, WriteBackResult } from "./writer";
export type {
  SlideNodeArchetype,
  SlideRunStyleRole,
  SlideBoxGeometry,
  SlideBulletMetadata,
  SlideTextRun,
  SlideParagraph,
  SlideTextNode,
  SlideExtractionResult,
  PresentationExtractionResult,
} from "./types";
