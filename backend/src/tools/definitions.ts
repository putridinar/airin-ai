/**
 * Tool definitions for AIRIN AI function-calling / agentic loop
 * Modular — each tool has name, description, JSON schema parameters
 */

export interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const TOOL_DEFINITIONS: ToolDef[] = [
  {
    name: "get_current_time",
    description:
      "Mendapatkan waktu server saat ini dalam ISO 8601. Gunakan untuk menjawab pertanyaan tentang hari/jam.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "web_search",
    description:
      "Pencarian web real-time via DuckDuckGo. Gunakan untuk info terkini, berita, fakta yang butuh update.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Kata kunci pencarian",
        },
        max_results: {
          type: "number",
          description: "Jumlah hasil maksimal (default 5)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "github_list_repos",
    description:
      "List repositori GitHub milik user yang sudah OAuth. Butuh github_token.",
    parameters: {
      type: "object",
      properties: {
        github_token: { type: "string", description: "User GitHub access token" },
        type: {
          type: "string",
          description: "all | owner | member (default all)",
        },
      },
      required: ["github_token"],
    },
  },
  {
    name: "github_get_file",
    description:
      "Baca isi file dari repo GitHub (path relatif dari root).",
    parameters: {
      type: "object",
      properties: {
        github_token: { type: "string" },
        owner: { type: "string" },
        repo: { type: "string" },
        path: { type: "string", description: "Path file, e.g. src/index.ts" },
        ref: { type: "string", description: "branch/tag/commit (optional)" },
      },
      required: ["github_token", "owner", "repo", "path"],
    },
  },
  {
    name: "github_get_tree",
    description: "Ambil tree (struktur folder/file) sebuah repo.",
    parameters: {
      type: "object",
      properties: {
        github_token: { type: "string" },
        owner: { type: "string" },
        repo: { type: "string" },
        recursive: { type: "boolean", description: "true untuk recursive" },
      },
      required: ["github_token", "owner", "repo"],
    },
  },
  {
    name: "github_search_code",
    description: "Cari kode di GitHub (user atau global).",
    parameters: {
      type: "object",
      properties: {
        github_token: { type: "string" },
        query: { type: "string", description: "GitHub code search query" },
      },
      required: ["github_token", "query"],
    },
  },
  {
    name: "github_create_or_update_file",
    description:
      "Buat atau update file di repo, lalu commit + push (via Contents API).",
    parameters: {
      type: "object",
      properties: {
        github_token: { type: "string" },
        owner: { type: "string" },
        repo: { type: "string" },
        path: { type: "string" },
        content: { type: "string", description: "Isi file (plain text)" },
        message: { type: "string", description: "Commit message" },
        branch: { type: "string", description: "Target branch (default main)" },
      },
      required: ["github_token", "owner", "repo", "path", "content", "message"],
    },
  },
  {
    name: "r2_list_files",
    description: "List file di R2 bucket milik user (prefix optional).",
    parameters: {
      type: "object",
      properties: {
        prefix: { type: "string", description: "Prefix path / folder" },
        limit: { type: "number", description: "Max items (default 50)" },
      },
      required: [],
    },
  },
  {
    name: "r2_read_file",
    description: "Baca isi file text dari R2.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Object key di R2" },
      },
      required: ["key"],
    },
  },
  {
    name: "r2_upload_text",
    description: "Upload teks/konten sebagai file ke R2.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string" },
        content: { type: "string" },
        content_type: {
          type: "string",
          description: "MIME type (default text/plain)",
        },
      },
      required: ["key", "content"],
    },
  },
  {
    name: "website_redesign",
    description:
      "Ambil Markdown/HTML/screenshot dari URL website via website-rrader API, lalu siap untuk di-redesign oleh model.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL website yang mau di-redesign" },
      },
      required: ["url"],
    },
  },
];

/** OpenAI-style tools array for Workers AI */
export function toOpenAITools() {
  return TOOL_DEFINITIONS.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
