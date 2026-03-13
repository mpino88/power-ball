export interface IGeminiApi {
  listAvailableModels(): Promise<string[]>;
  generateContent(prompt: string): Promise<string>;
}
