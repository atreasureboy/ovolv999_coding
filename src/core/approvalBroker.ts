import { createHash } from 'node:crypto'

export type ApprovalScope = 'once' | 'session' | 'rule'
export type ApprovalStatus = 'decided' | 'needs_input' | 'cancelled' | 'stale'

export interface ApprovalRequest {
  requestId: string
  runId: string
  operationId: string
  inputDigest: string
  policyDigest?: string
  cwd: string
  tool: string
  preview: string
  signal: AbortSignal
  riskLevel?: 'safe' | 'needs-approval' | 'dangerous'
  ruleSuggestion?: string
}

export interface ApprovalDecision {
  requestId: string
  inputDigest: string
  cwd: string
  action: 'allow' | 'deny'
  scope: ApprovalScope
  status: ApprovalStatus
  rule?: string
  feedback?: string
}

export interface ApprovalHost {
  request(request: ApprovalRequest): Promise<ApprovalDecision>
}

export type ApprovalPending = Omit<ApprovalRequest, 'signal'> & {
  status: 'queued' | 'active' | 'needs_input'
}

export interface ApprovalBrokerOptions {
  onRule?: (rule: string, request: ApprovalRequest) => void | Promise<void>
}

interface PendingApproval {
  original: ApprovalRequest
  request: ApprovalRequest
  controller: AbortController
  status: ApprovalPending['status']
  resolve?: (decision: ApprovalDecision) => void
  onAbort: () => void
}

export function approvalInputDigest(input: unknown): string {
  const ancestors = new Set<object>()
  const canonical = (value: unknown): string => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
    if (typeof value !== 'object' || value === null) throw new TypeError('Approval input must contain only JSON values')
    if (ancestors.has(value)) throw new TypeError('Approval input must not contain cycles')
    ancestors.add(value)
    try {
      if (Array.isArray(value)) {
        const parts: string[] = []
        for (let index = 0; index < value.length; index++) {
          if (!Object.hasOwn(value, index)) throw new TypeError('Approval input must not contain sparse arrays')
          parts.push(canonical(value[index]))
        }
        return `[${parts.join(',')}]`
      }
      const prototype: unknown = Object.getPrototypeOf(value)
      if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length) {
        throw new TypeError('Approval input must contain plain JSON objects')
      }
      const record = value as Record<string, unknown>
      return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
    } finally {
      ancestors.delete(value)
    }
  }
  return createHash('sha256').update(canonical(input)).digest('hex')
}

export class ApprovalBroker {
  private host: ApprovalHost | null = null
  private pending = new Map<string, PendingApproval>()
  private queue: PendingApproval[] = []
  private active: PendingApproval | null = null
  private sessionGrants = new Set<string>()

  constructor(private readonly options: ApprovalBrokerOptions = {}) {}

  attachHost(host: ApprovalHost): () => void {
    if (this.host) this.disconnectHost('Approval host replaced')
    this.host = host
    this.drain()
    return () => {
      if (this.host === host) this.disconnectHost('Approval host disconnected')
    }
  }

  disconnectHost(reason = 'Approval host disconnected'): void {
    this.host = null
    this.sessionGrants.clear()
    for (const pending of [...this.pending.values()]) {
      if (pending.resolve) this.settle(pending, this.denied(pending.request, 'needs_input', reason), false)
    }
  }

  cancel(requestId: string): boolean {
    const pending = this.pending.get(requestId)
    if (!pending) return false
    this.settle(pending, this.denied(pending.request, 'cancelled'), false)
    this.drain()
    return true
  }

  pendingSnapshot(): ApprovalPending[] {
    return [...this.pending.values()].map(({ request, status }) => {
      const { signal: _signal, ...snapshot } = request
      void _signal
      return { ...snapshot, status }
    })
  }

  request(original: ApprovalRequest): Promise<ApprovalDecision> {
    const request = { ...original }
    if (!this.options.onRule) delete request.ruleSuggestion
    if (request.signal.aborted) return Promise.resolve(this.denied(request, 'cancelled'))
    const previous = this.pending.get(request.requestId)
    if (previous?.resolve) return Promise.resolve(this.denied(request, 'stale', 'Approval request identity is already pending'))
    if (previous) this.remove(previous)
    if (this.sessionGrants.has(this.sessionKey(request))) {
      return Promise.resolve({ ...this.denied(request, 'decided'), action: 'allow', scope: 'session' })
    }
    const controller = new AbortController()
    const pending: PendingApproval = {
      original, request: { ...request, signal: controller.signal }, controller, status: this.host ? 'queued' : 'needs_input',
      onAbort: () => { this.cancel(request.requestId) },
    }
    this.pending.set(request.requestId, pending)
    original.signal.addEventListener('abort', pending.onAbort, { once: true })
    if (!this.host) return Promise.resolve(this.denied(request, 'needs_input', 'No approval host is available'))
    const result = new Promise<ApprovalDecision>((resolve) => { pending.resolve = resolve })
    this.queue.push(pending)
    this.drain()
    return result
  }

  private sessionKey(request: ApprovalRequest): string {
    return JSON.stringify([request.tool, request.cwd, request.inputDigest, request.policyDigest ?? null])
  }

  private denied(request: ApprovalRequest, status: ApprovalStatus, feedback?: string): ApprovalDecision {
    return { requestId: request.requestId, inputDigest: request.inputDigest, cwd: request.cwd, action: 'deny', scope: 'once', status, ...(feedback ? { feedback } : {}) }
  }

  private unchanged(pending: PendingApproval): boolean {
    return (['requestId', 'runId', 'operationId', 'tool', 'inputDigest', 'cwd', 'policyDigest'] as const)
      .every((key) => pending.original[key] === pending.request[key])
  }

  private remove(pending: PendingApproval): void {
    pending.original.signal.removeEventListener('abort', pending.onAbort)
    if (this.pending.get(pending.request.requestId) === pending) this.pending.delete(pending.request.requestId)
    this.queue = this.queue.filter((item) => item !== pending)
    if (this.active === pending) this.active = null
  }

  private settle(pending: PendingApproval, decision: ApprovalDecision, drain = true): void {
    const resolve = pending.resolve
    pending.resolve = undefined
    this.queue = this.queue.filter((item) => item !== pending)
    if (this.active === pending) this.active = null
    if (decision.status === 'needs_input') pending.status = 'needs_input'
    else this.remove(pending)
    if (decision.status === 'needs_input' || decision.status === 'cancelled') pending.controller.abort()
    resolve?.(decision)
    if (drain) this.drain()
  }

  private drain(): void {
    if (!this.host || this.active) return
    const pending = this.queue.shift()
    if (!pending) return
    this.active = pending
    pending.status = 'active'
    void this.ask(pending, this.host)
  }

  private async ask(pending: PendingApproval, host: ApprovalHost): Promise<void> {
    try {
      const decision = await host.request(pending.request)
      if (!pending.resolve) return
      if (!this.unchanged(pending) || decision.requestId !== pending.request.requestId || decision.inputDigest !== pending.request.inputDigest || decision.cwd !== pending.request.cwd) {
        this.settle(pending, this.denied(pending.request, 'stale', 'Approval no longer matches the operation or directory'))
        return
      }
      if (decision.action !== 'allow' || decision.status !== 'decided') {
        const status: ApprovalStatus = ['decided', 'needs_input', 'cancelled', 'stale'].includes(decision.status) ? decision.status : 'stale'
        this.settle(pending, this.denied(pending.request, status, decision.feedback))
        return
      }
      if (!['once', 'session', 'rule'].includes(decision.scope)) {
        this.settle(pending, this.denied(pending.request, 'stale', 'Unsupported approval scope'))
        return
      }
      if (decision.scope === 'rule') {
        if (!this.options.onRule) {
          this.settle(pending, this.denied(pending.request, 'needs_input', 'Persistent approval rules are not supported by this host'))
          return
        }
        if (!decision.rule || decision.rule !== pending.request.ruleSuggestion) {
          this.settle(pending, this.denied(pending.request, 'stale', 'Approval rule does not match the explicitly offered rule'))
          return
        }
        await this.options.onRule(decision.rule, { ...pending.request })
        if (!pending.resolve) return
        if (!this.unchanged(pending)) {
          this.settle(pending, this.denied(pending.request, 'stale'))
          return
        }
      }
      if (decision.scope === 'session') this.sessionGrants.add(this.sessionKey(pending.request))
      this.settle(pending, { ...decision, ...(decision.scope !== 'rule' ? { rule: undefined } : {}) })
    } catch (error) {
      if (!pending.resolve) return
      this.settle(pending, this.denied(pending.request, 'needs_input', `Approval host failed: ${error instanceof Error ? error.message : String(error)}`))
    }
  }
}
