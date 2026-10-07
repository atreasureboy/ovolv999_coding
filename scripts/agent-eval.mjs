import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, lstatSync, readlinkSync } from 'node:fs'
import { resolve, join, dirname, isAbsolute } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'
import { root, isolatedEnv } from './release-utils.mjs'
import { fixtureTasks, fixtureFiles } from './fixtures/coding-tasks/tasks.mjs'

const fixtures = fileURLToPath(new URL('./fixtures/coding-tasks/', import.meta.url))
const OUTCOMES = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'limit_reached', 'blocked', 'needs_input'])
const categories = { bug: 4, refactor: 3, build: 2, multimodal: 1, cancellation: 1, conflict: 1 }
const variants = new Set(['normal', 'claim-only', 'wrong-edit', 'unrelated-edit', 'limit'])
const sha = value => createHash('sha256').update(value).digest('hex')
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const save = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n') }
const portable = value => typeof value === 'string' && value.length > 0 && !isAbsolute(value) && !/^[a-z]:|[\\\0]/i.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..')

export function validateManifest(input) {
  if (!input || input.schemaVersion !== 1 || !Array.isArray(input.tasks) || input.tasks.length !== 12) throw new Error('Coding manifest must contain exactly twelve versioned tasks')
  const ids = new Set()
  const counts = {}
  for (const task of input.tasks) {
    if (!task || !/^[a-z][a-z0-9-]{1,63}$/.test(task.id) || ids.has(task.id)) throw new Error('Invalid or duplicate coding task identity')
    ids.add(task.id)
    counts[task.category] = (counts[task.category] ?? 0) + 1
    if (!Object.hasOwn(categories, task.category) || !/^[a-f0-9]{40}$/.test(task.baseCommit) || typeof task.prompt !== 'string' || !task.prompt.trim()) throw new Error(`Invalid coding task contract: ${task.id}`)
    if (!portable(task.acceptance) || !existsSync(join(fixtures, task.acceptance))) throw new Error(`Invalid independent acceptance path: ${task.id}`)
    if (!Array.isArray(task.allowedPaths) || !task.allowedPaths.length || task.allowedPaths.some(path => !portable(path))) throw new Error(`Invalid allowed paths: ${task.id}`)
    if (!task.budget || ['maxRequests', 'maxIterations', 'maxDurationMs', 'maxOutputBytes'].some(key => !Number.isSafeInteger(task.budget[key]) || task.budget[key] < 1)) throw new Error(`Invalid task budget: ${task.id}`)
    if (!OUTCOMES.has(task.expectedOutcome)) throw new Error(`Invalid expected task outcome: ${task.id}`)
  }
  if (Object.entries(categories).some(([category, count]) => counts[category] !== count)) throw new Error('Coding manifest category counts do not match the twelve-task baseline')
  return structuredClone(input)
}

export function evaluateResult(observation) {
  const outcome = observation.timedOut || observation.budgetExceeded ? 'limit_reached' : OUTCOMES.has(observation.outcome) ? observation.outcome : 'failed'
  const unrelatedChanges = [...new Set(observation.unrelatedChanges ?? [])].sort()
  const usage = ['actual', 'estimated'].includes(observation.usage) ? observation.usage : 'unknown'
  const result = { ...observation, schemaVersion: 1, outcome, unrelatedChanges, usage,
    checksPassed: outcome === 'completed' && observation.exitCode === 0 && observation.acceptancePassed === true && unrelatedChanges.length === 0 && observation.toolChainPassed === true && !(observation.unfinishedResources?.length),
  }
  if (usage === 'unknown') { delete result.inputTokens; delete result.outputTokens }
  return result
}

export function runProgram(executable, args, { cwd = root, env = process.env, timeout = 30000, maxOutputBytes = 1024 * 1024, ipc = false, onStart } = {}) {
  return new Promise((resolveResult, reject) => {
    const started = performance.now()
    const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])] })
    const output = { stdout: '', stderr: '' }
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
    let bytes = 0, timedOut = false, overflow = false, completed = false
    let code = null, signal = null, terminationError
    let timer, settlementTimer
    const finish = rootClosed => {
      if (completed) return
      completed = true
      clearTimeout(timer); clearTimeout(settlementTimer)
      for (const channel of ['stdout', 'stderr']) output[channel] += decoders[channel].end()
      child.unref(); child.stdout.unref?.(); child.stderr.unref?.(); child.channel?.unref?.()
      resolveResult({ ...output, code, signal, timedOut, overflow, pid: child.pid, durationMs: Math.round(performance.now() - started),
        physicalSettlement: rootClosed ? 'root-closed' : 'unconfirmed',
        unfinishedResources: timedOut || overflow || !rootClosed ? [`unqualified cleanup for process ${child.pid ?? 'unknown'} and descendants`] : [],
        ...(terminationError ? { terminationError } : {}),
      })
    }
    const stop = () => {
      try { child.kill('SIGKILL') } catch (error) { terminationError = String(error) }
      settlementTimer ??= setTimeout(() => finish(false), 250)
    }
    timer = setTimeout(() => { timedOut = true; stop() }, timeout)
    for (const channel of ['stdout', 'stderr']) child[channel].on('data', chunk => {
      if (completed) return
      bytes += chunk.length
      if (bytes > maxOutputBytes) { overflow = true; stop(); return }
      output[channel] += decoders[channel].write(chunk)
    })
    child.once('error', error => {
      if (completed) return
      if (child.pid) { terminationError = String(error); stop() }
      else { completed = true; clearTimeout(timer); clearTimeout(settlementTimer); reject(error) }
    })
    child.once('exit', (exitCode, exitSignal) => { code = exitCode; signal = exitSignal })
    child.once('close', (exitCode, exitSignal) => { code = exitCode; signal = exitSignal; finish(true) })
    onStart?.(child)
  })
}

export async function prepareTaskRepository(task, workspace, home) {
  mkdirSync(workspace, { recursive: true })
  mkdirSync(home, { recursive: true })
  for (const [name, content] of Object.entries(fixtureFiles(task)).sort(([a], [b]) => a.localeCompare(b))) {
    if (!portable(name)) throw new Error('Fixture file escaped its repository')
    const path = join(workspace, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  const env = isolatedEnv(home, { GIT_AUTHOR_NAME: 'Offline Fixture', GIT_AUTHOR_EMAIL: 'fixture@localhost', GIT_COMMITTER_NAME: 'Offline Fixture', GIT_COMMITTER_EMAIL: 'fixture@localhost', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z', GIT_CONFIG_NOSYSTEM: '1' })
  for (const args of [['init', '--quiet', '--initial-branch=fixture'], ['config', 'core.autocrlf', 'false'], ['add', '--all'], ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Coding fixture baseline v1']]) {
    const result = await runProgram('git', args, { cwd: workspace, env })
    if (result.code !== 0) throw new Error(`Fixture git initialization failed: ${result.stderr}`)
  }
  const result = await runProgram('git', ['rev-parse', 'HEAD'], { cwd: workspace, env })
  if (result.code !== 0) throw new Error('Fixture base commit unavailable')
  return result.stdout.trim()
}

function inventory(workspace) {
  const values = new Map()
  let bytes = 0
  const visit = (directory, prefix = '', depth = 0) => {
    if (depth > 20) throw new Error('Evaluation inventory depth exceeded')
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name
      if (!prefix && ['.git', 'sessions', 'ovogo_progress.json'].includes(entry.name)) continue
      const path = join(directory, entry.name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) values.set(name, 'link:' + readlinkSync(path))
      else if (stat.isDirectory()) visit(path, name + '/', depth + 1)
      else if (stat.isFile()) {
        bytes += stat.size
        if (bytes > 16 * 1024 * 1024 || values.size >= 1000) throw new Error('Evaluation inventory budget exceeded')
        values.set(name, sha(readFileSync(path)))
      }
    }
  }
  visit(workspace)
  return values
}

function changes(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])].filter(name => before.get(name) !== after.get(name)).sort()
}

function imageReference() {
  const crc = buffer => {
    let value = 0xffffffff
    for (const byte of buffer) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0) }
    return value ^ 0xffffffff
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(body) >>> 0)
    return Buffer.concat([length, body, checksum])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 0, 255, 255]))), chunk('IEND', Buffer.alloc(0))]).toString('base64')
}

async function startFixtureProvider(task, workspace, budget, variant) {
  const steps = structuredClone(task.steps)
  if (variant === 'wrong-edit') steps.find(step => step.name === 'Edit').input.new_string = 'values.reduce((total, value) => total + value, 1)'
  if (variant === 'unrelated-edit') steps.splice(steps.length - 1, 0, { name: 'Read', input: { file_path: 'sentinel.txt' } }, { name: 'Edit', input: { file_path: 'sentinel.txt', old_string: 'Do not modify this unrelated file.', new_string: 'Unrelated file changed.' } })
  const state = { requests: 0, index: 0, phase: task.cancel ? 'cancel' : 'normal', budgetExceeded: false, interventionCount: 0, cancelRequested: false, sawMultimodal: false, records: [], onCancelReady: null }
  const server = createServer(async (request, response) => {
    try {
      let body = ''
      for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('Fixture input exceeded byte budget') }
      const data = JSON.parse(body)
      state.requests++
      state.sawMultimodal ||= data.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))
      state.records.push({ phase: state.phase, model: data.model, toolResults: data.messages.filter(message => message.role === 'tool').map(message => ({ id: message.tool_call_id, content: message.content })), requestedTool: steps[state.index]?.name })
      if (state.requests > (variant === 'limit' ? 1 : budget.maxRequests)) {
        state.budgetExceeded = true
        response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Offline fixture request budget exhausted' } })); return
      }
      if (task.cancel && state.phase === 'cancel' && state.index === 1) {
        if (!state.cancelRequested) { state.cancelRequested = true; state.interventionCount++; state.onCancelReady?.() }
        return
      }
      if (task.externalWrite && state.index === 1 && !state.interventionCount) {
        writeFileSync(join(workspace, task.externalWrite.path), task.externalWrite.content)
        state.interventionCount++
      }
      const step = variant === 'claim-only' ? undefined : steps[state.index++]
      const delta = step ? { tool_calls: [{ index: 0, id: `fixture-${state.phase}-${state.index}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.input) } }] } : { content: 'The fixture sequence has ended. Independent checks determine its result.' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ id: 'offline-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: step ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: String(error) } }))
    }
  })
  await new Promise((resolveStarted, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveStarted) })
  return { state, url: `http://127.0.0.1:${server.address().port}/v1`, async close() { server.closeAllConnections(); await new Promise(resolveClosed => server.close(resolveClosed)) } }
}

async function acceptance(task, workspace, home) {
  const result = await runProgram(process.execPath, [join(fixtures, task.acceptance), task.id, workspace], { cwd: workspace, env: isolatedEnv(home), timeout: 10000 })
  return { passed: result.code === 0 && !result.timedOut && !result.overflow, exitCode: result.code, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut }
}

function readEvidence(runtimeDir) {
  const runs = existsSync(join(runtimeDir, 'runs')) ? readdirSync(join(runtimeDir, 'runs')).filter(name => name.endsWith('.json')).map(name => json(join(runtimeDir, 'runs', name))) : []
  return { runs, toolCalls: runs.flatMap(run => Object.entries(run.operations).map(([id, operation]) => ({ id, name: operation.name, status: operation.receipt?.status ?? 'unknown' }))) }
}

function cliOutcome(result, evidence, workspace) {
  if (result.timedOut || result.overflow) return 'limit_reached'
  const status = evidence.runs.at(-1)?.status
  if (OUTCOMES.has(status)) return status
  try { const progress = json(join(workspace, 'ovogo_progress.json')); if (OUTCOMES.has(progress.current_step)) return progress.current_step } catch {}
  return 'failed'
}

function runtimeIdentity(cliPath) {
  const path = resolve(cliPath, '../../build-info.json')
  return existsSync(path) ? json(path) : null
}

async function runTask(contract, cliPath, outputDir, revision, variant) {
  const task = fixtureTasks.find(candidate => candidate.id === contract.id)
  if (!task) throw new Error('Manifest has no corresponding deterministic fixture')
  const workspace = join(outputDir, contract.id, 'workspace')
  const home = join(outputDir, contract.id, 'home')
  const baseCommit = await prepareTaskRepository(task, workspace, home)
  if (baseCommit !== contract.baseCommit) throw new Error(`Fixture base commit mismatch for ${task.id}: ${baseCommit}`)
  const before = inventory(workspace)
  const baseline = await acceptance(contract, workspace, home)
  save(join(outputDir, contract.id, 'baseline-check.json'), baseline)
  const provider = await startFixtureProvider(task, workspace, contract.budget, variant)
  const started = performance.now()
  const phases = []
  let primary, recovery
  const execute = async (phase, { sessionDir, engineFixture = false } = {}) => {
    const phaseDir = join(outputDir, contract.id, phase)
    const runtimeDir = join(phaseDir, 'runtime')
    mkdirSync(phaseDir, { recursive: true })
    const env = isolatedEnv(home, { OPENAI_API_KEY: 'offline-fixture-only', OPENAI_BASE_URL: provider.url, OVOGO_STATE_DIR: runtimeDir })
    let run
    if (engineFixture) {
      const input = join(phaseDir, 'agent-input.json')
      const resultPath = join(phaseDir, 'agent-result.json')
      save(input, { cliPath, cwd: workspace, baseURL: provider.url, prompt: contract.prompt, resultPath })
      run = await runProgram(process.execPath, [join(fixtures, 'agent-fixture.mjs'), input], { env, timeout: contract.budget.maxDurationMs, maxOutputBytes: contract.budget.maxOutputBytes, ipc: true, onStart: child => { provider.state.onCancelReady = () => child.send({ type: 'cancel' }) } })
      const saved = existsSync(resultPath) ? json(resultPath) : null
      sessionDir = saved?.sessionDir
      run.engineOutcome = saved?.result.status
    } else {
      const args = [cliPath, '--cwd', workspace, '--model', 'offline-coding-fixture-v1', '--max-iter', String(contract.budget.maxIterations)]
      if (sessionDir) args.push('--resume', sessionDir)
      args.push(contract.prompt)
      run = await runProgram(process.execPath, args, { env, timeout: contract.budget.maxDurationMs, maxOutputBytes: contract.budget.maxOutputBytes })
    }
    writeFileSync(join(phaseDir, 'stdout.log'), run.stdout)
    writeFileSync(join(phaseDir, 'stderr.log'), run.stderr)
    const evidence = readEvidence(runtimeDir)
    const checked = await acceptance(contract, workspace, home)
    save(join(phaseDir, 'acceptance.json'), checked)
    const changedPaths = changes(before, inventory(workspace))
    const result = evaluateResult({ taskId: task.id, revision, taskBaseCommit: baseCommit, model: 'offline-coding-fixture-v1', outcome: run.engineOutcome ?? cliOutcome(run, evidence, workspace),
      acceptancePassed: checked.passed, unrelatedChanges: changedPaths.filter(name => !contract.allowedPaths.includes(name)), changedPaths,
      durationMs: run.durationMs, usage: 'unknown', interventionCount: provider.state.interventionCount, toolCalls: evidence.toolCalls,
      toolChainPassed: ['Read', 'Edit', 'Bash'].every(name => evidence.toolCalls.some(call => call.name === name && call.status === 'completed')),
      timedOut: run.timedOut, budgetExceeded: provider.state.budgetExceeded, exitCode: run.code, entry: engineFixture ? 'installed-engine-fixture' : 'cli',
      physicalSettlement: run.physicalSettlement, unfinishedResources: run.unfinishedResources, evidenceDir: phaseDir,
    })
    save(join(phaseDir, 'result.json'), result)
    phases.push(result)
    return { result, sessionDir }
  }
  try {
    if (task.image) {
      const runtime = resolve(cliPath, '../../src/core/sessionManager.js')
      const sessions = await import(pathToFileURL(runtime).href)
      const session = sessions.createSessionDir(workspace)
      try { sessions.saveSession(session, [{ role: 'user', content: [{ type: 'text', text: contract.prompt }, { type: 'image_url', image_url: { url: imageReference() } }, { type: 'text', text: 'Correction: preserve authentication and the Status accessible label.' }] }]) } finally { sessions.releaseSessionOwnership(session) }
      primary = (await execute('primary', { sessionDir: session })).result
      if (!provider.state.sawMultimodal) { primary.checksPassed = false; primary.transportFailure = 'Image content did not reach the actual provider request' }
    } else if (task.cancel) {
      const cancelled = await execute('primary', { engineFixture: true })
      primary = cancelled.result
      const preserved = readFileSync(join(workspace, 'src/value.mjs'), 'utf8') === task.files['src/value.mjs']
      primary.cancelPreservedSource = preserved
      if (primary.outcome === 'cancelled' && preserved && cancelled.sessionDir) {
        provider.state.phase = 'recovery'; provider.state.index = 0
        recovery = (await execute('recovery', { sessionDir: cancelled.sessionDir })).result
        primary.recovery = recovery
      }
    } else primary = (await execute('primary')).result
    const expected = variant === 'normal' && !baseline.passed && primary.outcome === contract.expectedOutcome && primary.unrelatedChanges.length === 0 &&
      (task.cancel ? primary.cancelPreservedSource && recovery?.checksPassed === true : task.externalWrite ? primary.acceptancePassed && primary.interventionCount === 1 && primary.toolCalls.some(call => call.name === 'Edit' && call.status === 'failed') : primary.checksPassed)
    primary.fixturePassed = Boolean(expected)
    primary.baselineChecksPassed = baseline.passed
    primary.durationMs = Math.round(performance.now() - started)
    save(join(outputDir, contract.id, 'result.json'), primary)
    return primary
  } finally { await provider.close(); save(join(outputDir, contract.id, 'provider.json'), provider.state); save(join(outputDir, contract.id, 'phases.json'), phases) }
}

export async function runOfflineEvaluation({ cliPath = join(root, 'dist/bin/ovogogogo.js'), outputDir = join(root, '.artifacts/agent-eval', new Date().toISOString().replace(/[:.]/g, '-')), taskIds, variant = 'normal', onProgress } = {}) {
  cliPath = resolve(cliPath); outputDir = resolve(outputDir)
  if (!existsSync(cliPath) || !variants.has(variant)) throw new Error('Choose an existing built/installed CLI and a supported offline fixture variant')
  const manifestPath = join(fixtures, 'manifest.json')
  const manifest = validateManifest(json(manifestPath))
  if (taskIds && (!Array.isArray(taskIds) || !taskIds.length || taskIds.some(id => !manifest.tasks.some(task => task.id === id)))) throw new Error('Unknown or empty task selection')
  const selected = manifest.tasks.filter(task => !taskIds || taskIds.includes(task.id))
  if (existsSync(outputDir) && readdirSync(outputDir).length) throw new Error('Evaluation output directory must be empty; preserve earlier evidence')
  mkdirSync(outputDir, { recursive: true })
  const git = await runProgram('git', ['rev-parse', 'HEAD'])
  const identity = runtimeIdentity(cliPath)
  const revision = identity?.gitCommit ?? git.stdout.trim()
  const results = []
  for (const task of selected) {
    let result
    const started = performance.now()
    try { result = await runTask(task, cliPath, outputDir, revision, variant) }
    catch (error) {
      result = evaluateResult({ taskId: task.id, revision, taskBaseCommit: task.baseCommit, model: 'offline-coding-fixture-v1', outcome: 'failed',
        acceptancePassed: false, unrelatedChanges: [], durationMs: Math.round(performance.now() - started), usage: 'unknown', interventionCount: 0,
        toolCalls: [], toolChainPassed: false, evidenceIncomplete: true, fixturePassed: false, harnessError: String(error).slice(0, 4000),
        unfinishedResources: Array.isArray(error?.unfinishedResources) ? error.unfinishedResources : [],
      })
      save(join(outputDir, task.id, 'result.json'), result)
    }
    results.push(result)
    onProgress?.(result)
  }
  const report = { schemaVersion: 1, mode: 'offline-fixture', model: 'offline-coding-fixture-v1', revision, runtimeIdentity: identity, cliSha256: sha(readFileSync(cliPath)), manifestSha256: sha(readFileSync(manifestPath)),
    fixturePassed: results.every(result => result.fixturePassed), successfulTasks: results.filter(result => result.checksPassed).length, taskCount: results.length,
    limitation: 'Deterministic provider fixtures establish harness behavior only. No paid model, model-quality parity, native isolation or exact billing is qualified.', results,
  }
  save(join(outputDir, 'report.json'), report)
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (!args.includes('--offline')) throw new Error('Only --offline is implemented; no paid model calls are enabled')
    const option = name => { const index = args.indexOf(name); if (index < 0) return undefined; if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name} value`); return args[index + 1] }
    const report = await runOfflineEvaluation({ cliPath: option('--cli-path'), outputDir: option('--output'), taskIds: option('--task') ? [option('--task')] : undefined, onProgress: result => process.stdout.write(`${result.taskId}: outcome=${result.outcome} checks=${result.checksPassed} fixture=${result.fixturePassed}\n`) })
    process.stdout.write(JSON.stringify({ fixturePassed: report.fixturePassed, successfulTasks: report.successfulTasks, taskCount: report.taskCount, mode: report.mode }) + '\n')
    if (!report.fixturePassed) process.exitCode = 1
  } catch (error) { process.stderr.write(String(error) + '\n'); process.exitCode = 1 }
}
