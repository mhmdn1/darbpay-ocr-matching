import { WhatsAppWebhookSchema } from '@/lib/webhooks/schemas';
import { badRequest, getExtractor, getMediaStore, ok } from '@/lib/webhooks/handler-utils';
import { verifySignature } from '@/lib/webhooks/signature';
import { ingestDocument, normalizePhone, type IngestionResult } from '@/lib/services/document-ingestion';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const rawBody = await request.text();

  // Meta uses the header name `x-hub-signature-256` for its Cloud API.
  const sig = verifySignature({
    rawBody,
    headerValue: request.headers.get('x-hub-signature-256'),
    secret: process.env.WHATSAPP_WEBHOOK_SECRET,
  });
  if (!sig.ok) return Response.json({ error: sig.reason }, { status: 401 });

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return badRequest('Invalid JSON body');
  }

  const parsed = WhatsAppWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest('Payload failed validation', parsed.error.issues);
  }
  const payload = parsed.data;

  const extractor = await getExtractor();
  const media = getMediaStore();
  const results: Array<{ messageId: string; result?: IngestionResult; error?: string }> = [];

  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      for (const msg of change.value.messages) {
        try {
          const blob = await media.get(msg.image.id);
          const result = await ingestDocument(
            {
              source: 'WHATSAPP',
              externalId: msg.id,
              senderIdentifier: normalizePhone(msg.from),
              fileBytes: blob.bytes,
              mimeType: blob.mimeType,
              receivedAt: new Date(Number(msg.timestamp) * 1000),
            },
            { extractor },
          );
          results.push({ messageId: msg.id, result });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error('whatsapp ingestion failed', { messageId: msg.id, mediaId: msg.image.id, message });
          results.push({ messageId: msg.id, error: message });
        }
      }
    }
  }

  return ok({ signatureEnforced: sig.enforced, results });
}
