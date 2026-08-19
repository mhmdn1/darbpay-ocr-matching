import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MediaNotFoundError, type MediaBlob, type MediaStore } from './types';

/**
 * Static mapping from WhatsApp media id → fixture file. Extend this table
 * when adding new WhatsApp fixtures.
 *
 * The `mimeType` here is what a real WhatsApp media response would report;
 * the underlying bytes on disk are plain text pretending to be a receipt —
 * good enough for the mock extractor, which keys on content hash and not
 * on the file being a "real" PDF or JPEG.
 */
const MEDIA_FIXTURES: Record<string, { file: string; mimeType: string }> = {
  media_alfanar_amb: { file: 'alfanar-fuel-ambiguous.txt', mimeType: 'image/jpeg' },
  media_marhaba_tip: { file: 'marhaba-restaurant-tip.txt', mimeType: 'image/jpeg' },
  media_petromin_najm: { file: 'petromin-najm-exact.txt', mimeType: 'image/jpeg' },
  media_garbage: { file: 'garbage-blurry.txt', mimeType: 'image/jpeg' },
};

export class FixtureMediaStore implements MediaStore {
  constructor(private readonly fixturesDir: string) {}

  async get(mediaId: string): Promise<MediaBlob> {
    const entry = MEDIA_FIXTURES[mediaId];
    if (!entry) throw new MediaNotFoundError(mediaId);
    const bytes = await readFile(join(this.fixturesDir, entry.file));
    return { bytes, mimeType: entry.mimeType };
  }

  static defaultFixturesDir(): string {
    return join(process.cwd(), 'fixtures', 'documents');
  }
}

export const KNOWN_WHATSAPP_MEDIA_IDS = Object.keys(MEDIA_FIXTURES);
