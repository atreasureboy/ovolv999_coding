import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

let cwd
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'setup-audit-'))
  mkdirSync(join(cwd, 'scripts'))
  mkdirSync(join(cwd, 'mockbin'))
  mkdirSync(join(cwd, 'node_modules'))
  mkdirSync(join(cwd, 'dist', 'bin'), { recursive: true })
  copyFileSync('setup.bat', join(cwd, 'setup.bat'))
  copyFileSync('package.json', join(cwd, 'package.json'))
  for (const name of ['setup.mjs', 'release-utils.mjs']) {
    if (existsSync(join('scripts', name))) copyFileSync(join('scripts', name), join(cwd, 'scripts', name))
  }
  writeFileSync(join(cwd, 'dist', 'bin', 'ovogogogo.js'), 'process.stdout.write("STALE")')
  writeFileSync(join(cwd, 'mockbin', 'pnpm.cmd'), `@echo off\r\n"${process.execPath}" "${join(cwd, 'mockbin', 'pnpm.cjs')}" %*\r\nexit /b %errorlevel%\r\n`)
  writeFileSync(join(cwd, 'mockbin', 'ovolv999.cmd'), '@echo off\r\necho fixture-version\r\n')
  writeFileSync(join(cwd, 'mockbin', 'pnpm.cjs'), `
const fs=require('fs'),cp=require('child_process');const args=process.argv.slice(2);
if(args[0]==='-v'||args[0]==='--version'){console.log('11.25.0');process.exit(0)}
if(args[0]==='run'&&args[1]==='setup:local'){try{cp.execFileSync(process.execPath,['scripts/setup.mjs'],{stdio:'inherit',env:{...process.env,npm_execpath:__filename}})}catch{process.exit(1)}process.exit(0)}
fs.appendFileSync('calls.jsonl',JSON.stringify(args)+'\\n');
if(args[0]==='run'&&args[1]==='build'){if(process.env.SETUP_FIXTURE_FAIL)process.exit(9);fs.writeFileSync('dist/bin/ovogogogo.js','process.stdout.write("fresh-version")')}
`)
})
afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

function run(extra = {}) {
  try { return execFileSync('cmd.exe', ['/d', '/c', join(cwd, 'setup.bat')], { cwd, input: '\n', timeout: 10000,
    env: { ...process.env, PATH: `${join(cwd, 'mockbin')};${dirname(process.execPath)};${process.env.PATH ?? process.env.Path ?? ''}`, OPENAI_API_KEY: 'fixture-key', ...extra },
    windowsHide: true, encoding: 'utf8' }) } catch (error) { throw new Error(`${error.message}\n${error.stdout}\n${error.stderr}`, { cause: error }) }
}
function calls() { return existsSync(join(cwd, 'calls.jsonl')) ? readFileSync(join(cwd, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [] }

describe.skipIf(process.platform !== 'win32')('Windows installation workflow', () => {
  it('refreshes dependencies and rebuilds existing output using the frozen lockfile', () => {
    run()
    expect(calls()).toContainEqual(['install', '--frozen-lockfile'])
    expect(calls()).toContainEqual(['run', 'build'])
    expect(calls()).toContainEqual(['link', '--global'])
    expect(readFileSync(join(cwd, 'dist', 'bin', 'ovogogogo.js'), 'utf8')).not.toContain('STALE')
  })

  it('stops before credentials and global linking when the build fails', () => {
    expect(() => run({ SETUP_FIXTURE_FAIL: '1' })).toThrow()
    expect(existsSync(join(cwd, '.env'))).toBe(false)
    expect(calls().some(args => args[0] === 'link')).toBe(false)
  })
})
