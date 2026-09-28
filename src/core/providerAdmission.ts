export interface ModelGatewayPolicy {
  maxConcurrency: number
  maxQueue: number
  requestsPerMinute: number
  tokensPerMinute: number
  rateWindowMs: number
  maxAttempts: number
  deadlineMs: number
  baseDelayMs: number
  maxDelayMs: number
  circuitFailureThreshold: number
  circuitCooldownMs: number
  maxRunTokens: number
  maxHostTokens: number
}

export const DEFAULT_MODEL_GATEWAY_POLICY: Readonly<ModelGatewayPolicy> = Object.freeze({
  maxConcurrency: 4, maxQueue: 64, requestsPerMinute: 600, tokensPerMinute: 2_000_000,
  rateWindowMs: 60_000, maxAttempts: 3, deadlineMs: 120_000, baseDelayMs: 250, maxDelayMs: 5000,
  circuitFailureThreshold: 5, circuitCooldownMs: 30_000, maxRunTokens: 1_000_000, maxHostTokens: 100_000_000,
})

export function modelGatewayPolicy(overrides: Partial<ModelGatewayPolicy> = {}): ModelGatewayPolicy {
  const policy = { ...DEFAULT_MODEL_GATEWAY_POLICY, ...overrides }
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Model gateway ${name} must be a positive safe integer`)
  }
  if (policy.maxAttempts > 10 || policy.maxConcurrency > 1024 || policy.maxQueue > 10_000 || policy.deadlineMs > 3_600_000 || policy.rateWindowMs > 3_600_000 || policy.circuitCooldownMs > 3_600_000) throw new Error('Model gateway policy exceeds supported limits')
  if (policy.baseDelayMs > policy.maxDelayMs) throw new Error('Model gateway baseDelayMs must not exceed maxDelayMs')
  return policy
}

export interface UsageSettlement {
  kind: 'actual' | 'estimated' | 'unknown'
  inputTokens?: number
  outputTokens?: number
}

export interface ProviderReservation {
  settle(usage: UsageSettlement): void
}

interface RequestRecord { at: number; tokens: number }
interface RunBudget { spent: number; reserved: number }
interface Waiter {
  tokens: number
  run: string
  signal: AbortSignal
  deadline: number
  resolve: (value: ProviderReservation) => void
  reject: (error: Error) => void
  abort: () => void
}

let hostSpent = 0
let hostReserved = 0
const providers = new Map<string, ProviderAdmission>()
const runBudgets = new Map<string, RunBudget>()

export function providerAdmission(key: string, policy: ModelGatewayPolicy): ProviderAdmission {
  let admission = providers.get(key)
  if (!admission) {
    if (providers.size >= 256) throw new Error('Provider admission capacity reached; restart the idle host or reduce provider identities')
    admission = new ProviderAdmission(policy)
    providers.set(key, admission)
  } else admission.tightenPolicy(policy)
  return admission
}

export function providerAdmissionHealth() {
  return [...providers].map(([providerId, admission]) => ({ providerId, ...admission.snapshot() }))
}

export class ProviderAdmission {
  private active = 0
  private queue: Waiter[] = []
  private requests: RequestRecord[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private failures = 0
  private circuitUntil = 0
  private probing = false
  private actualTokens = 0
  private estimatedTokens = 0
  private unknownReservedTokens = 0

  constructor(private policy: ModelGatewayPolicy) {}

  tightenPolicy(policy: ModelGatewayPolicy): void {
    this.policy = {
      ...this.policy,
      maxConcurrency: Math.min(this.policy.maxConcurrency, policy.maxConcurrency),
      maxQueue: Math.min(this.policy.maxQueue, policy.maxQueue),
      requestsPerMinute: Math.min(this.policy.requestsPerMinute, policy.requestsPerMinute),
      tokensPerMinute: Math.min(this.policy.tokensPerMinute, policy.tokensPerMinute),
      rateWindowMs: Math.max(this.policy.rateWindowMs, policy.rateWindowMs),
      maxRunTokens: Math.min(this.policy.maxRunTokens, policy.maxRunTokens),
      maxHostTokens: Math.min(this.policy.maxHostTokens, policy.maxHostTokens),
      circuitFailureThreshold: Math.min(this.policy.circuitFailureThreshold, policy.circuitFailureThreshold),
      circuitCooldownMs: Math.max(this.policy.circuitCooldownMs, policy.circuitCooldownMs),
    }
  }

  snapshot() {
    return { active: this.active, queued: this.queue.length, failures: this.failures, circuitUntil: this.circuitUntil, actualTokens: this.actualTokens, estimatedTokens: this.estimatedTokens, unknownReservedTokens: this.unknownReservedTokens, hostSpent, hostReserved }
  }

  success(): void {
    this.failures = 0
    this.circuitUntil = 0
    this.probing = false
    this.drain()
  }

  failure(): void {
    this.failures++
    if (this.probing || this.failures >= this.policy.circuitFailureThreshold) this.circuitUntil = Date.now() + this.policy.circuitCooldownMs
    this.probing = false
    this.drain()
  }

  acquire(tokens: number, run: string, signal: AbortSignal, deadline: number): Promise<ProviderReservation> {
    signal.throwIfAborted()
    if (!Number.isSafeInteger(tokens) || tokens < 0 || tokens > this.policy.tokensPerMinute) return Promise.reject(new Error('Request exceeds provider token admission budget'))
    if (this.queue.length >= this.policy.maxQueue) return Promise.reject(new Error('Provider request queue is full'))
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        tokens, run, signal, deadline, resolve, reject,
        abort: () => {
          this.queue = this.queue.filter(entry => entry !== waiter)
          signal.removeEventListener('abort', waiter.abort)
          reject(signal.reason instanceof Error ? signal.reason : new Error('Provider request cancelled while queued'))
          this.drain()
        },
      }
      this.queue.push(waiter)
      signal.addEventListener('abort', waiter.abort, { once: true })
      this.drain()
    })
  }

  private rejectFirst(error: Error): void {
    const waiter = this.queue.shift()!
    waiter.signal.removeEventListener('abort', waiter.abort)
    waiter.reject(error)
  }

  private drain(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    const now = Date.now()
    this.requests = this.requests.filter(request => request.at + this.policy.rateWindowMs > now)
    while (this.queue.length) {
      const waiter = this.queue[0]
      if (waiter.signal.aborted || waiter.deadline <= now) { this.rejectFirst(new Error('Provider request deadline expired while queued')); continue }
      if (this.circuitUntil > now) { this.rejectFirst(new Error('Provider circuit is open; retry after the cooldown')); continue }
      if (this.active >= this.policy.maxConcurrency || this.probing) return
      const budget = runBudgets.get(waiter.run) ?? { spent: 0, reserved: 0 }
      if ((!runBudgets.has(waiter.run) && runBudgets.size >= 4096) || budget.spent + budget.reserved + waiter.tokens > this.policy.maxRunTokens || hostSpent + hostReserved + waiter.tokens > this.policy.maxHostTokens) {
        this.rejectFirst(new Error('Model token budget exhausted before request'))
        continue
      }
      const rateTokens = this.requests.reduce((sum, request) => sum + request.tokens, 0)
      if (this.requests.length >= this.policy.requestsPerMinute || rateTokens + waiter.tokens > this.policy.tokensPerMinute) {
        const wake = Math.min(this.requests[0].at + this.policy.rateWindowMs, ...this.queue.map(entry => entry.deadline))
        this.timer = setTimeout(() => { this.timer = undefined; this.drain() }, Math.max(1, wake - now))
        return
      }
      this.queue.shift()
      waiter.signal.removeEventListener('abort', waiter.abort)
      this.active++
      const isProbe = this.circuitUntil !== 0
      if (isProbe) this.probing = true
      budget.reserved += waiter.tokens
      runBudgets.set(waiter.run, budget)
      hostReserved += waiter.tokens
      const record = { at: now, tokens: waiter.tokens }
      this.requests.push(record)
      let settled = false
      waiter.resolve({
        settle: usage => {
          if (settled) return
          settled = true
          const known = usage.kind !== 'unknown' && Number.isSafeInteger(usage.inputTokens) && usage.inputTokens! >= 0 && Number.isSafeInteger(usage.outputTokens) && usage.outputTokens! >= 0
          const charged = known ? usage.inputTokens! + usage.outputTokens! : waiter.tokens
          if (known && usage.kind === 'actual') this.actualTokens += charged
          else if (known) this.estimatedTokens += charged
          else this.unknownReservedTokens += charged
          budget.reserved -= waiter.tokens
          budget.spent += charged
          hostReserved -= waiter.tokens
          hostSpent += charged
          record.tokens = charged
          this.active--
          if (isProbe) this.probing = false
          this.drain()
        },
      })
    }
  }
}
