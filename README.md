# AIRIN AI

Asisten AI serba bisa di atas **Cloudflare Workers AI** (multi-model) + frontend vanilla.

- **Smart mode**: `@cf/qwen/qwen3-30b-a3b-fp8` (general chat, explanations, search, analysis)
- **Coder mode**: `@cf/qwen/qwen2.5-coder-32b-instruct` (coding, debugging, errors)
- **Vision**: `@cf/cloudflare/clef-flash` (structured visual attributes; Qwen composes the response)

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
| Model (Smart) | `@cf/qwen/qwen3-30b-a3b-fp8` (general chat, explanations, search, analysis) |
| Model (Coder) | `@cf/qwen/qwen2.5-coder-32b-instruct` (coding, debugging, error fixing) |
| Model (vision) | `@cf/cloudflare/clef-flash` (structured visual attributes for Qwen) |
| Context | Sliding window + Vectorize RAG |
| Web search | DuckDuckGo (tanpa API key) |
| GitHub OAuth | `/auth/github` + tools baca/commit/push |
| R2 | Upload, list, read file |
| Website redesign | Call `website-reader-nine.vercel.app` + model redesign |
| Vision | Upload PNG/JPEG/WebP (maksimal 4 MiB per gambar; frontend otomatis mengecilkan; API mendukung hingga 4 gambar dengan total resolusi maksimal 1 MP per permintaan) → structured visual attributes → analysis / UI code |

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

Frontend memakai React + Vite dengan komponen Magic UI. Logika chat, OAuth, dan
penyimpanan percakapan tetap berada di `frontend/app.js`.

1. Install dependency dan jalankan frontend:

```bash
cd frontend
npm install
npm run dev
```

2. Untuk mengganti URL Worker, set `window.AIRIN_API` di `frontend/index.html`:

```js
window.AIRIN_API = "https://airin-ai.<subdomain>.workers.dev";
```

Atau di browser console / localStorage:

```js
localStorage.setItem("airin_api", "https://airin-ai.xxx.workers.dev");
```

3. Build untuk deployment. Vite menghasilkan situs statis di `frontend/dist/`:

```bash
npm run build
```

Deploy isi folder `frontend/dist/` ke:

   - **Cloudflare Pages**: `npx wrangler pages deploy frontend/dist`
   - **Vercel**: `vercel frontend/dist --yes`
   - **GitHub Pages**: publish folder `frontend/dist/` dari workflow deployment

4. Update CORS: set `FRONTEND_ORIGIN` di Worker ke origin frontend production.

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