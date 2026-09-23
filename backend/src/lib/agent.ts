/**
 * AIRIN Agent Loop — multi-model
 * - Text / coding / tools : @cf/qwen/qwen2.5-coder-32b-instruct
 * - Vision                : @cf/moondream/moondream3.1-9B-A2B
 */

import { buildMessages } from "./system";
import { toOpenAITools } from "../tools/definitions";
import { executeTool } from "../tools/executors";
import { retrieveMemory, storeMemory } from "./vectorize";

const TEXT_MODEL = "@cf/qwen/qwen2.5-coder-32b-instruct";
const VISION_MODEL = "@cf/moondream/moondream3.1-9B-A2B";

const MAX_TOOL_ROUNDS = 6;
const AI_MAX_RETRIES = 3;

function looksLikeMissingVisionReply(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("hasil analisis vision") &&
    (normalized.includes("belum tersedia") ||
      normalized.includes("belum ada") ||
      normalized.includes("berikan gambar") ||
      normalized.includes("kirim gambar"))
  );
}

export interface ChatRequest {
  message: string;
  history?: Array<{ role: string; content: string }>;
  sessionId?: string;
  /** Multi-thread: id conversation aktif (logged-in) */
  conversationId?: string;
  imageBase64?: string;
  githubToken?: string;
  stream?: boolean;
}

export interface ChatResult {
  reply: string;
  toolCalls?: Array<{ name: string; result: string }>;
  usage?: unknown;
  visionSummary?: string;
}

function isCapacityError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    msg.includes("3040") ||
    msg.includes("Capacity temporarily exceeded") ||
    msg.includes("capacity") ||
    msg.includes("rate limit") ||
    msg.includes("429")
  );
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** AI.run with simple exponential backoff for capacity (3040) */
async function runAIWithRetry(
  env: Env,
  model: string,
  inputs: Record<string, unknown>
): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < AI_MAX_RETRIES; attempt++) {
    try {
      return await env.AI.run(model, inputs);
    } catch (e) {
      lastErr = e;
      if (isCapacityError(e) && attempt < AI_MAX_RETRIES - 1) {
        const wait = 800 * Math.pow(2, attempt); // 0.8s, 1.6s, 3.2s
        console.warn(
          `AI capacity exceeded (${model}), retry ${attempt + 1}/${AI_MAX_RETRIES} in ${wait}ms`
        );
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/**
 * Vision pipeline via Moondream 3.1
 * task=query → open-ended visual reasoning + optional redesign brief
 */
async function analyzeImageWithVision(
  env: Env,
  imageBase64: string,
  userQuestion: string
): Promise<string> {
  const rawImage = imageBase64.trim();
  const image = rawImage.startsWith("data:image/")
    ? rawImage
    : `data:image/png;base64,${rawImage.replace(/\s/g, "")}`;

  const question =
    userQuestion?.trim() ||
    "Analisis layout, komponen UI, warna, tipografi, spacing, dan hierarchy visual gambar ini secara detail. Jika ini screenshot website/app, berikan brief redesign yang actionable (struktur, Tailwind classes yang cocok, improvement UX).";

  const res = (await runAIWithRetry(env, VISION_MODEL, {
    task: "query",
    image,
    question,
    reasoning: true,
    max_tokens: 2048,
    temperature: 0.2,
  })) as {
    answer?: string;
    reasoning?: { text?: string } | null;
  };

  const text = typeof res?.answer === "string" ? res.answer.trim() : "";
  if (!text) {
    throw new Error(
      `Moondream returned no answer (finish_reason=${String((res as { finish_reason?: unknown })?.finish_reason || "unknown")})`
    );
  }

  const reasoning = res.reasoning?.text
    ? `\n\n[Reasoning]\n${res.reasoning.text}`
    : "";
  return (text + reasoning).trim() || "Tidak ada deskripsi vision yang dihasilkan.";
}

export async function runAgent(
  env: Env,
  req: ChatRequest
): Promise<ChatResult> {
  const sessionId = req.sessionId || crypto.randomUUID();
  const serverTime = new Date().toISOString();
  const history = req.history || [];

  // RAG — graceful no-op di local tanpa --remote
  const ragContext = await retrieveMemory(env, sessionId, req.message);

  let visionSummary: string | undefined;
  let effectiveUserMessage = req.message || "";

  // ── Multi-model: Vision dulu kalau ada gambar ─────────────────
  if (req.imageBase64) {
    try {
      visionSummary = await analyzeImageWithVision(
        env,
        req.imageBase64,
        req.message
      );
      effectiveUserMessage = [
        req.message?.trim()
          ? `Permintaan user: ${req.message.trim()}`
          : "User mengirim gambar/screenshot. Analisis & redesign UI jika relevan.",
        "",
        "## Hasil analisis vision (Moondream 3.1)",
        visionSummary,
        "",
        "Gunakan hasil di atas sebagai ground-truth visual. Kalau diminta redesign, keluarkan kode HTML/Tailwind yang rapi dan siap pakai.",
      ].join("\n");
    } catch (e) {
      console.error(
        "Vision model failed:",
        e instanceof Error ? e.message : String(e)
      );
      // fallback: tetap lanjut tanpa vision, biar agent text tetap hidup
      effectiveUserMessage =
        (req.message || "Analisis gambar ini.") +
        "\n\n[Catatan sistem: vision model gagal dipanggil. Jawab sebisanya dari teks saja.]";
    }
  }

  const messages = buildMessages({
    history,
    userMessage: effectiveUserMessage,
    serverTime,
    ragContext: ragContext || undefined,
  });

  if (req.githubToken) {
    messages[0] = {
      ...messages[0],
      content:
        (messages[0].content as string) +
        `\n\n## GitHub Auth\nUser sudah connect GitHub. Token tersedia di context tool calls (jangan tampilkan token ke user).`,
    };
  }

  const tools = toOpenAITools();
  const executed: Array<{ name: string; result: string }> = [];
  let finalReply = "";
  let usage: unknown;
  let webSearchCalls = 0;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = (await runAIWithRetry(env, TEXT_MODEL, {
        messages,
        tools: round === MAX_TOOL_ROUNDS - 1 ? [] : tools,
        max_tokens: 4096,
      })) as {
        response?: string;
        tool_calls?: Array<{
          id?: string;
          type?: string;
          function?: { name: string; arguments: string };
          name?: string;
          arguments?: string | Record<string, unknown>;
        }>;
        usage?: unknown;
      };

      usage = response.usage ?? usage;

      const toolCalls = normalizeToolCalls(response);

      if (!toolCalls.length) {
        const text =
          typeof response.response === "string"
            ? response.response
            : response.response != null
              ? JSON.stringify(response.response)
              : JSON.stringify(response);
        // Safety: jangan pernah leak raw tool JSON ke user
        const stillTool = parseTextToolCalls(text);
        if (stillTool.length) {
          // Treat as tool call di round berikutnya (shouldn't loop forever — MAX_TOOL_ROUNDS)
          for (const tc of stillTool) {
            let args: Record<string, unknown> = {};
            try {
              args =
                typeof tc.arguments === "string"
                  ? JSON.parse(tc.arguments || "{}")
                  : (tc.arguments as Record<string, unknown>) || {};
            } catch {
              args = {};
            }
            if (
              tc.name.startsWith("github_") &&
              req.githubToken &&
              !args.github_token
            ) {
              args.github_token = req.githubToken;
            }
            const result = await executeTool(tc.name, args, env, sessionId);
            executed.push({ name: tc.name, result });
            messages.push({
              role: "assistant",
              content: text,
            } as { role: string; content: string });
            messages.push({
              role: "tool",
              name: tc.name,
              content: result,
            } as { role: string; content: string });
          }
          messages.push({
            role: "user",
            content:
              "Hasil tool sudah tersedia. Jawab natural berdasarkan hasil. Jangan tampilkan JSON tool call.",
          } as { role: string; content: string });
          continue;
        }
        finalReply = text;
        break;
      }

      const toolResults: Array<{
        role: string;
        content: string;
        name?: string;
        tool_call_id?: string;
      }> = [];

      for (const tc of toolCalls) {
        const name = tc.name;
        let args: Record<string, unknown> = {};
        try {
          args =
            typeof tc.arguments === "string"
              ? JSON.parse(tc.arguments || "{}")
              : (tc.arguments as Record<string, unknown>) || {};
        } catch {
          args = {};
        }

        if (
          name.startsWith("github_") &&
          req.githubToken &&
          !args.github_token
        ) {
          args.github_token = req.githubToken;
        }

        const result = await executeTool(name, args, env, sessionId);
        executed.push({ name, result });
        toolResults.push({
          role: "tool",
          name,
          content: result,
          tool_call_id: tc.id,
        });

        if (name === "web_search") {
          webSearchCalls += 1;
          if (webSearchCalls >= 2) {
            finalReply = formatWebSearchResult(result);
          }
        }
      }

      if (finalReply) break;

      // Simpan turn assistant + hasil tool; untuk text-parsed calls, beri hint jelas
      const toolHint = toolCalls
        .map(
          (t) =>
            `[tool_call] ${t.name}(${typeof t.arguments === "string" ? t.arguments : JSON.stringify(t.arguments)})`
        )
        .join("\n");

      messages.push({
        role: "assistant",
        content: response.response || toolHint || "",
        ...(toolCalls.length
          ? {
              tool_calls: toolCalls.map((t, i) => ({
                id: `call_${round}_${i}`,
                type: "function",
                function: {
                  name: t.name,
                  arguments:
                    typeof t.arguments === "string"
                      ? t.arguments
                      : JSON.stringify(t.arguments || {}),
                },
              })),
            }
          : {}),
      } as { role: string; content: string });

      for (const tr of toolResults) {
        messages.push({
          role: "tool",
          content: tr.content,
          ...(tr.name ? { name: tr.name } : {}),
          ...(tr.tool_call_id ? { tool_call_id: tr.tool_call_id } : {}),
        } as { role: string; content: string });
      }

      // Dorong model untuk jawab natural setelah tool result
      messages.push({
        role: "user",
        content:
          "Hasil tool sudah tersedia di atas. Jawab pertanyaan user secara natural berdasarkan hasil tersebut. Jangan tampilkan JSON tool call lagi.",
      } as { role: string; content: string });
    }
  } catch (e) {
    if (isCapacityError(e)) {
      throw new Error(
        "Workers AI lagi penuh (error 3040 Capacity exceeded). Tunggu 10–30 detik lalu coba lagi. Model besar (Qwen2.5-Coder 32B) sering kena limit di free tier."
      );
    }
    throw e;
  }

  if (!finalReply) {
    finalReply =
      "Maaf, aku belum bisa menyelesaikan request ini. Coba lagi ya!";
  }

  // Some text-model responses incorrectly ignore the injected vision result.
  // Give it one explicit retry before returning the misleading fallback.
  if (visionSummary && looksLikeMissingVisionReply(finalReply)) {
    try {
      const retryResponse = (await runAIWithRetry(env, TEXT_MODEL, {
        messages: [
          messages[0],
          {
            role: "user",
            content: [
              "Gunakan hasil vision berikut sebagai fakta yang sudah tersedia. Jangan meminta user mengirim gambar lagi.",
              "",
              "## Hasil vision",
              visionSummary,
              "",
              req.message?.trim() ||
                "Buat analisis singkat dan, bila relevan, HTML/Tailwind redesign yang siap dipakai.",
            ].join("\n"),
          },
        ],
        max_tokens: 4096,
      })) as { response?: string };
      if (typeof retryResponse.response === "string" && retryResponse.response.trim()) {
        finalReply = retryResponse.response.trim();
      }
    } catch (e) {
      console.error("Vision-aware retry failed:", e);
    }
  }

  // Kalau ada vision summary & user minta redesign, taruh ringkas di awal biar transparan
  if (visionSummary && !req.message?.trim()) {
    // pure image upload — optional prepend short note
  }

  const memoryText = `User: ${req.message || "[image]"}\nAIRIN: ${finalReply.slice(0, 1500)}`;
  await storeMemory(env, sessionId, memoryText, { role: "chat" });

  return {
    reply: finalReply,
    toolCalls: executed.length ? executed : undefined,
    usage,
    visionSummary,
  };
}

/** Known tool names — dipakai validasi parse dari teks */
const KNOWN_TOOLS = new Set([
  "get_current_time",
  "web_search",
  "github_list_repos",
  "github_get_file",
  "github_get_tree",
  "github_search_code",
  "github_create_or_update_file",
  "r2_list",
  "r2_read",
  "r2_upload",
  "website_redesign",
]);

/**
 * Qwen2.5-Coder sering emit tool call sebagai teks JSON (bukan tool_calls native).
 * Parse beberapa format umum dari response text.
 */
function parseTextToolCalls(
  text: string
): Array<{ name: string; arguments: string | Record<string, unknown> }> {
  if (!text?.trim()) return [];
  const found: Array<{ name: string; arguments: string | Record<string, unknown> }> =
    [];
  const seen = new Set<string>();

  const push = (name: string, args: unknown) => {
    if (!KNOWN_TOOLS.has(name)) return;
    const key = name + JSON.stringify(args);
    if (seen.has(key)) return;
    seen.add(key);
    found.push({
      name,
      arguments:
        typeof args === "string"
          ? args
          : ((args as Record<string, unknown>) || {}),
    });
  };

  // 1) Fenced ```json { "name": "...", "arguments": {...} } ```
  const fenceRe = /```(?:json|tool|tool_call)?\s*([\s\S]*?)```/gi;
  let fm: RegExpExecArray | null;
  while ((fm = fenceRe.exec(text))) {
    tryParseToolJson(fm[1], push);
  }

  // 2) Raw object di mana saja: {"name":"web_search","arguments":{...}}
  const objRe =
    /\{\s*"name"\s*:\s*"([a-zA-Z0-9_]+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
  let om: RegExpExecArray | null;
  while ((om = objRe.exec(text))) {
    const name = om[1];
    try {
      const args = JSON.parse(om[2]);
      push(name, args);
    } catch {
      /* skip broken */
    }
  }

  // 3) Alternatif: {"tool":"web_search","parameters":{...}} / {"function":"..."}
  const altRe =
    /\{\s*"(?:tool|function|tool_name)"\s*:\s*"([a-zA-Z0-9_]+)"\s*,\s*"(?:arguments|parameters|args)"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
  let am: RegExpExecArray | null;
  while ((am = altRe.exec(text))) {
    try {
      push(am[1], JSON.parse(am[2]));
    } catch {
      /* skip */
    }
  }

  // 4) Seluruh response adalah satu JSON object tool call
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    tryParseToolJson(trimmed, push);
  }

  return found;
}

function tryParseToolJson(
  raw: string,
  push: (name: string, args: unknown) => void
) {
  try {
    const obj = JSON.parse(raw.trim()) as Record<string, unknown>;
    const name = String(
      obj.name || obj.tool || obj.function || obj.tool_name || ""
    );
    const args = obj.arguments ?? obj.parameters ?? obj.args ?? {};
    if (name) push(name, args);
  } catch {
    /* not valid json */
  }
}

function formatWebSearchResult(result: string): string {
  try {
    const data = JSON.parse(result) as {
      query?: string;
      results?: Array<{ title?: string; snippet?: string; url?: string }>;
    };
    const items = (data.results || []).filter((item) => item.title && item.url);
    if (!items.length) {
      return `Aku belum menemukan hasil yang cukup relevan untuk "${data.query || "pencarian ini"}".`;
    }
    return [
      `Ini hasil pencarian untuk **${data.query || "permintaanmu"}**:`,
      "",
      ...items.slice(0, 5).map(
        (item) =>
          `- **${item.title}**${item.snippet ? ` — ${item.snippet}` : ""}\n  ${item.url}`
      ),
    ].join("\n");
  } catch {
    return "Aku menemukan hasil pencarian, tetapi format hasilnya belum bisa diringkas.";
  }
}

function normalizeToolCalls(response: {
  tool_calls?: Array<{
    id?: string;
    function?: { name: string; arguments: string };
    name?: string;
    arguments?: string | Record<string, unknown>;
  }>;
  response?: string;
}): Array<{
  id?: string;
  name: string;
  arguments: string | Record<string, unknown>;
}> {
  if (response.tool_calls?.length) {
    return response.tool_calls.map((tc) => ({
      id: tc.id,
      name: tc.function?.name || tc.name || "",
      arguments: tc.function?.arguments ?? tc.arguments ?? {},
    }));
  }
  // Fallback: model dump tool call sebagai teks (Qwen2.5-Coder)
  return parseTextToolCalls(
    typeof response.response === "string" ? response.response : ""
  );
}
