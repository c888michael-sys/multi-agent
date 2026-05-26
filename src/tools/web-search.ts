import type { Tool } from "./types.js";

/**
 * Web search tool — primarily for the perception role when its native-grounding
 * primary (Gemini Flash with `useSearch:true`) is exhausted and the resolver
 * falls over to Gemma 3 (or any other model that lacks Google Search grounding).
 *
 * Backend selection (transparent to the model):
 *
 *   1. **Brave Search API** — requires `BRAVE_SEARCH_KEY`. Free tier:
 *      ~2000 queries/month, no payment. Returns clean structured results
 *      (title + url + description per hit). The preferred path.
 *
 *   2. **DuckDuckGo Instant Answer** — no key needed. Returns DDG's curated
 *      instant answer (definition / abstract / related topics) when one
 *      exists, plus a list of related-topic links. Limited coverage —
 *      ~30% of arbitrary queries have a useful answer — but it's the
 *      free, no-signup safety net.
 *
 * If neither backend is reachable, the tool returns a clear "(no results)"
 * error string back to the model rather than throwing; the model can then
 * decide to answer from training data alone with a caveat.
 *
 * Output shape (string returned to the model):
 *   Numbered list of up to N results, each formatted as:
 *     1. <title>
 *        <url>
 *        <snippet>
 */

export interface WebSearchOptions {
  /** Brave Search API key. If unset, Brave is skipped and we fall through to DDG. */
  braveKey?: string;
  /** Max results to return to the model. Default 5. */
  maxResults?: number;
  /** Override for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export class WebSearchTool {
  private readonly braveKey: string | undefined;
  private readonly maxResults: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts?: WebSearchOptions) {
    this.braveKey = opts?.braveKey ?? ((process.env.BRAVE_SEARCH_KEY ?? "").trim() || undefined);
    this.maxResults = opts?.maxResults ?? 5;
    this.fetchImpl = opts?.fetchImpl ?? fetch;
  }

  tool(): Tool {
    return {
      name: "web_search",
      description:
        "Search the live web for current information. Use this for facts that may have changed since your training data, recent news, current versions, specific URLs, or anything you'd want to verify against a real source. Returns up to 5 results (title, url, snippet).",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search query in plain language. Be specific. Good: 'Node.js LTS version November 2024'. Bad: 'node'.",
          },
        },
        required: ["query"],
      },
      execute: async (args) => {
        const query = String(args.query ?? "").trim();
        if (!query) return "ERROR: empty query";
        const hits = await this.search(query);
        return formatHits(hits, this.maxResults);
      },
    };
  }

  /** Public for tests / direct use. */
  async search(query: string): Promise<SearchHit[]> {
    // Try Brave first if we have a key — better quality on general queries.
    if (this.braveKey) {
      try {
        const hits = await this.brave(query);
        if (hits.length > 0) return hits;
      } catch {
        // Fall through to DDG on Brave failure (rate limited, network, etc.).
      }
    }
    // Keyless DDG fallback.
    try {
      return await this.duckduckgo(query);
    } catch {
      return [];
    }
  }

  private async brave(query: string): Promise<SearchHit[]> {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${this.maxResults}`;
    const res = await this.fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": this.braveKey!,
      },
    });
    if (!res.ok) {
      throw new Error(`Brave Search ${res.status}: ${await res.text().catch(() => "")}`);
    }
    const json = (await res.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    const results = json.web?.results ?? [];
    return results
      .slice(0, this.maxResults)
      .map((r) => ({
        title: stripHtml(r.title ?? ""),
        url: r.url ?? "",
        snippet: stripHtml(r.description ?? ""),
      }))
      .filter((h) => h.url);
  }

  private async duckduckgo(query: string): Promise<SearchHit[]> {
    // DuckDuckGo Instant Answer — JSON endpoint, no key needed, but ONLY
    // returns curated instant answers + related topics. Not a general web
    // search; treat as a low-quality safety net.
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await this.fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      throw new Error(`DuckDuckGo ${res.status}`);
    }
    const json = (await res.json()) as {
      AbstractText?: string;
      AbstractURL?: string;
      Heading?: string;
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
    };
    const hits: SearchHit[] = [];
    if (json.AbstractText && json.AbstractURL) {
      hits.push({
        title: json.Heading ?? json.AbstractURL,
        url: json.AbstractURL,
        snippet: json.AbstractText,
      });
    }
    for (const topic of json.RelatedTopics ?? []) {
      if (hits.length >= this.maxResults) break;
      if (topic.FirstURL && topic.Text) {
        hits.push({
          title: topic.Text.split(" - ")[0] ?? topic.Text,
          url: topic.FirstURL,
          snippet: topic.Text,
        });
      }
    }
    return hits;
  }
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}

function formatHits(hits: SearchHit[], cap: number): string {
  if (hits.length === 0) {
    return "(no results — try a different query, or answer from training data with a caveat about freshness)";
  }
  return hits
    .slice(0, cap)
    .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`)
    .join("\n\n");
}
