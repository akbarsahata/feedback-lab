/// <reference types="@cloudflare/vitest-plugin/types" />

declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: { name: string; queries: string[] }[];
    LEGACY_TEST_MIGRATIONS: { name: string; queries: string[] }[];
  }
}
