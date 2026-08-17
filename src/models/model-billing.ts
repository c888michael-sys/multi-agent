import type { OverrideProviderName } from "./reasoning-model-overrides.js";

export type BillingClass = "local" | "free" | "free-tier" | "trial-credit" | "paid" | "unknown";

export interface ModelBilling {
  class: BillingClass;
  publicEligible: boolean;
  evidenceSource: string;
  verifiedAt: string;
}

/**
 * Conservative access classification. "Unknown" deliberately fails closed
 * for public users; catalogue visibility alone is not evidence that a model is
 * free. This metadata describes access policy, not a provider billing promise.
 */
export function classifyModelBilling(
  provider: OverrideProviderName,
  modelId: string,
  verifiedAt = new Date().toISOString(),
): ModelBilling {
  if (provider === "ollama") {
    return { class: "local", publicEligible: true, evidenceSource: "host-local Ollama", verifiedAt };
  }
  if (provider === "openrouter" && modelId.endsWith(":free")) {
    return { class: "free", publicEligible: true, evidenceSource: "https://openrouter.ai/api/v1/models (zero-priced text catalogue)", verifiedAt };
  }
  if (provider === "groq" && /^(groq\/compound(?:-mini)?|llama-3\.(?:1-8b-instant|3-70b-versatile)|openai\/gpt-oss-(?:20b|120b)|openai\/gpt-oss-safeguard-20b|qwen\/qwen3\.6-27b|meta-llama\/llama-prompt-guard-2-(?:22m|86m)|whisper-large-v3(?:-turbo)?)$/i.test(modelId)) {
    return { class: "free-tier", publicEligible: true, evidenceSource: "https://console.groq.com/docs/rate-limits (Free Plan Limits)", verifiedAt };
  }
  if (provider === "gemini" && (/^gemini-.*-flash/i.test(modelId) || /^gemma-/i.test(modelId))) {
    return { class: "free-tier", publicEligible: true, evidenceSource: "https://ai.google.dev/gemini-api/docs/pricing (Free Tier)", verifiedAt };
  }
  if (provider === "cerebras") {
    return { class: "trial-credit", publicEligible: false, evidenceSource: "provider trial/developer credits", verifiedAt };
  }
  if (provider === "nvidia") {
    return { class: "free-tier", publicEligible: false, evidenceSource: "NVIDIA developer catalogue; public redistribution not assumed", verifiedAt };
  }
  return { class: "unknown", publicEligible: false, evidenceSource: "pricing not verified", verifiedAt };
}
