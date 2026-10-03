/// <reference types="@cloudflare/workers-types" />

/**
 * AIRIN Agent Loop — multi-model
 * - Smart                 : @cf/qwen/qwen3-30b-a3b-fp8
 * - Coder                 : @cf/qwen/qwen2.5-coder-32b-instruct
 * - Vision decisions      : @cf/cloudflare/clef-flash
 */

import { buildMessages } from "./system";
import { toOpenAITools } from "../tools/definitions";
import { executeTool } from "../tools/executors";
import { retrieveMemory, storeMemory } from "./vectorize";

const SMART_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
const CODER_MODEL = "@cf/qwen/qwen2.5-coder-32b-instruct";
const VISION_MODEL = "@cf/cloudflare/clef-flash";
const MAX_VISION_IMAGES = 4;
const MAX_VISION_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_VISION_TOTAL_BYTES = 8 * 1024 * 1024;

const MAX_TOOL_ROUNDS = 6;
const AI_MAX_RETRIES = 3;

interface AgentModelResponse {
  response?: string;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name: string; arguments: string };
    name?: string;
    arguments?: string | Record<string, unknown>;
  }>;
  usage?: unknown;
}

function normalizeToolCallList(value: unknown): AgentModelResponse["tool_calls"] {
  if (!Array.isArray(value)) return undefined;

  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];

    const call = item as Record<string, unknown>;
    const fn =
      call.function &&
      typeof call.function === "object" &&
      !Array.isArray(call.function)
        ? (call.function as Record<string, unknown>)
        : undefined;
    const args = call.arguments;
    const validArgs =
      typeof args === "string" ||
      (args !== null && typeof args === "object" && !Array.isArray(args));

    return [
      {
        id: typeof call.id === "string" ? call.id : undefined,
        type: typeof call.type === "string" ? call.type : undefined,
        function:
          typeof fn?.name === "string" && typeof fn.arguments === "string"
            ? { name: fn.name, arguments: fn.arguments }
            : undefined,
        name: typeof call.name === "string" ? call.name : undefined,
        arguments: validArgs
          ? (args as string | Record<string, unknown>)
          : undefined,
      },
    ];
  });
}

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

function normalizeAgentModelResponse(value: unknown): AgentModelResponse {
  if (!value || typeof value !== "object") return {};

  const response = value as Record<string, unknown>;
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const firstChoice =
    choices[0] && typeof choices[0] === "object"
      ? (choices[0] as Record<string, unknown>)
      : undefined;
  const message =
    firstChoice?.message && typeof firstChoice.message === "object"
      ? (firstChoice.message as Record<string, unknown>)
      : undefined;
  const toolCalls = Array.isArray(response.tool_calls)
    ? response.tool_calls
    : message?.tool_calls;

  return {
    response:
      typeof response.response === "string"
        ? response.response
        : typeof message?.content === "string"
          ? message.content
          : undefined,
    tool_calls: normalizeToolCallList(toolCalls),
    usage: response.usage,
  };
}

export interface ChatRequest {
  message: string;
  mode?: "smart" | "coder";
  history?: Array<{ role: string; content: string }>;
  sessionId?: string;
  /** Multi-thread: id conversation aktif (logged-in) */
  conversationId?: string;
  imageBase64?: string;
  images?: string[];
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

type ClefAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number }
  | {
      type: "score";
      score: number;
      confidence: number;
      legend?: Record<string, string>;
    };

const VISION_QUESTIONS = {
  image_type: {
    type: "choice",
    instructions: "Classify the primary type of the attached image.",
    criteria: {
      website_screenshot: "A screenshot of a website or web application.",
      mobile_app_screenshot: "A screenshot of a mobile application.",
      desktop_software: "A screenshot of desktop software.",
      photograph: "A real-world photograph.",
      illustration: "An illustration, drawing, or rendered artwork.",
      document: "A document, slide, or page of text.",
      chart: "A chart, graph, or data visualization.",
      other: "Another kind of image.",
      unclear: "The image is not clear enough to classify.",
    },
  },
  ui_platform: {
    type: "choice",
    instructions: "If the image shows a user interface, identify its platform.",
    criteria: {
      desktop_web: "A website or web application on a desktop-sized screen.",
      mobile_web: "A website displayed on a mobile-sized screen.",
      mobile_app: "A native mobile application interface.",
      desktop_app: "A desktop software application interface.",
      tablet_app: "A tablet application interface.",
      not_a_user_interface: "The image does not show a user interface.",
      unclear: "The interface platform cannot be determined.",
    },
  },
  layout: {
    type: "choice",
    instructions: "Identify the most prominent overall layout structure.",
    criteria: {
      sidebar: "A prominent side navigation or sidebar layout.",
      top_navigation: "A prominent top navigation layout.",
      dashboard: "A dashboard with multiple information panels.",
      card_grid: "A grid or list of repeated cards.",
      form: "A form or data-entry focused layout.",
      editorial: "A text or editorial content-focused layout.",
      full_screen_media: "An image or media-dominant layout.",
      other: "Another recognizable layout structure.",
      unclear: "The layout structure is not clear.",
    },
  },
  color_theme: {
    type: "choice",
    instructions: "Classify the dominant visual color theme.",
    criteria: {
      dark: "Predominantly dark backgrounds and light foregrounds.",
      light: "Predominantly light backgrounds and dark foregrounds.",
      colorful: "Several vivid, saturated colors dominate.",
      monochrome: "Mostly grayscale or a single color family.",
      mixed: "A balanced mix of light and dark regions.",
      unclear: "The color theme cannot be determined.",
    },
  },
  design_style: {
    type: "choice",
    instructions: "Choose the closest overall visual design style.",
    criteria: {
      minimal: "Minimal, restrained, and low in visual ornament.",
      modern: "Contemporary product or technology interface styling.",
      corporate: "Formal business or enterprise styling.",
      playful: "Expressive, friendly, or playful styling.",
      editorial: "Magazine, publishing, or typography-led styling.",
      skeuomorphic: "Uses realistic textures, depth, or physical metaphors.",
      other: "Another recognizable visual style.",
      unclear: "The visual style is not clear.",
    },
  },
  visible_text: {
    type: "noul",
    instructions: "Is readable text visibly present in the image?",
    criteria: {
      true: "Readable words or labels are visible.",
      false: "No readable text is visible.",
    },
  },
  visual_hierarchy: {
    type: "score",
    instructions: "Rate how clearly visual emphasis and hierarchy are established.",
    criteria: [
      "No discernible hierarchy.",
      "Weak hierarchy; important elements are difficult to distinguish.",
      "Moderate hierarchy with some clear emphasis.",
      "Clear hierarchy; primary and secondary elements are distinguishable.",
      "Very clear and consistent visual hierarchy.",
    ],
  },
} as const;

const VISION_LABELS: Record<string, Record<string, string>> = {
  image_type: {
    website_screenshot: "Screenshot website/web app",
    mobile_app_screenshot: "Screenshot aplikasi mobile",
    desktop_software: "Screenshot software desktop",
    photograph: "Foto",
    illustration: "Ilustrasi atau artwork",
    document: "Dokumen atau slide",
    chart: "Chart atau visualisasi data",
    other: "Jenis gambar lainnya",
    unclear: "Jenis gambar belum jelas",
  },
  ui_platform: {
    desktop_web: "Web desktop",
    mobile_web: "Web mobile",
    mobile_app: "Aplikasi mobile",
    desktop_app: "Aplikasi desktop",
    tablet_app: "Aplikasi tablet",
    not_a_user_interface: "Bukan antarmuka pengguna",
    unclear: "Platform belum jelas",
  },
  layout: {
    sidebar: "Navigasi samping",
    top_navigation: "Navigasi atas",
    dashboard: "Dashboard",
    card_grid: "Grid atau daftar kartu",
    form: "Formulir",
    editorial: "Konten editorial",
    full_screen_media: "Media layar penuh",
    other: "Struktur lainnya",
    unclear: "Layout belum jelas",
  },
  color_theme: {
    dark: "Dominan gelap",
    light: "Dominan terang",
    colorful: "Warna-warna cerah",
    monochrome: "Monokrom",
    mixed: "Campuran terang dan gelap",
    unclear: "Palet belum jelas",
  },
  design_style: {
    minimal: "Minimalis",
    modern: "Modern",
    corporate: "Korporat",
    playful: "Playful",
    editorial: "Editorial",
    skeuomorphic: "Skeuomorphic",
    other: "Gaya lainnya",
    unclear: "Gaya belum jelas",
  },
};

function parseVisionImages(req: ChatRequest): string[] {
  const suppliedImages = req.images?.length
    ? req.images
    : req.imageBase64
      ? [req.imageBase64]
      : [];

  if (suppliedImages.length > MAX_VISION_IMAGES) {
    throw new Error(`Maksimal ${MAX_VISION_IMAGES} gambar per permintaan.`);
  }

  let totalBytes = 0;
  return suppliedImages.map((input, index) => {
    const raw = input.trim();
    const dataUrlMatch = raw.match(
      /^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/i
    );
    if (raw.startsWith("data:") && !dataUrlMatch) {
      throw new Error(
        `Gambar ke-${index + 1} harus berupa PNG, JPEG, atau WebP base64.`
      );
    }
    if (!dataUrlMatch && !/^[A-Za-z0-9+/=\s]+$/.test(raw)) {
      throw new Error("Gambar harus dikirim sebagai data base64, bukan URL.");
    }

    const mimeType = dataUrlMatch?.[1].toLowerCase() || "image/png";
    const base64 = (dataUrlMatch?.[2] || raw).replace(/\s/g, "");
    if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
      throw new Error(`Data base64 gambar ke-${index + 1} tidak valid.`);
    }

    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    const byteLength = (base64.length / 4) * 3 - padding;
    if (byteLength > MAX_VISION_IMAGE_BYTES) {
      throw new Error(`Ukuran gambar ke-${index + 1} melebihi 4 MiB.`);
    }
    totalBytes += byteLength;
    if (totalBytes > MAX_VISION_TOTAL_BYTES) {
      throw new Error("Total ukuran gambar melebihi 8 MiB.");
    }

    return `data:${mimeType};base64,${base64}`;
  });
}

function formatClefAnswer(
  question: string,
  answer: ClefAnswer | undefined
): string {
  if (!answer) throw new Error(`Clef Flash did not return "${question}".`);

  if (answer.type === "choice") {
    const label = VISION_LABELS[question]?.[answer.choice] || answer.choice;
    return `${label} (keyakinan ${Math.round(answer.confidence * 100)}%)`;
  }
  if (answer.type === "noul") {
    return answer.noul >= 0.5 ? "Ya" : "Tidak";
  }
  if (answer.type === "score") {
    const level = Math.max(
      0,
      Math.min(Math.round(answer.score), (answer.legend && Object.keys(answer.legend).length - 1) || 4)
    );
    const description = answer.legend?.[String(level)];
    return `${answer.score.toFixed(1)}/4${description ? ` — ${description}` : ""} (keyakinan ${Math.round(answer.confidence * 100)}%)`;
  }
  throw new Error(`Clef Flash returned an unsupported answer for "${question}".`);
}

/** Clef Flash classifies visual evidence; Qwen turns these observations into a response. */
async function analyzeImageWithVision(
  env: Env,
  images: string[],
  userQuestion: string
): Promise<string> {
  const state = [
    "Analyze only visible evidence in the attached image(s). Do not infer or invent text or details that are not legible.",
    userQuestion?.trim() ? `User request: ${userQuestion.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const response = (await runAIWithRetry(env, VISION_MODEL, {
    model: "clef-flash",
    state,
    questions: VISION_QUESTIONS,
    images,
  })) as { answers?: Record<string, ClefAnswer> };

  if (!response.answers || typeof response.answers !== "object") {
    throw new Error("Clef Flash returned no structured visual answers.");
  }

  return [
    `- Jenis gambar: ${formatClefAnswer("image_type", response.answers.image_type)}`,
    `- Antarmuka: ${formatClefAnswer("ui_platform", response.answers.ui_platform)}`,
    `- Struktur layout: ${formatClefAnswer("layout", response.answers.layout)}`,
    `- Tema warna: ${formatClefAnswer("color_theme", response.answers.color_theme)}`,
    `- Gaya visual: ${formatClefAnswer("design_style", response.answers.design_style)}`,
    `- Teks terbaca: ${formatClefAnswer("visible_text", response.answers.visible_text)}`,
    `- Hierarki visual: ${formatClefAnswer("visual_hierarchy", response.answers.visual_hierarchy)}`,
  ].join("\n");
}

export async function runAgent(
  env: Env,
  req: ChatRequest
): Promise<ChatResult> {
  const sessionId = req.sessionId || crypto.randomUUID();
  const mode = req.mode === "coder" ? "coder" : "smart";
  const textModel = mode === "coder" ? CODER_MODEL : SMART_MODEL;
  const serverTime = new Date().toISOString();
  const history = req.history || [];

  // RAG — graceful no-op di local tanpa --remote
  const ragContext = await retrieveMemory(env, sessionId, req.message);

  let visionSummary: string | undefined;
  let visionAnalysisFailed = false;
  let effectiveUserMessage = req.message || "";

  // ── Multi-model: Vision dulu kalau ada gambar ─────────────────
  const hasImages = Boolean(req.imageBase64 || req.images?.length);
  if (hasImages) {
    try {
      const images = parseVisionImages(req);
      visionSummary = await analyzeImageWithVision(
        env,
        images,
        req.message
      );
      effectiveUserMessage = [
        req.message?.trim()
          ? `Permintaan user: ${req.message.trim()}`
          : "User mengirim gambar/screenshot. Analisis & redesign UI jika relevan.",
        "",
        "## Atribut visual terstruktur (Clef Flash)",
        visionSummary,
        "",
        "Gunakan atribut terstruktur ini sebagai petunjuk visual, bukan deskripsi lengkap. Jangan mengarang teks atau detail gambar yang tidak tercantum. Kalau diminta redesign, keluarkan kode HTML/Tailwind yang rapi dan siap pakai.",
      ].join("\n");
    } catch (e) {
      visionAnalysisFailed = true;
      console.error(
        "Vision model failed:",
        e instanceof Error ? e.message : String(e)
      );
      // fallback: tetap lanjut tanpa vision, biar agent text tetap hidup
      effectiveUserMessage =
        (req.message || "Analisis gambar ini.") +
        "\n\n[Catatan sistem: analisis visual terstruktur gagal. Jawab pertanyaan teks saja dan jangan mengarang isi gambar.]";
    }
  }

  const messages = buildMessages({
    history,
    userMessage: effectiveUserMessage,
    serverTime,
    ragContext: ragContext || undefined,
    mode,
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
      const modelResponse = await runAIWithRetry(env, textModel, {
        messages,
        tools: round === MAX_TOOL_ROUNDS - 1 ? [] : tools,
        max_tokens: 4096,
      });
      const response = normalizeAgentModelResponse(modelResponse);

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
        `Workers AI lagi penuh (error 3040 Capacity exceeded) untuk model ${textModel}. Tunggu 10–30 detik lalu coba lagi.`
      );
    }
    throw e;
  }

  if (!finalReply) {
    finalReply =
      "Maaf, aku belum bisa menyelesaikan request ini. Coba lagi ya!";
  }

  if (visionAnalysisFailed) {
    finalReply =
      "Catatan: AIRIN belum berhasil memproses gambar, jadi detail visual belum dapat dianalisis. Coba unggah PNG, JPEG, atau WebP maksimal 4 MiB per gambar, lalu coba lagi.\n\n" +
      finalReply;
  }

  // Some text-model responses incorrectly ignore the injected vision result.
  // Give it one explicit retry before returning the misleading fallback.
  if (visionSummary && looksLikeMissingVisionReply(finalReply)) {
    try {
      const retryResponse = normalizeAgentModelResponse(
        await runAIWithRetry(env, textModel, {
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
        })
      );
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
function setTimeout(r: (value: unknown) => void, ms: number): void {
  throw new Error("Function not implemented.");
}
