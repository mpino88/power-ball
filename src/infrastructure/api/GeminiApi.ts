import { IGeminiApi } from "../../domain/interfaces/IGeminiApi.js";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

type GeminiModel = { name: string; supportedGenerationMethods?: string[] };

export class GeminiApi implements IGeminiApi {
  private cachedModel: string | null = null;
  
  private getApiKey(): string {
    const key = process.env.GEMINI_API_KEY?.trim() ?? "";
    if (!key) throw new Error("GEMINI_API_KEY no está configurada.");
    return key;
  }

  async listAvailableModels(): Promise<string[]> {
    const key = this.getApiKey();
    const res = await fetch(`${GEMINI_BASE}/models?key=${key}`);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`[${res.status}] ${body}`);
    }
    const data = await res.json() as { models?: GeminiModel[] };
    return (data.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => m.name.replace("models/", ""));
  }

  private async detectModel(): Promise<string> {
    if (this.cachedModel) return this.cachedModel;
    const all = await this.listAvailableModels();
    const preferred = all.find((m) => /flash/i.test(m)) ?? all.find((m) => /pro/i.test(m)) ?? all[0];
    if (!preferred) throw new Error("No hay modelos Gemini disponibles con esta API key.");
    this.cachedModel = preferred;
    console.log(`[GeminiApi] Modelo detectado: ${preferred}`);
    return preferred;
  }

  async generateContent(prompt: string): Promise<string> {
    const key = this.getApiKey();
    const model = await this.detectModel();
    const url = `${GEMINI_BASE}/models/${model}:generateContent?key=${key}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    });

    if (!res.ok) {
      this.cachedModel = null;
      const body = await res.text();
      throw new Error(`[${res.status} ${model}] ${body}`);
    }

    const data = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!raw.trim()) throw new Error("La API devolvió una respuesta vacía.");
    return raw;
  }
}
