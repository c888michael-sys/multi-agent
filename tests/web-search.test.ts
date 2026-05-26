// Tests for the web_search tool — covers Brave-primary, DDG-fallback,
// the "no key + DDG fails → empty results" edge, and the model-facing
// formatted output. Real HTTP is mocked via the injected fetchImpl.

import { describe, it, expect } from "vitest";
import { WebSearchTool } from "../src/tools/web-search.js";

function fakeFetch(map: Record<string, { status?: number; body: unknown }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [pattern, response] of Object.entries(map)) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(response.body), {
          status: response.status ?? 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response("not mocked", { status: 404 });
  }) as typeof fetch;
}

describe("WebSearchTool — Brave primary path", () => {
  it("returns formatted hits from Brave when key is present", async () => {
    const t = new WebSearchTool({
      braveKey: "test-key",
      fetchImpl: fakeFetch({
        "api.search.brave.com": {
          body: {
            web: {
              results: [
                {
                  title: "Node.js LTS schedule",
                  url: "https://nodejs.org/en/about/previous-releases",
                  description: "Long-Term Support release lines and end dates.",
                },
                {
                  title: "Current LTS: Node 22",
                  url: "https://nodejs.org/en/blog/release/v22.0.0",
                  description: "Released April 2024; supported through April 2027.",
                },
              ],
            },
          },
        },
      }),
    });
    const out = await t.tool().execute({ query: "Node.js LTS version" });
    expect(out).toContain("1. Node.js LTS schedule");
    expect(out).toContain("https://nodejs.org/en/about/previous-releases");
    expect(out).toContain("2. Current LTS: Node 22");
  });

  it("strips HTML tags from titles/snippets so the model gets clean text", async () => {
    const t = new WebSearchTool({
      braveKey: "test-key",
      fetchImpl: fakeFetch({
        "api.search.brave.com": {
          body: {
            web: {
              results: [
                {
                  title: "Plain <b>title</b> with markup",
                  url: "https://x.example/",
                  description: "Snippet with <em>emphasis</em>.",
                },
              ],
            },
          },
        },
      }),
    });
    const out = await t.tool().execute({ query: "test" });
    expect(out).toContain("Plain title with markup");
    expect(out).toContain("Snippet with emphasis.");
    expect(out).not.toContain("<b>");
  });

  it("falls through to DDG when Brave returns non-OK", async () => {
    const t = new WebSearchTool({
      braveKey: "test-key",
      fetchImpl: fakeFetch({
        "api.search.brave.com": { status: 429, body: { error: "rate limit" } },
        "api.duckduckgo.com": {
          body: {
            AbstractText: "DuckDuckGo fallback answer.",
            AbstractURL: "https://duckduckgo.com/test",
            Heading: "DDG test",
            RelatedTopics: [],
          },
        },
      }),
    });
    const out = await t.tool().execute({ query: "test" });
    expect(out).toContain("DDG test");
    expect(out).toContain("DuckDuckGo fallback answer");
  });
});

describe("WebSearchTool — DuckDuckGo keyless path", () => {
  it("uses DDG when no Brave key is configured", async () => {
    const t = new WebSearchTool({
      fetchImpl: fakeFetch({
        "api.duckduckgo.com": {
          body: {
            AbstractText: "Rust is a systems programming language.",
            AbstractURL: "https://www.rust-lang.org/",
            Heading: "Rust",
            RelatedTopics: [
              { Text: "Ownership", FirstURL: "https://doc.rust-lang.org/book/ch04" },
            ],
          },
        },
      }),
    });
    const out = await t.tool().execute({ query: "rust language" });
    expect(out).toContain("Rust");
    expect(out).toContain("https://www.rust-lang.org/");
    expect(out).toContain("Ownership");
  });

  it("returns the friendly 'no results' string when DDG returns nothing", async () => {
    const t = new WebSearchTool({
      fetchImpl: fakeFetch({
        "api.duckduckgo.com": { body: { RelatedTopics: [] } },
      }),
    });
    const out = await t.tool().execute({ query: "x" });
    expect(out).toContain("(no results");
  });

  it("returns an ERROR string on empty query without calling the network", async () => {
    let called = false;
    const t = new WebSearchTool({
      fetchImpl: (async () => {
        called = true;
        return new Response("nope", { status: 500 });
      }) as typeof fetch,
    });
    const out = await t.tool().execute({ query: "   " });
    expect(out).toMatch(/empty query/i);
    expect(called).toBe(false);
  });
});

describe("WebSearchTool — tool declaration shape", () => {
  it("exposes a `web_search` tool with a `query` string parameter", () => {
    const decl = new WebSearchTool().tool();
    expect(decl.name).toBe("web_search");
    expect(decl.parameters.required).toContain("query");
    expect(decl.parameters.properties.query?.type).toBe("string");
  });
});
