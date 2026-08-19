import { EmailWebhookSchema } from '@/lib/webhooks/schemas';
import { badRequest, getExtractor, ok } from '@/lib/webhooks/handler-utils';
import { verifySignature } from '@/lib/webhooks/signature';
import { ingestDocument, type IngestionResult } from '@/lib/services/document-ingestion';
import { log } from '@/lib/logger';

export const runtime = 'nodejs'; // Buffer + node crypto in the pipeline

export async function POST(request: Request) {
  const rawBody = await request.text();

  const sig = verifySignature({
    rawBody,
    headerValue: request.headers.get('x-webhook-signature'),
    secret: process.env.EMAIL_WEBHOOK_SECRET,
  });
  if (!sig.ok) return Response.json({ error: sig.reason }, { status: 401 });

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return badRequest('Invalid JSON body');
  }

  const parsed = EmailWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest('Payload failed validation', parsed.error.issues);
  }
  const payload = parsed.data;

  const extractor = await getExtractor();
  const receivedAt = new Date(payload.receivedAt);
  const results: Array<{ filename: string; result?: IngestionResult; error?: string }> = [];

  for (const [index, attachment] of payload.attachments.entries()) {
    const perAttachmentId =
      payload.attachments.length === 1 ? payload.messageId : `${payload.messageId}::${index}`;

    try {
      const bytes = Buffer.from(attachment.contentBase64, 'base64');
      const result = await ingestDocument(
        {
          source: 'EMAIL',
          externalId: perAttachmentId,
          senderIdentifier: payload.from.toLowerCase(),
          fileBytes: bytes,
          mimeType: attachment.contentType,
          receivedAt,
        },
        { extractor },
      );
      results.push({ filename: attachment.filename, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('email attachment ingestion failed', { messageId: payload.messageId, filename: attachment.filename, message });
      results.push({ filename: attachment.filename, error: message });
    }
  }

  return ok({ messageId: payload.messageId, signatureEnforced: sig.enforced, results });
}
