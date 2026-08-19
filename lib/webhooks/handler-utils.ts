import { MockExtractor } from '@/lib/extraction/mock-extractor';
import { FixtureMediaStore } from '@/lib/media/fixture-media-store';
import type { DocumentExtractor } from '@/lib/extraction/types';
import type { MediaStore } from '@/lib/media/types';

// Lazily built and cached at module level so we only load fixtures once.
let extractorPromise: Promise<DocumentExtractor> | null = null;
export function getExtractor(): Promise<DocumentExtractor> {
  if (!extractorPromise) extractorPromise = MockExtractor.create();
  return extractorPromise;
}

let mediaStore: MediaStore | null = null;
export function getMediaStore(): MediaStore {
  if (!mediaStore) mediaStore = new FixtureMediaStore(FixtureMediaStore.defaultFixturesDir());
  return mediaStore;
}

export function badRequest(message: string, details?: unknown): Response {
  return Response.json({ error: message, details }, { status: 400 });
}

export function ok(body: unknown): Response {
  return Response.json(body, { status: 200 });
}
