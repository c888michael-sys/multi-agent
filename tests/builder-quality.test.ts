import { describe, expect, it } from "vitest";
import {
  detectBuilderQualityProfile,
  evaluateCreativeWebQuality,
  parseInferredBuildBrief,
} from "../src/web/builder-quality.js";

const brief = parseInferredBuildBrief({
  concept: "An interactive digital studio portfolio built around crafted experiments.",
  audience: "Prospective design and engineering clients",
  visualDirection: "Editorial typography, warm dark colour, precise grids, and restrained motion.",
  sections: "Navigation; Hero and positioning; Selected work; Process; Studio notes; Contact",
  interactions: "Filterable project gallery with animated focus states",
  successCriteria: "Feels distinctive; Works on mobile; Uses accessible semantics; Contains finished copy",
}).brief!;

const html = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Northstar Studio</title></head><body>
<header><nav aria-label="Primary">Studio Work Process Notes Contact</nav></header><main>
<section><h1>Interfaces with a point of view</h1><p>${"We turn complex ideas into useful, memorable digital experiences. ".repeat(12)}</p></section>
<section><h2>Selected work</h2><article><img alt="Project interface preview"><p>${"A detailed case study grounded in outcomes and craft. ".repeat(10)}</p></article></section>
<section><h2>Capabilities</h2><p>${"Strategy, systems, product design, and careful engineering. ".repeat(8)}</p></section>
<section><h2>Process</h2><p>${"Discover, frame, prototype, validate, and refine with the team. ".repeat(8)}</p></section>
<section><h2>Studio notes</h2><p>${"Practical observations from building ambitious digital products. ".repeat(8)}</p></section>
</main><footer><a href="#contact">Start a project</a></footer></body></html>`;
const css = `:root{color:#eee;background:#15120f;font-family:system-ui}body{margin:0}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:clamp(1rem,3vw,3rem)}section{padding:clamp(3rem,8vw,8rem);border-bottom:1px solid #555}a{color:#f5b971;transition:transform .2s}:focus-visible{outline:3px solid #f5b971}@media(max-width:700px){.grid{grid-template-columns:1fr}nav{display:flex;gap:1rem}}${".card{display:grid;padding:1rem;margin:1rem;border:1px solid #555;background:#211;color:#eee;transition:transform .2s}".repeat(16)}`;
const js = `const cards=[...document.querySelectorAll('.card')];document.querySelector('nav').addEventListener('click',event=>{document.body.classList.toggle('nav-open');});${"cards.forEach(card=>card.dataset.ready='true');".repeat(8)}`;

describe("Builder creative quality", () => {
  it("detects open-ended creative freedom but respects explicit simplicity", () => {
    expect(detectBuilderQualityProfile("build a website of your choice to showcase your skill", true)).toBe("creative-web");
    expect(detectBuilderQualityProfile("build a simple single-file website", true)).toBeUndefined();
  });

  it("rejects a skeletal result and reports actionable checks", () => {
    const review = evaluateCreativeWebQuality(brief, [{ path: "index.html", content: "<h1>Hello</h1>" }]);
    expect(review.passed).toBe(false);
    expect(review.checks.find((check) => check.id === "substance")?.passed).toBe(false);
  });

  it("passes a substantial responsive, accessible and interactive result", () => {
    const review = evaluateCreativeWebQuality(brief, [
      { path: "index.html", content: html },
      { path: "style.css", content: css },
      { path: "script.js", content: js },
    ]);
    expect(review.passed, review.checks.filter((check) => !check.passed).map((check) => check.id).join(", ")).toBe(true);
  });
});
