export interface EngineObserver {
  startSpinner(): void
  stopSpinner(): void
  beginAssistantText(): void
  streamToken(token: string): void
  streamReasoning?(token: string): void
  endAssistantText(): void
  toolStart(name: string, input: Record<string, unknown>): void
  toolResult(name: string, content: string, isError: boolean): void
  contextWarning(tokens: number, max: number, ratio: number): void
  compactStart(tokens: number): void
  compactDone(originalTokens: number, summaryTokens: number): void
  warn(message: string): void
  error(message: string): void
}
