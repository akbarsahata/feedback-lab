export {};

declare global {
  interface Env {
    RUNNER?: Fetcher;
    TEST_RUN_QUEUE?: Queue<{ runId: string }>;
    ASSETS?: Fetcher;
  }
}
