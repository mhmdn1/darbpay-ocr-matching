'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { actionClient } from '@/lib/actions/safe-action-client';
import { confirmMatchTx, rejectMatchTx } from '@/lib/services/review-service';
import { explainMatchOnDemand } from '@/lib/services/match-explanation';
import { REJECTION_REASONS } from '@/lib/domain/review-reasons';

const matchIdSchema = z.object({ matchId: z.number().int().positive() });
const rejectMatchSchema = matchIdSchema.extend({ reason: z.enum(REJECTION_REASONS) });

/**
 * Confirm a candidate match.
 * - Idempotent: replaying the same confirm is a no-op that returns the current state.
 * - Rejects sibling candidates on the same document.
 * - Enforces one confirmed document per transaction at the data layer.
 * - Marks the document as MATCHED.
 */
export const confirmMatch = actionClient
  .inputSchema(matchIdSchema)
  .action(async ({ parsedInput }) => {
    const result = await confirmMatchTx(parsedInput.matchId, 'reviewer');
    revalidatePath('/review');
    return result;
  });

/**
 * Reject a candidate match.
 * - Idempotent for already-decided matches.
 * - If the document has no remaining CANDIDATE matches, its status flips to UNMATCHED.
 */
export const rejectMatch = actionClient
  .inputSchema(rejectMatchSchema)
  .action(async ({ parsedInput }) => {
    const result = await rejectMatchTx(parsedInput.matchId, 'reviewer', parsedInput.reason);
    revalidatePath('/review');
    return result;
  });

/** Generate a short explanation only after the reviewer explicitly requests it. */
export const explainMatch = actionClient
  .inputSchema(matchIdSchema)
  .action(async ({ parsedInput }) => {
    const result = await explainMatchOnDemand(parsedInput.matchId);
    revalidatePath('/review');
    return result;
  });
