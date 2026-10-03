import { afterEach, describe, expect, it, vi } from 'vitest'
import { run, runNode } from '../scripts/release-utils.mjs'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

afterEach(() => { vi.useRealTimers() })

describe('release command execution', () => {
  it('decodes UTF8 output split across process writes', async () => {
    const result = await runNode(['-e', "const b=Buffer.from('中文 🧩');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),30)"])
    expect(result.stdout).toBe('中文 🧩')
  })

  it('clears the deadline when process creation fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await expect(run('ovogo-deliberately-missing-command', [])).rejects.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops owned descendants when a release command times out', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'release-process-'))
    let pid
    try {
      await expect(runNode(['-e', "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});require('fs').writeFileSync('child-pid',String(c.pid));setInterval(()=>{},1000)"], { cwd, timeout: 500 })).rejects.toThrow()
      pid = Number(readFileSync(join(cwd, 'child-pid'), 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      if (pid) {
        try {
          if (process.platform === 'win32') execFileSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
          else process.kill(pid, 'SIGKILL')
        } catch (error) { void error }
      }
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
