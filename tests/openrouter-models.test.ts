import { describe, expect, it } from "vitest";
import {
  filterFreeOpenRouterTextModels,
  sortOpenRouterReasoningOptions,
} from "../src/models/openrouter-models.js";

describe("OpenRouter free model discovery", () => {
  it("keeps free text models, including strong general models without reasoning tags", () => {
    const models = filterFreeOpenRouterTextModels([
      {
        id: "qwen/qwen3-next-80b-a3b-instruct:free",
        name: "Qwen3 Next 80B",
        context_length: 262144,
        created: 1,
        architecture: {
          input_modalities: ["text"],
          output_modalities: ["text"],
        },
        pricing: { prompt: "0", completion: "0", request: "0" },
        supported_parameters: ["temperature", "reasoning"],
      },
      {
        id: "general/strong-chat:free",
        name: "Strong General Chat",
        context_length: 131072,
        created: 2,
        architecture: {
          input_modalities: ["text"],
          output_modalities: ["text"],
        },
        pricing: { prompt: "0", completion: "0", request: "0" },
        supported_parameters: ["temperature"],
      },
      {
        id: "sound/transcriber:free",
        name: "Sound Transcriber",
        context_length: 8192,
        created: 3,
        architecture: {
          input_modalities: ["audio"],
          output_modalities: ["text"],
        },
        pricing: { prompt: "0", completion: "0", request: "0" },
        supported_parameters: [],
      },
      {
        id: "image/maker:free",
        name: "Image Maker",
        context_length: 8192,
        created: 4,
        architecture: {
          input_modalities: ["text"],
          output_modalities: ["image"],
        },
        pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
        supported_parameters: [],
      },
      {
        id: "paid/chat",
        name: "Paid Chat",
        context_length: 8192,
        created: 5,
        architecture: {
          input_modalities: ["text"],
          output_modalities: ["text"],
        },
        pricing: { prompt: "0.01", completion: "0", request: "0" },
        supported_parameters: [],
      },
    ]);

    expect(models.map((m) => m.id)).toEqual([
      "qwen/qwen3-next-80b-a3b-instruct:free",
      "general/strong-chat:free",
    ]);
    expect(models[0]!.reasoningCapable).toBe(true);
    expect(models[1]!.reasoningCapable).toBe(false);
  });

  it("sorts reasoning-capable models first, then larger context", () => {
    const sorted = sortOpenRouterReasoningOptions([
      {
        id: "general/huge:free",
        name: "General Huge",
        contextLength: 262144,
        created: 1,
        reasoningCapable: false,
      },
      {
        id: "reasoning/small:free",
        name: "Reasoning Small",
        contextLength: 32768,
        created: 1,
        reasoningCapable: true,
      },
    ]);

    expect(sorted.map((m) => m.id)).toEqual(["reasoning/small:free", "general/huge:free"]);
  });

  it("does not assume missing pricing means free unless the id is explicitly free", () => {
    const models = filterFreeOpenRouterTextModels([
      {
        id: "provider/unknown-price",
        name: "Unknown Price",
        context_length: 32768,
        created: 1,
        architecture: {
          input_modalities: ["text"],
          output_modalities: ["text"],
        },
        supported_parameters: ["reasoning"],
      },
      {
        id: "provider/free-by-id:free",
        name: "Free By Id",
        context_length: 32768,
        created: 2,
        architecture: {
          input_modalities: ["text"],
          output_modalities: ["text"],
        },
        supported_parameters: ["reasoning"],
      },
    ]);

    expect(models.map((m) => m.id)).toEqual(["provider/free-by-id:free"]);
  });
});
