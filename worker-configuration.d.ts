interface D1MigrationBinding {
  name: string;
  queries: string[];
}

declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    TEST_MIGRATIONS: D1MigrationBinding[];
  }
}

interface Env extends Cloudflare.Env {}
