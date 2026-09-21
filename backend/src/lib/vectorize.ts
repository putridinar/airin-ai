/**
 * Vectorize helpers — long-term memory / RAG for AIRIN
 * Uses Workers AI embedding model + Vectorize index
 *
 * Note: Vectorize tidak fully jalan di `wrangler dev` lokal murni.
 * Pakai `wrangler dev --remote` atau deploy supaya binding remote aktif.
 * Di local tanpa remote, memory di-skip (graceful) biar chat tetap jalan.
 */

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
const TOP_K = 5;

function isRemoteOnlyError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    msg.includes("needs to be run remotely") ||
    msg.includes("VECTORIZE") ||
    msg.includes("not implemented") ||
    msg.includes("local")
  );
}

export async function embedText(ai: Ai, text: string): Promise<number[]> {
  const res = (await ai.run(EMBED_MODEL, {
    text: [text.slice(0, 8000)],
  })) as { data?: number[][] };

  if (!res?.data?.[0]) throw new Error("Embedding failed");
  return res.data[0];
}

export async function storeMemory(
  env: Env,
  sessionId: string,
  text: string,
  metadata: Record<string, string> = {}
): Promise<void> {
  if (!env.VECTORIZE_INDEX) return;

  try {
    const values = await embedText(env.AI, text);
    const id = `${sessionId}-${crypto.randomUUID()}`;
    await env.VECTORIZE_INDEX.upsert([
      {
        id,
        values,
        metadata: {
          sessionId,
          text: text.slice(0, 2000),
          ts: new Date().toISOString(),
          ...metadata,
        },
      },
    ]);
  } catch (e) {
    if (isRemoteOnlyError(e)) {
      // Local dev tanpa --remote: skip silent
      return;
    }
    console.error("storeMemory error", e);
  }
}

export async function retrieveMemory(
  env: Env,
  sessionId: string,
  query: string
): Promise<string> {
  if (!env.VECTORIZE_INDEX) return "";

  try {
    const values = await embedText(env.AI, query);
    const matches = await env.VECTORIZE_INDEX.query(values, {
      topK: TOP_K,
      filter: { sessionId },
      returnMetadata: "all",
    });

    if (!matches?.matches?.length) return "";

    return matches.matches
      .map((m) => {
        const meta = m.metadata as Record<string, string> | undefined;
        return meta?.text ?? "";
      })
      .filter(Boolean)
      .join("\n---\n");
  } catch (e) {
    if (isRemoteOnlyError(e)) {
      // Local dev: RAG off, chat tetap jalan
      return "";
    }
    console.error("retrieveMemory error", e);
    return "";
  }
}
