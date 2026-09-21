# AIRIN AI

Asisten AI serba bisa di atas **Cloudflare Workers AI** (multi-model) + frontend vanilla.

- **Text / coding / agent**: `@cf/qwen/qwen2.5-coder-32b-instruct`
- **Vision**: `@cf/moondream/moondream3.1-9B-A2B`

```
airin-ai/
├── backend/          # Cloudflare Worker (TypeScript)
│   ├── src/
│   │   ├── index.ts          # Router + CORS + endpoints
│   │   ├── lib/
│   │   │   ├── agent.ts      # Agent loop + function calling
│   │   │   ├── system.ts     # Personality & prompt
│   │   │   ├── vectorize.ts  # RAG / long-term memory
│   │   │   ├── cors.ts
│   │   │   └── github-oauth.ts
│   │   └── tools/
│   │       ├── definitions.ts
│   │       └── executors.ts
│   ├── wrangler.toml
│   └── package.json
└── frontend/         # Static HTML/JS (Pages / Vercel / GH Pages)
    ├── index.html
    ├── styles.css
    └── app.js
```

## Fitur

| Fitur | Keterangan |
| --- | --- |
| Personality dual-mode | Gaul/casual ↔ profesional otomatis |
| Model (text) | `@cf/qwen/qwen2.5-coder-32b-instruct` (coding + agent) |
| Model (vision) | `@cf/moondream/moondream3.1-9B-A2B` (query / caption / detect) |
| Context | Sliding window + Vectorize RAG |
| Web search | DuckDuckGo (tanpa API key) |
| GitHub OAuth | `/auth/github` + tools baca/commit/push |
| R2 | Upload, list, read file |
| Website redesign | Call `website-reader-nine.vercel.app` + model redesign |
| Vision | Upload / paste screenshot → analisis + UI code |

## Setup Backend

```bash
cd backend
npm install

# Buat resources (sekali)
npx wrangler r2 bucket create airin-ai-files
npx wrangler vectorize create airin-memory --dimensions=768 --metric=cosine
npx wrangler kv namespace create SESSIONS

# Isi id di wrangler.toml (KV id dari output di atas)

# Secrets
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET   # random string

# Dev
npm run dev
# → http://localhost:8788
```

### GitHub OAuth App

1. GitHub → Settings → Developer settings → OAuth Apps → New
2. Homepage URL: frontend origin
3. Callback URL: `https://<worker>.workers.dev/auth/github/callback` (atau localhost saat dev)
4. Copy Client ID & Secret ke wrangler secrets
5. Update `FRONTEND_ORIGIN` & `GITHUB_REDIRECT_URI` di `wrangler.toml` (atau vars production)

```bash
npx wrangler deploy
```

## Setup Frontend

1. Buka `frontend/app.js` / `index.html` — set `window.AIRIN_API` ke URL Worker:

```js
window.AIRIN_API = "https://airin-ai.<subdomain>.workers.dev";
```

Atau di browser console / localStorage:

```js
localStorage.setItem("airin_api", "https://airin-ai.xxx.workers.dev");
```

2. Deploy static folder `frontend/` ke:

   - **Cloudflare Pages**: `npx wrangler pages deploy frontend`
   - **Vercel**: `vercel frontend --yes`
   - **GitHub Pages**: push folder `frontend` ke branch `gh-pages`

3. Update CORS: set `FRONTEND_ORIGIN` di Worker ke origin frontend production.

## API Endpoints

| Method | Path | Deskripsi |
| --- | --- | --- |
| GET | `/health` | Health check |
| POST | `/api/chat` | Chat agent (JSON body) |
| GET | `/auth/github` | Mulai OAuth |
| GET | `/auth/github/callback` | OAuth callback |
| POST | `/api/r2/upload?key=...` | Upload binary ke R2 |
| GET | `/api/r2/list` | List objects |
| GET | `/api/r2/get/:key` | Download object |

### Body `/api/chat`

```json
{
  "message": "Halo AIRIN",
  "history": [{ "role": "user", "content": "..." }],
  "sessionId": "uuid",
  "imageBase64": "data:image/png;base64,...",
  "githubToken": "gho_..."
}
```

## Tools yang bisa dipanggil model

- `get_current_time`
- `web_search`
- `github_list_repos` / `github_get_file` / `github_get_tree` / `github_search_code` / `github_create_or_update_file`
- `r2_list_files` / `r2_read_file` / `r2_upload_text`
- `website_redesign`

## Catatan arsitektur

- Agent loop tradisional (multi-round tool calling) di `lib/agent.ts`.
- Embedding: `@cf/baai/bge-base-en-v1.5` → Vectorize index `airin-memory`.
- Token GitHub disimpan di `localStorage` frontend (untuk demo). Production: pertimbangkan httpOnly cookie + session KV.
- Website reader API bisa berubah; executor sudah punya fallback direct-fetch HTML.

## License

MIT — buat sesuka lo.