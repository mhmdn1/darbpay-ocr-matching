export interface MediaBlob {
  bytes: Buffer;
  mimeType: string;
}

/**
 * Abstraction over the WhatsApp media store. In production this hits
 * https://graph.facebook.com/{version}/{media-id} with a bearer token;
 * for the take-home we back it with a fixture map in this repo.
 */
export interface MediaStore {
  get(mediaId: string): Promise<MediaBlob>;
}

export class MediaNotFoundError extends Error {
  constructor(public readonly mediaId: string) {
    super(`Media not found: ${mediaId}`);
    this.name = 'MediaNotFoundError';
  }
}
