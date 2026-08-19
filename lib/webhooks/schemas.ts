import { z } from 'zod';

// ── Email inbound-parse payload ─────────────────────────────────────────────

export const EmailAttachmentSchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().min(1),
  contentBase64: z.string().min(1),
});

export const EmailWebhookSchema = z.object({
  messageId: z.string().min(1),
  from: z.string().email(),
  to: z.string().email(),
  subject: z.string().optional().default(''),
  receivedAt: z.string().datetime(),
  attachments: z.array(EmailAttachmentSchema).min(1),
});

export type EmailWebhookPayload = z.infer<typeof EmailWebhookSchema>;

// ── WhatsApp Meta Cloud API payload (simplified) ────────────────────────────

export const WhatsAppImageSchema = z.object({
  id: z.string().min(1),
  mime_type: z.string().min(1),
  sha256: z.string().optional(),
});

export const WhatsAppMessageSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  timestamp: z.string().min(1),
  type: z.literal('image'),
  image: WhatsAppImageSchema,
});

export const WhatsAppValueSchema = z.object({
  messages: z.array(WhatsAppMessageSchema).min(1),
});

export const WhatsAppChangeSchema = z.object({
  value: WhatsAppValueSchema,
});

export const WhatsAppEntrySchema = z.object({
  changes: z.array(WhatsAppChangeSchema).min(1),
});

export const WhatsAppWebhookSchema = z.object({
  entry: z.array(WhatsAppEntrySchema).min(1),
});

export type WhatsAppWebhookPayload = z.infer<typeof WhatsAppWebhookSchema>;
