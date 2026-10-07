import type OpenAI from 'openai'
import { APIConnectionError } from 'openai'
import { createHash, randomUUID } from 'node:crypto'
import { clampMaxOutputTokens, estimateTokens, estimateToolDefinitionTokens } from './compact.js'
import type { EngineConfig, OpenAIMessage } from './types.js'
import type { RunContext } from './runContext.js'
import { runOperation } from './runContext.js'
import { modelGatewayPolicy, providerAdmission } from './providerAdmission.js'
import { UsageLedger } from './usageLedger.js'
import { gatewayModelRequest, nativeModelAdapter, resolveModelRuntime, sendNativeModelRequest, validateGatewayModelRequest } from './modelRuntime.js'
import type { NormalizedUsage } from './model/types.js'
import { usagePricing } from './modelPricing.js'
import { AdapterError } from './model/common.js'

const anonymousClients = new WeakMap<object, string>()

function providerKey(client: OpenAI, config: EngineConfig): string {
  if (typeof client.baseURL === 'string') return createHash('sha256').update(client.baseURL.replace(/\/$/, '')).update('\0').update(config.apiKey).digest('hex')
  let key = anonymousClients.get(client)
  if (!key) { key = randomUUID(); anonymousClients.set(client, key) }
  return key
}

function usageOf(value: unknown, native = false): NormalizedUsage | null {
  if (!value || typeof value !== 'object') return null
  if (native && 'normalizedUsage' in value && value.normalizedUsage) return value.normalizedUsage as NormalizedUsage
  const usage = (value as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown }; completion_tokens_details?: { reasoning_tokens?: unknown } } }).usage
  if (!usage || !Number.isSafeInteger(usage.prompt_tokens) || Number(usage.prompt_tokens) < 0 || !Number.isSafeInteger(usage.completion_tokens) || Number(usage.completion_tokens) < 0) return null
  const cached = usage.prompt_tokens_details?.cached_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return { kind: 'actual', inputTokens: Number(usage.prompt_tokens), outputTokens: Number(usage.completion_tokens),
    ...(Number.isSafeInteger(cached) && Number(cached) >= 0 && Number(cached) <= Number(usage.prompt_tokens) ? { cachedInputTokens: Number(cached) } : {}),
    ...(Number.isSafeInteger(reasoning) && Number(reasoning) >= 0 && Number(reasoning) <= Number(usage.completion_tokens) ? { reasoningTokens: Number(reasoning) } : {}),
  }
}

function retryable(error: unknown): boolean {
  const value = error as { status?: number; name?: string }
  return (error as { retryable?: boolean }).retryable === true || value.status === 429 || value.status === 408 || (value.status !== undefined && value.status >= 500 && value.status <= 599) || error instanceof APIConnectionError || value.name === 'APIConnectionError' || value.name === 'APIConnectionTimeoutError'
}

function retryAfter(error: unknown): number | null {
  const headers = (error as { headers?: Record<string, string> | Headers }).headers
  if (!headers) return null
  const value = typeof (headers as Headers).get === 'function' ? (headers as Headers).get('retry-after') : (headers as Record<string, string>)['retry-after']
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const instant = Date.parse(value)
  return Number.isFinite(instant) ? Math.max(0, instant - Date.now()) : null
}

function waitForRetry(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(signal.reason instanceof Error ? signal.reason : new Error('Model request cancelled')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, delay)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

function iterable(value: unknown): value is AsyncIterable<OpenAI.Chat.ChatCompletionChunk> {
  return !!value && typeof value === 'object' && Symbol.asyncIterator in value
}

export function createModelGateway(client: OpenAI, config: EngineConfig, currentRun: () => RunContext | null): OpenAI {
  const original = client.chat.completions.create.bind(client.chat.completions)
  const policy = modelGatewayPolicy(config.modelGateway)
  const admission = providerAdmission(providerKey(client, config), policy)
  const standaloneRun = randomUUID()
  const ledger = config.usageLedger ?? new UsageLedger({ pricing: model => config.modelSettings && Object.hasOwn(config.modelSettings, model) ? config.modelSettings[model].pricing ?? usagePricing(model) : usagePricing(model) })
  const create = (async (params: OpenAI.Chat.ChatCompletionCreateParams, options?: OpenAI.RequestOptions) => {
    const run = currentRun()
    const parentSignal = options?.signal ?? run?.controller.signal
    parentSignal?.throwIfAborted()
    const model = params.model
    const runtime = resolveModelRuntime(config, model)
    const window = runtime.options.capabilities.contextWindow
    const maxTokens = clampMaxOutputTokens(params.max_tokens, window)
    const request = gatewayModelRequest(config, params, maxTokens)
    if (runtime.protocol !== 'chat-completions' && config.temperature === undefined) delete request.temperature
    const adapter = nativeModelAdapter(runtime.protocol, { ...runtime.options, ...(runtime.protocol === 'chat-completions' ? { client: {
      async create(body: Record<string, unknown>, transport: { signal: AbortSignal }) {
        let response: OpenAI.Chat.ChatCompletion | AsyncIterable<OpenAI.Chat.ChatCompletionChunk>
        try {
          response = await original({ ...params, ...body, stream: params.stream === true, stream_options: params.stream === true ? params.stream_options : undefined } as OpenAI.Chat.ChatCompletionCreateParams, { ...options, timeout: Math.max(1, deadline - Date.now()), signal: transport.signal, maxRetries: 0 })
        } catch (error) {
          throw new AdapterError('chat_transport_error', error instanceof Error ? error.message : 'Chat transport failed', retryable(error), retryAfter(error) ?? undefined)
        }
        if (iterable(response)) return response
        if (!response || !Array.isArray(response.choices)) throw new AdapterError('invalid_stream', 'Invalid Chat completion')
        return (async function* () {
          yield await Promise.resolve({ choices: response.choices.map(choice => ({ index: choice.index ?? 0, delta: { ...choice.message, ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls.map((call, index) => ({ ...call, index })) } : {}) }, finish_reason: choice.finish_reason })), usage: response.usage })
        })()
      },
    } } : {}) })
    validateGatewayModelRequest(request, runtime.protocol, runtime.options, adapter)
    const messages = params.messages.map(message => {
      const wire = { ...message } as OpenAIMessage
      delete wire.source
      delete wire.providerState
      return wire
    })
    const estimated = estimateTokens(messages) + estimateToolDefinitionTokens(params.tools)
    if (estimated + maxTokens > window) throw new Error(`Context budget exceeded before request: estimated ${estimated} input + ${maxTokens} reserved output > ${window}`)
    const controller = new AbortController()
    const signal = controller.signal
    const onParentAbort = () => controller.abort(parentSignal?.reason)
    parentSignal?.addEventListener('abort', onParentAbort, { once: true })
    const duration = Math.min(policy.deadlineMs, typeof options?.timeout === 'number' && options.timeout > 0 ? options.timeout : policy.deadlineMs)
    const deadline = Date.now() + duration
    const timer = setTimeout(() => controller.abort(new Error('Model request deadline exceeded')), duration)
    const cleanup = () => { clearTimeout(timer); parentSignal?.removeEventListener('abort', onParentAbort) }
    const emit = (phase: string, extra: Record<string, unknown> = {}) => {
      config.eventLog?.append('module_flag', 'model_request', { run_id: run?.runId, parent_run_id: run?.parentRunId, model, phase, input_tokens_estimated: estimated, output_reserved: maxTokens, ...admission.snapshot(), ...extra })
    }
    try {
      for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
        signal.throwIfAborted()
        const reservation = await admission.acquire(estimated + maxTokens, run?.familyId ?? config.runFamilyId ?? standaloneRun, signal, deadline)
        const requestId = randomUUID()
        const startedAt = Date.now()
        let settled = false
        let settlementError: Error | undefined
        const identity = { requestId, runId: run?.runId ?? standaloneRun, familyId: run?.familyId ?? config.runFamilyId ?? standaloneRun, model, ownerId: config.usageOwnerId }
        const settle = (usage: NormalizedUsage, phase: string) => {
          if (settled) return
          settled = true
          reservation.settle(usage)
          try {
            ledger.recordUsage({ ...usage, ...identity, durationMs: Date.now() - startedAt })
            emit(phase, { attempt, usage: usage.kind, input_tokens: usage.inputTokens, output_tokens: usage.outputTokens })
          } catch (error) { settlementError = new Error('Model usage settlement failed; preserve pending usage for recovery', { cause: error }) }
        }
        try {
          ledger.beginUsage({ ...identity, kind: 'unknown' })
          emit('started', { attempt, usage: 'unknown' })
          const send = () => sendNativeModelRequest(adapter, request, params.stream === true, signal)
          const response = await (run ? runOperation(run, 'model:' + model, send, duration, config.cancellationGraceMs ?? 2000) : send())
          if (iterable(response)) {
            let usage: NormalizedUsage | null = null
            let bytes = 0
            let finished = false
            const onAbort = () => {
              if (finished) return
              finished = true
              settle(usage ?? { kind: 'unknown' }, 'stream_aborted')
              cleanup()
            }
            signal.addEventListener('abort', onAbort, { once: true })
            if (signal.aborted) onAbort()
            return {
              controller,
              async *[Symbol.asyncIterator]() {
                let completed = false
                try {
                  signal.throwIfAborted()
                  for await (const chunk of response) {
                    signal.throwIfAborted()
                    usage = usageOf(chunk, Boolean(adapter)) ?? usage
                    bytes += Buffer.byteLength(JSON.stringify(chunk.choices ?? []), 'utf8')
                    yield chunk
                  }
                  completed = true
                  admission.success()
                  settle(usage ?? { kind: 'estimated', inputTokens: estimated, outputTokens: Math.ceil(bytes / 4) }, 'completed')
                  if (settlementError) throw settlementError
                } catch (error) {
                  if (!signal.aborted) admission.failure()
                  settle(usage ?? { kind: 'unknown' }, 'stream_failed')
                  throw settlementError ?? error
                } finally {
                  finished = true
                  signal.removeEventListener('abort', onAbort)
                  if (!completed) { controller.abort(new Error('Model stream consumer stopped')); settle(usage ?? { kind: 'unknown' }, 'stream_abandoned') }
                  cleanup()
                }
              },
            }
          }
          admission.success()
          const completion = response
          const output = JSON.stringify(completion.choices ?? [])
          settle(usageOf(response, Boolean(adapter)) ?? { kind: 'estimated', inputTokens: estimated, outputTokens: Math.ceil(Buffer.byteLength(output, 'utf8') / 4) }, 'completed')
          if (settlementError) throw settlementError
          cleanup()
          return response
        } catch (error) {
          if (signal.aborted) { settle(usageOf(error, Boolean(adapter)) ?? { kind: 'unknown' }, 'request_aborted'); throw settlementError ?? (signal.reason instanceof Error ? signal.reason : error) }
          const retry = retryable(error)
          if (retry) admission.failure()
          settle(usageOf(error, Boolean(adapter)) ?? { kind: 'unknown' }, 'request_failed')
          if (settlementError) throw settlementError
          if (!retry || attempt === policy.maxAttempts) throw error
          const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** (attempt - 1))) * (0.5 + Math.random() * 0.5)
          const delay = retryAfter(error) ?? backoff
          if (Date.now() + delay >= deadline) throw new Error('Model retry would exceed request deadline', { cause: error })
          emit('retry_wait', { attempt, delay_ms: delay, usage: 'unknown' })
          await waitForRetry(delay, signal)
        }
      }
      throw new Error('Model request attempts exhausted')
    } catch (error) { cleanup(); throw error }
  }) as typeof client.chat.completions.create
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'chat') return { ...target.chat, completions: { ...target.chat.completions, create } }
      const value: unknown = Reflect.get(target, property, receiver)
      return value
    },
  })
}
