/** Generated-style Env for AIRIN AI Worker */
interface Env {
  AI: Ai;
  R2_BUCKET: R2Bucket;
  VECTORIZE_INDEX: VectorizeIndex;
  SESSIONS: KVNamespace;

  FRONTEND_ORIGIN: string;
  GITHUB_REDIRECT_URI: string;

  /** Secrets — set via `wrangler secret put` */
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
}

interface Ai {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options?: { gateway?: { id: string } }
  ): Promise<unknown>;
}
