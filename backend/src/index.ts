/**
 * AIRIN AI — Cloudflare Worker Backend
 * Routing + CORS + Agent loop + GitHub OAuth + R2 upload
 */

import { corsHeaders, jsonResponse, optionsResponse } from "./lib/cors";
import { runAgent, type ChatRequest } from "./lib/agent";
import {
  handleGitHubAuth,
  handleGitHubCallback,
} from "./lib/github-oauth";
import {
  appendTurnToConversation,
  clearHistory,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  renameConversation,
  resolveGitHubUser,
} from "./lib/history";

function extractGithubToken(request: Request, bodyToken?: string): string | undefined {
  return (
    bodyToken ||
    request.headers.get("X-GitHub-Token") ||
    request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ||
    undefined
  );
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const allowed = env.FRONTEND_ORIGIN || "*";

    // Preflight
    if (request.method === "OPTIONS") {
      return optionsResponse(origin, allowed);
    }

    try {
      // ── Health ──────────────────────────────────────────
      if (url.pathname === "/" || url.pathname === "/health") {
        return jsonResponse(
          {
            ok: true,
            service: "AIRIN AI Backend",
            model: "@cf/qwen/qwen2.5-coder-32b-instruct",
            vision: "@cf/moondream/moondream3.1-9B-A2B",
            time: new Date().toISOString(),
          },
          200,
          origin,
          allowed
        );
      }

      // ── GitHub OAuth ────────────────────────────────────
      if (url.pathname === "/auth/github") {
        return handleGitHubAuth(request, env);
      }
      if (url.pathname === "/auth/github/callback") {
        return handleGitHubCallback(request, env);
      }

      // ── Multi-thread conversations (logged-in only) ─────
      // GET    /api/conversations
      // POST   /api/conversations          { title? }
      // GET    /api/conversations/:id
      // PATCH  /api/conversations/:id      { title }
      // DELETE /api/conversations/:id
      // DELETE /api/conversations          — wipe all (legacy /api/history)
      if (
        url.pathname === "/api/conversations" ||
        url.pathname.startsWith("/api/conversations/") ||
        url.pathname === "/api/history"
      ) {
        const token = extractGithubToken(request);
        const ghUser = await resolveGitHubUser(token);
        if (!ghUser) {
          return jsonResponse(
            {
              error: "unauthorized",
              detail:
                "Conversation server-side hanya untuk user login GitHub. Anonim pakai sessionStorage.",
            },
            401,
            origin,
            allowed
          );
        }

        // Legacy wipe-all
        if (url.pathname === "/api/history" && request.method === "DELETE") {
          await clearHistory(env, ghUser.id);
          return jsonResponse({ ok: true }, 200, origin, allowed);
        }

        // List / create / wipe-all
        if (url.pathname === "/api/conversations") {
          if (request.method === "GET") {
            const idx = await listConversations(
              env,
              ghUser.id,
              ghUser.login
            );
            return jsonResponse(
              {
                userId: ghUser.id,
                login: ghUser.login,
                conversations: idx.conversations,
              },
              200,
              origin,
              allowed
            );
          }
          if (request.method === "POST") {
            let title: string | undefined;
            try {
              const b = (await request.json()) as { title?: string };
              title = b.title;
            } catch {
              /* empty body ok */
            }
            const conv = await createConversation(env, ghUser.id, {
              title,
              githubLogin: ghUser.login,
            });
            return jsonResponse({ conversation: conv }, 201, origin, allowed);
          }
          if (request.method === "DELETE") {
            await clearHistory(env, ghUser.id);
            return jsonResponse({ ok: true }, 200, origin, allowed);
          }
          return jsonResponse(
            { error: "method not allowed" },
            405,
            origin,
            allowed
          );
        }

        // /api/conversations/:id
        if (url.pathname.startsWith("/api/conversations/")) {
          const convId = decodeURIComponent(
            url.pathname.replace("/api/conversations/", "")
          );
          if (!convId || convId.includes("/")) {
            return jsonResponse({ error: "invalid id" }, 400, origin, allowed);
          }

          if (request.method === "GET") {
            const conv = await getConversation(env, ghUser.id, convId);
            if (!conv) {
              return jsonResponse(
                { error: "not found" },
                404,
                origin,
                allowed
              );
            }
            return jsonResponse({ conversation: conv }, 200, origin, allowed);
          }

          if (request.method === "PATCH") {
            const body = (await request.json()) as { title?: string };
            if (!body.title?.trim()) {
              return jsonResponse(
                { error: "title required" },
                400,
                origin,
                allowed
              );
            }
            const conv = await renameConversation(
              env,
              ghUser.id,
              convId,
              body.title.trim()
            );
            if (!conv) {
              return jsonResponse(
                { error: "not found" },
                404,
                origin,
                allowed
              );
            }
            return jsonResponse({ conversation: conv }, 200, origin, allowed);
          }

          if (request.method === "DELETE") {
            await deleteConversation(env, ghUser.id, convId);
            return jsonResponse({ ok: true }, 200, origin, allowed);
          }

          return jsonResponse(
            { error: "method not allowed" },
            405,
            origin,
            allowed
          );
        }
      }

      // ── Chat (main agent endpoint) ──────────────────────
      if (url.pathname === "/api/chat" && request.method === "POST") {
        const body = (await request.json()) as ChatRequest & {
          conversationId?: string;
        };
        if (!body.message && !body.imageBase64) {
          return jsonResponse(
            { error: "message or imageBase64 required" },
            400,
            origin,
            allowed
          );
        }

        const headerToken = request.headers.get("X-GitHub-Token");
        if (headerToken && !body.githubToken) {
          body.githubToken = headerToken;
        }

        try {
          const result = await runAgent(env, body);

          // Persist into thread when logged in
          let persisted = false;
          let conversationId = body.conversationId || null;
          let conversationTitle: string | null = null;
          const ghUser = await resolveGitHubUser(body.githubToken);
          if (ghUser) {
            const userText =
              body.message ||
              (body.imageBase64 ? "[image uploaded]" : "");
            const { conversation, created } = await appendTurnToConversation(
              env,
              ghUser.id,
              body.conversationId,
              userText,
              result.reply,
              { githubLogin: ghUser.login }
            );
            conversationId = conversation.id;
            conversationTitle = conversation.title;
            persisted = true;
            // created flag available if FE wants to refresh list
            void created;
          }

          return jsonResponse(
            {
              reply: result.reply,
              toolCalls: result.toolCalls,
              usage: result.usage,
              visionSummary: result.visionSummary,
              sessionId: body.sessionId || null,
              historyPersisted: persisted,
              conversationId,
              conversationTitle,
            },
            200,
            origin,
            allowed
          );
        } catch (chatErr) {
          const msg =
            chatErr instanceof Error ? chatErr.message : String(chatErr);
          const isCapacity =
            msg.includes("3040") ||
            msg.includes("Capacity") ||
            msg.includes("penuh");
          return jsonResponse(
            {
              error: isCapacity ? "ai_capacity" : "chat_failed",
              detail: msg,
              hint: isCapacity
                ? "Tunggu 10–30 detik lalu kirim lagi. Atau pakai wrangler dev --remote."
                : undefined,
            },
            isCapacity ? 503 : 500,
            origin,
            allowed
          );
        }
      }

      // ── R2 direct upload (multipart / binary) ───────────
      if (url.pathname === "/api/r2/upload" && request.method === "POST") {
        const key =
          url.searchParams.get("key") ||
          `uploads/${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
        const contentType =
          request.headers.get("Content-Type") || "application/octet-stream";
        const buf = await request.arrayBuffer();
        await env.R2_BUCKET.put(key, buf, {
          httpMetadata: { contentType },
        });
        return jsonResponse(
          { success: true, key, size: buf.byteLength },
          200,
          origin,
          allowed
        );
      }

      // ── R2 list ─────────────────────────────────────────
      if (url.pathname === "/api/r2/list" && request.method === "GET") {
        const prefix = url.searchParams.get("prefix") || "";
        const listed = await env.R2_BUCKET.list({
          prefix,
          limit: 100,
        });
        return jsonResponse(
          {
            objects: listed.objects.map((o) => ({
              key: o.key,
              size: o.size,
              uploaded: o.uploaded,
            })),
          },
          200,
          origin,
          allowed
        );
      }

      // ── R2 get (download / text) ────────────────────────
      if (url.pathname.startsWith("/api/r2/get/") && request.method === "GET") {
        const key = decodeURIComponent(
          url.pathname.replace("/api/r2/get/", "")
        );
        const obj = await env.R2_BUCKET.get(key);
        if (!obj) {
          return jsonResponse({ error: "not found" }, 404, origin, allowed);
        }
        const headers = new Headers(corsHeaders(origin, allowed));
        headers.set(
          "Content-Type",
          obj.httpMetadata?.contentType || "application/octet-stream"
        );
        if (obj.size) headers.set("Content-Length", String(obj.size));
        return new Response(obj.body, { status: 200, headers });
      }

      return jsonResponse({ error: "Not found" }, 404, origin, allowed);
    } catch (err) {
      console.error("Worker error:", err);
      return jsonResponse(
        {
          error: "Internal error",
          detail: err instanceof Error ? err.message : String(err),
        },
        500,
        origin,
        allowed
      );
    }
  },
} satisfies ExportedHandler<Env>;
