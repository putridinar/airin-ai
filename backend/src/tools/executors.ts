/**
 * Tool executors — actual side-effect functions called by the agent loop
 */

const GH_API = "https://api.github.com";
const WEBSITE_READER = "https://website-reader-nine.vercel.app";

async function ghFetch(
  path: string,
  token: string,
  init: RequestInit = {}
): Promise<Response> {
  return fetch(`${GH_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "AIRIN-AI-Worker",
      ...(init.headers || {}),
    },
  });
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  env: Env,
  sessionId: string
): Promise<string> {
  try {
    switch (name) {
      case "get_current_time":
        return JSON.stringify({
          iso: new Date().toISOString(),
          timezone: "UTC",
          local_hint: "Server time in ISO 8601",
        });

      case "web_search":
        return await webSearch(
          String(args.query || ""),
          Number(args.max_results) || 5
        );

      case "github_list_repos":
        return await githubListRepos(String(args.github_token), String(args.type || "all"));

      case "github_get_file":
        return await githubGetFile(
          String(args.github_token),
          String(args.owner),
          String(args.repo),
          String(args.path),
          args.ref ? String(args.ref) : undefined
        );

      case "github_get_tree":
        return await githubGetTree(
          String(args.github_token),
          String(args.owner),
          String(args.repo),
          Boolean(args.recursive)
        );

      case "github_search_code":
        return await githubSearchCode(
          String(args.github_token),
          String(args.query)
        );

      case "github_create_or_update_file":
        return await githubCreateOrUpdateFile({
          token: String(args.github_token),
          owner: String(args.owner),
          repo: String(args.repo),
          path: String(args.path),
          content: String(args.content),
          message: String(args.message),
          branch: args.branch ? String(args.branch) : "main",
        });

      case "r2_list_files":
        return await r2List(env, String(args.prefix || ""), Number(args.limit) || 50);

      case "r2_read_file":
        return await r2Read(env, String(args.key));

      case "r2_upload_text":
        return await r2Upload(
          env,
          String(args.key),
          String(args.content),
          String(args.content_type || "text/plain")
        );

      case "website_redesign":
        return await websiteRedesign(String(args.url));

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Tool ${name} failed:`, msg);
    return JSON.stringify({ error: msg });
  }
}

// ─── Web Search (multi-source, no API key) ───

type SearchHit = { title: string; snippet: string; url: string };

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Decode DuckDuckGo redirect links → real URL */
function unwrapDdgUrl(href: string): string {
  try {
    if (href.includes("uddg=")) {
      const u = new URL(href, "https://duckduckgo.com");
      const real = u.searchParams.get("uddg");
      if (real) return decodeURIComponent(real);
    }
    if (href.startsWith("//")) return "https:" + href;
    return href;
  } catch {
    return href;
  }
}

function isLowQualityHit(h: SearchHit): boolean {
  const u = h.url.toLowerCase();
  const t = h.title.toLowerCase();
  // Tag / listing pages without substance
  if (/\/tag\//.test(u) && h.snippet.length < 40) return true;
  if (/peta-public|tag\/jakarta/.test(u) && h.snippet.length < 40) return true;
  if (!h.title || h.title.length < 8) return true;
  if (t === "jakarta timur" && h.snippet.length < 30) return true;
  return false;
}

function dedupeHits(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const h of hits) {
    const key = h.url.replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

async function searchDdgHtml(query: string, limit: number): Promise<SearchHit[]> {
  const res = await fetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
      },
    }
  );
  if (!res.ok) return [];
  const html = await res.text();
  const hits: SearchHit[] = [];

  // Parse per result block
  const blockRe =
    /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)>|class="result__snippet"[^>]*>([\s\S]*?)<)/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) && hits.length < limit * 2) {
    const url = unwrapDdgUrl(m[1]);
    const title = stripTags(m[2]);
    const snippet = stripTags(m[3] || m[4] || "");
    if (!url.startsWith("http")) continue;
    hits.push({ title, snippet, url });
  }

  // Fallback simpler link-only parse
  if (hits.length < 2) {
    const linkRe =
      /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = linkRe.exec(html)) && hits.length < limit * 2) {
      hits.push({
        url: unwrapDdgUrl(m[1]),
        title: stripTags(m[2]),
        snippet: "",
      });
    }
  }

  return hits;
}

async function searchDdgInstant(query: string): Promise<SearchHit[]> {
  const iaUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const iaRes = await fetch(iaUrl, {
    headers: { "User-Agent": "AIRIN-AI/1.0" },
  });
  if (!iaRes.ok) return [];
  const ia = (await iaRes.json()) as {
    AbstractText?: string;
    AbstractURL?: string;
    Heading?: string;
    RelatedTopics?: Array<{
      Text?: string;
      FirstURL?: string;
      Topics?: Array<{ Text?: string; FirstURL?: string }>;
    }>;
    Results?: Array<{ Text?: string; FirstURL?: string }>;
  };

  const hits: SearchHit[] = [];
  if (ia.AbstractText) {
    hits.push({
      title: ia.Heading || query,
      snippet: ia.AbstractText,
      url: ia.AbstractURL || "",
    });
  }
  const flatten = (
    topics: Array<{ Text?: string; FirstURL?: string; Topics?: unknown[] }>
  ) => {
    for (const t of topics) {
      if (t.Text && t.FirstURL) {
        hits.push({
          title: t.Text.slice(0, 100),
          snippet: t.Text,
          url: t.FirstURL,
        });
      }
      if (Array.isArray(t.Topics)) {
        flatten(t.Topics as typeof topics);
      }
    }
  };
  if (Array.isArray(ia.RelatedTopics)) flatten(ia.RelatedTopics);
  if (Array.isArray(ia.Results)) {
    for (const r of ia.Results) {
      if (r.Text && r.FirstURL) {
        hits.push({ title: r.Text.slice(0, 100), snippet: r.Text, url: r.FirstURL });
      }
    }
  }
  return hits;
}

/** Bing RSS — sering lebih bagus untuk berita lokal */
async function searchBingRss(query: string, limit: number): Promise<SearchHit[]> {
  try {
    const res = await fetch(
      `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&setlang=id`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; AIRIN-AI/1.0; +https://airin.ai)",
          Accept: "application/rss+xml, application/xml, text/xml, */*",
        },
      }
    );
    if (!res.ok) return [];
    const xml = await res.text();
    const hits: SearchHit[] = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/gi;
    let im: RegExpExecArray | null;
    while ((im = itemRe.exec(xml)) && hits.length < limit) {
      const block = im[1];
      const title = stripTags(
        (block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i) ||
          block.match(/<title>([\s\S]*?)<\/title>/i) || [, ""])[1]
      );
      const url = stripTags(
        (block.match(/<link>([\s\S]*?)<\/link>/i) || [, ""])[1]
      );
      const snippet = stripTags(
        (block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i) ||
          block.match(/<description>([\s\S]*?)<\/description>/i) || [, ""])[1]
      );
      if (title && url) hits.push({ title, snippet, url });
    }
    return hits;
  } catch {
    return [];
  }
}

async function webSearch(query: string, maxResults: number): Promise<string> {
  const limit = Math.min(Math.max(maxResults || 5, 3), 10);
  // Enrich query for Indonesian news-ish asks
  const q = query.trim();
  const newsLike =
    /berita|terkini|hari ini|update|info|kejadian|macet|cuaca|jakarta/i.test(q);
  const queries = newsLike
    ? [q, `${q} berita`, `${q} hari ini`]
    : [q];

  const pooled: SearchHit[] = [];
  const sources: string[] = [];

  // Parallel multi-source
  const jobs: Promise<void>[] = [];

  for (const qq of queries.slice(0, 2)) {
    jobs.push(
      searchDdgHtml(qq, limit).then((h) => {
        if (h.length) sources.push("ddg_html");
        pooled.push(...h);
      })
    );
    jobs.push(
      searchBingRss(qq, limit).then((h) => {
        if (h.length) sources.push("bing_rss");
        pooled.push(...h);
      })
    );
  }
  jobs.push(
    searchDdgInstant(q).then((h) => {
      if (h.length) sources.push("ddg_ia");
      pooled.push(...h);
    })
  );

  await Promise.allSettled(jobs);

  const cleaned = dedupeHits(pooled)
    .filter((h) => h.url && h.title)
    .filter((h) => !isLowQualityHit(h))
    .slice(0, limit);

  // Kalau filter terlalu agresif, longgarkan
  const finalHits =
    cleaned.length >= 2
      ? cleaned
      : dedupeHits(pooled)
          .filter((h) => h.url && h.title)
          .slice(0, limit);

  return JSON.stringify({
    query: q,
    results: finalHits.map((h) => ({
      title: h.title,
      snippet: h.snippet.slice(0, 280),
      url: h.url,
    })),
    result_count: finalHits.length,
    sources: [...new Set(sources)],
    fetched_at: new Date().toISOString(),
    instruction_for_model:
      "Ringkas temuan di atas jadi jawaban natural. Prioritaskan item yang punya snippet substantif. Sebutkan judul + 1 kalimat + link. Jangan hanya list homepage/tag page.",
  });
}

// ─── GitHub ───────────────────────────────────────────────

async function githubListRepos(token: string, type: string): Promise<string> {
  const res = await ghFetch(`/user/repos?per_page=30&type=${type}&sort=updated`, token);
  if (!res.ok) return JSON.stringify({ error: await res.text() });
  const repos = (await res.json()) as Array<{
    full_name: string;
    description: string | null;
    private: boolean;
    html_url: string;
    language: string | null;
    updated_at: string;
  }>;
  return JSON.stringify(
    repos.map((r) => ({
      full_name: r.full_name,
      description: r.description,
      private: r.private,
      url: r.html_url,
      language: r.language,
      updated_at: r.updated_at,
    }))
  );
}

async function githubGetFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref?: string
): Promise<string> {
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const res = await ghFetch(
    `/repos/${owner}/${repo}/contents/${path}${q}`,
    token
  );
  if (!res.ok) return JSON.stringify({ error: await res.text() });
  const data = (await res.json()) as {
    content?: string;
    encoding?: string;
    name?: string;
    size?: number;
    sha?: string;
  };
  if (data.encoding === "base64" && data.content) {
    const text = atob(data.content.replace(/\n/g, ""));
    return JSON.stringify({
      name: data.name,
      path,
      size: data.size,
      sha: data.sha,
      content: text.slice(0, 100_000), // safety cap
    });
  }
  return JSON.stringify(data);
}

async function githubGetTree(
  token: string,
  owner: string,
  repo: string,
  recursive: boolean
): Promise<string> {
  // Get default branch first
  const repoRes = await ghFetch(`/repos/${owner}/${repo}`, token);
  if (!repoRes.ok) return JSON.stringify({ error: await repoRes.text() });
  const repoData = (await repoRes.json()) as { default_branch: string };
  const branch = repoData.default_branch || "main";

  const treeRes = await ghFetch(
    `/repos/${owner}/${repo}/git/trees/${branch}?recursive=${recursive ? "1" : "0"}`,
    token
  );
  if (!treeRes.ok) return JSON.stringify({ error: await treeRes.text() });
  const tree = (await treeRes.json()) as {
    tree?: Array<{ path: string; type: string; size?: number }>;
  };
  const items = (tree.tree || [])
    .slice(0, 200)
    .map((t) => ({ path: t.path, type: t.type, size: t.size }));
  return JSON.stringify({ branch, items });
}

async function githubSearchCode(token: string, query: string): Promise<string> {
  const res = await ghFetch(
    `/search/code?q=${encodeURIComponent(query)}&per_page=10`,
    token
  );
  if (!res.ok) return JSON.stringify({ error: await res.text() });
  const data = (await res.json()) as {
    items?: Array<{
      name: string;
      path: string;
      html_url: string;
      repository: { full_name: string };
    }>;
  };
  return JSON.stringify(
    (data.items || []).map((i) => ({
      name: i.name,
      path: i.path,
      repo: i.repository.full_name,
      url: i.html_url,
    }))
  );
}

async function githubCreateOrUpdateFile(opts: {
  token: string;
  owner: string;
  repo: string;
  path: string;
  content: string;
  message: string;
  branch: string;
}): Promise<string> {
  // Check if file exists to get sha
  let sha: string | undefined;
  const getRes = await ghFetch(
    `/repos/${opts.owner}/${opts.repo}/contents/${opts.path}?ref=${opts.branch}`,
    opts.token
  );
  if (getRes.ok) {
    const existing = (await getRes.json()) as { sha?: string };
    sha = existing.sha;
  }

  const body: Record<string, unknown> = {
    message: opts.message,
    content: btoa(unescape(encodeURIComponent(opts.content))),
    branch: opts.branch,
  };
  if (sha) body.sha = sha;

  const res = await ghFetch(
    `/repos/${opts.owner}/${opts.repo}/contents/${opts.path}`,
    opts.token,
    { method: "PUT", body: JSON.stringify(body) }
  );
  if (!res.ok) return JSON.stringify({ error: await res.text() });
  const data = (await res.json()) as {
    content?: { html_url?: string; sha?: string };
    commit?: { html_url?: string };
  };
  return JSON.stringify({
    success: true,
    file_url: data.content?.html_url,
    commit_url: data.commit?.html_url,
    sha: data.content?.sha,
  });
}

// ─── R2 ───────────────────────────────────────────────────

async function r2List(env: Env, prefix: string, limit: number): Promise<string> {
  const listed = await env.R2_BUCKET.list({ prefix, limit });
  return JSON.stringify({
    objects: listed.objects.map((o) => ({
      key: o.key,
      size: o.size,
      uploaded: o.uploaded?.toISOString?.() ?? o.uploaded,
    })),
    truncated: listed.truncated,
  });
}

async function r2Read(env: Env, key: string): Promise<string> {
  const obj = await env.R2_BUCKET.get(key);
  if (!obj) return JSON.stringify({ error: "File not found" });
  const text = await obj.text();
  return JSON.stringify({
    key,
    size: obj.size,
    content_type: obj.httpMetadata?.contentType,
    content: text.slice(0, 200_000),
  });
}

async function r2Upload(
  env: Env,
  key: string,
  content: string,
  contentType: string
): Promise<string> {
  await env.R2_BUCKET.put(key, content, {
    httpMetadata: { contentType },
  });
  return JSON.stringify({ success: true, key, size: content.length });
}

// ─── Website Redesign helper ──────────────────────────────

async function websiteRedesign(url: string): Promise<string> {
  // Call external website reader API
  // Expected endpoints vary; try common patterns
  const endpoints = [
    `${WEBSITE_READER}/api/markdown?url=${encodeURIComponent(url)}`,
    `${WEBSITE_READER}/api/scrape?url=${encodeURIComponent(url)}`,
    `${WEBSITE_READER}/?url=${encodeURIComponent(url)}`,
  ];

  for (const ep of endpoints) {
    try {
      const res = await fetch(ep, {
        headers: { Accept: "application/json, text/plain, */*" },
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) continue;
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("json")) {
        const data = await res.json();
        return JSON.stringify({ url, source: ep, data });
      }
      const text = await res.text();
      return JSON.stringify({
        url,
        source: ep,
        markdown_or_html: text.slice(0, 150_000),
      });
    } catch {
      continue;
    }
  }

  // Last resort: fetch page directly (limited)
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "AIRIN-AI-Bot/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    const html = await res.text();
    return JSON.stringify({
      url,
      source: "direct-fetch",
      html_snippet: html.slice(0, 80_000),
      note: "website-rrader API unreachable; raw HTML snippet returned",
    });
  } catch (e) {
    return JSON.stringify({
      error: "Failed to fetch website",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}
