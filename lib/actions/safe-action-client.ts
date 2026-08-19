import { createSafeActionClient } from 'next-safe-action';
import { log } from '@/lib/logger';

export const actionClient = createSafeActionClient({
  handleServerError(e) {
    log.error('server action error', { message: e.message, stack: e.stack });
    return e.message;
  },
});
