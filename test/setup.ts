import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeEach } from 'vitest';
import { clearDatabase } from './helpers';

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(async () => {
  await clearDatabase();
});
