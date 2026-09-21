/**
 * Multi-thread Chat History — KV-backed
 *
 * Logged-in (GitHub):
 *   - Index : conv:index:{githubId}
 *   - Thread: conv:{githubId}:{conversationId}
 *
 * Anonymous: not stored server-side (client sessionStorage).
 *
 * Legacy single-history key `chat:user:{id}` di-migrate otomatis ke 1 thread.
 */

export type HistoryMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  ts?: string;
};

export type ConversationMeta = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  preview?: string;
};

export type Conversation = ConversationMeta & {
  userId: string;
  messages: HistoryMessage[];
  githubLogin?: string;
};

export type ConversationIndex = {
  userId: string;
  githubLogin?: string;
  conversations: ConversationMeta[]; // newest first
};

const MAX_MESSAGES = 80;
const MAX_CONTENT_CHARS = 6000;
const MAX_THREADS = 40;
const LEGACY_PREFIX = "chat:user:";
const INDEX_PREFIX = "conv:index:";
const THREAD_PREFIX = "conv:";

function indexKey(userId: string) {
  return `${INDEX_PREFIX}${userId}`;
}
function threadKey(userId: string, convId: string) {
  return `${THREAD_PREFIX}${userId}:${convId}`;
}
function legacyKey(userId: string) {
  return `${LEGACY_PREFIX}${userId}`;
}

function trimMessage(m: HistoryMessage): HistoryMessage {
  return {
    role: m.role,
    content: String(m.content || "").slice(0, MAX_CONTENT_CHARS),
    ts: m.ts || new Date().toISOString(),
  };
}

function previewFromMessages(messages: HistoryMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const text = (firstUser?.content || messages[0]?.content || "Chat baru").trim();
  return text.slice(0, 80) + (text.length > 80 ? "…" : "");
}

function titleFromMessages(messages: HistoryMessage[]): string {
  const p = previewFromMessages(messages);
  return p || "Chat baru";
}

/** Resolve GitHub user from access token. */
export async function resolveGitHubUser(
  token: string | undefined | null
): Promise<{ id: string; login: string } | null> {
  if (!token) return null;
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "AIRIN-AI",
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { id?: number; login?: string };
    if (!data.id) return null;
    return { id: String(data.id), login: data.login || String(data.id) };
  } catch {
    return null;
  }
}

async function getJson<T>(env: Env, key: string): Promise<T | null> {
  if (!env.SESSIONS) return null;
  const raw = await env.SESSIONS.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function putJson(env: Env, key: string, value: unknown): Promise<void> {
  if (!env.SESSIONS) return;
  await env.SESSIONS.put(key, JSON.stringify(value));
}

/** Migrate legacy single-history blob → one conversation thread */
async function migrateLegacyIfNeeded(
  env: Env,
  userId: string,
  githubLogin?: string
): Promise<void> {
  if (!env.SESSIONS) return;
  const legacy = await getJson<{
    messages?: HistoryMessage[];
    updatedAt?: string;
    githubLogin?: string;
  }>(env, legacyKey(userId));
  if (!legacy?.messages?.length) return;

  const existing = await getJson<ConversationIndex>(env, indexKey(userId));
  if (existing?.conversations?.length) {
    // already multi-thread; drop legacy
    await env.SESSIONS.delete(legacyKey(userId));
    return;
  }

  const id = crypto.randomUUID();
  const now = legacy.updatedAt || new Date().toISOString();
  const messages = legacy.messages.slice(-MAX_MESSAGES).map(trimMessage);
  const conv: Conversation = {
    id,
    userId,
    title: titleFromMessages(messages),
    messages,
    createdAt: now,
    updatedAt: now,
    preview: previewFromMessages(messages),
    githubLogin: githubLogin || legacy.githubLogin,
  };
  const index: ConversationIndex = {
    userId,
    githubLogin: conv.githubLogin,
    conversations: [
      {
        id,
        title: conv.title,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        preview: conv.preview,
      },
    ],
  };
  await putJson(env, threadKey(userId, id), conv);
  await putJson(env, indexKey(userId), index);
  await env.SESSIONS.delete(legacyKey(userId));
}

export async function listConversations(
  env: Env,
  userId: string,
  githubLogin?: string
): Promise<ConversationIndex> {
  await migrateLegacyIfNeeded(env, userId, githubLogin);
  const idx = await getJson<ConversationIndex>(env, indexKey(userId));
  if (idx) return idx;
  return { userId, githubLogin, conversations: [] };
}

export async function getConversation(
  env: Env,
  userId: string,
  convId: string
): Promise<Conversation | null> {
  return getJson<Conversation>(env, threadKey(userId, convId));
}

export async function createConversation(
  env: Env,
  userId: string,
  opts?: { title?: string; githubLogin?: string }
): Promise<Conversation> {
  await migrateLegacyIfNeeded(env, userId, opts?.githubLogin);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const title = (opts?.title || "Chat baru").slice(0, 120);
  const conv: Conversation = {
    id,
    userId,
    title,
    messages: [],
    createdAt: now,
    updatedAt: now,
    preview: "",
    githubLogin: opts?.githubLogin,
  };

  let idx = await getJson<ConversationIndex>(env, indexKey(userId));
  if (!idx) {
    idx = { userId, githubLogin: opts?.githubLogin, conversations: [] };
  }
  idx.githubLogin = opts?.githubLogin || idx.githubLogin;
  idx.conversations = [
    {
      id,
      title: conv.title,
      createdAt: now,
      updatedAt: now,
      preview: "",
    },
    ...idx.conversations,
  ].slice(0, MAX_THREADS);

  await putJson(env, threadKey(userId, id), conv);
  await putJson(env, indexKey(userId), idx);
  return conv;
}

export async function renameConversation(
  env: Env,
  userId: string,
  convId: string,
  title: string
): Promise<Conversation | null> {
  const conv = await getConversation(env, userId, convId);
  if (!conv) return null;
  conv.title = title.slice(0, 120) || conv.title;
  conv.updatedAt = new Date().toISOString();
  await putJson(env, threadKey(userId, convId), conv);

  const idx = await getJson<ConversationIndex>(env, indexKey(userId));
  if (idx) {
    idx.conversations = idx.conversations.map((c) =>
      c.id === convId
        ? { ...c, title: conv.title, updatedAt: conv.updatedAt }
        : c
    );
    // re-sort by updatedAt desc
    idx.conversations.sort((a, b) =>
      a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0
    );
    await putJson(env, indexKey(userId), idx);
  }
  return conv;
}

export async function deleteConversation(
  env: Env,
  userId: string,
  convId: string
): Promise<boolean> {
  if (!env.SESSIONS) return false;
  await env.SESSIONS.delete(threadKey(userId, convId));
  const idx = await getJson<ConversationIndex>(env, indexKey(userId));
  if (idx) {
    idx.conversations = idx.conversations.filter((c) => c.id !== convId);
    await putJson(env, indexKey(userId), idx);
  }
  return true;
}

/** Append one user+assistant turn into a thread (create thread if missing). */
export async function appendTurnToConversation(
  env: Env,
  userId: string,
  convId: string | undefined | null,
  userMsg: string,
  assistantMsg: string,
  meta?: { githubLogin?: string }
): Promise<{ conversation: Conversation; created: boolean }> {
  await migrateLegacyIfNeeded(env, userId, meta?.githubLogin);

  let created = false;
  let id = convId || "";
  let conv = id ? await getConversation(env, userId, id) : null;

  if (!conv) {
    conv = await createConversation(env, userId, {
      title: "Chat baru",
      githubLogin: meta?.githubLogin,
    });
    id = conv.id;
    created = true;
  }

  const nextMessages = [
    ...conv.messages,
    trimMessage({ role: "user", content: userMsg }),
    trimMessage({ role: "assistant", content: assistantMsg }),
  ].slice(-MAX_MESSAGES);

  const now = new Date().toISOString();
  const autoTitle =
    conv.messages.length === 0
      ? titleFromMessages(nextMessages)
      : conv.title;

  conv = {
    ...conv,
    messages: nextMessages,
    title: autoTitle,
    updatedAt: now,
    preview: previewFromMessages(nextMessages),
    githubLogin: meta?.githubLogin || conv.githubLogin,
  };

  await putJson(env, threadKey(userId, id), conv);

  const idx = await getJson<ConversationIndex>(env, indexKey(userId));
  if (idx) {
    const metaEntry: ConversationMeta = {
      id,
      title: conv.title,
      createdAt: conv.createdAt,
      updatedAt: now,
      preview: conv.preview,
    };
    idx.conversations = [
      metaEntry,
      ...idx.conversations.filter((c) => c.id !== id),
    ].slice(0, MAX_THREADS);
    idx.githubLogin = meta?.githubLogin || idx.githubLogin;
    await putJson(env, indexKey(userId), idx);
  }

  return { conversation: conv, created };
}

// ── Backward-compatible aliases (used by older index routes if any) ──
export async function loadHistory(env: Env, userId: string) {
  const idx = await listConversations(env, userId);
  if (!idx.conversations[0]) return null;
  return getConversation(env, userId, idx.conversations[0].id);
}

export async function clearHistory(env: Env, userId: string): Promise<void> {
  if (!env.SESSIONS) return;
  const idx = await listConversations(env, userId);
  for (const c of idx.conversations) {
    await env.SESSIONS.delete(threadKey(userId, c.id));
  }
  await env.SESSIONS.delete(indexKey(userId));
  await env.SESSIONS.delete(legacyKey(userId));
}
