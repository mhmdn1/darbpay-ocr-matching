// Runs in each worker before test modules import — used to pin the test DB
// so `lib/prisma.ts`'s dotenv-derived URL points at a throwaway file rather
// than the developer's dev.db.
process.env.DATABASE_URL = 'file:./test.db';
