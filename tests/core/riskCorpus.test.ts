import { describe, expect, it } from 'vitest'
import { classifyCommandRisk } from '../../src/core/riskClassifier.js'

describe('shell risk corpus', () => {
  it.each([
    'npm test',
    'cmd /c npm test',
    'powershell -Command Get-ChildItem',
    'pwsh -Command "Get-ChildItem"',
    'Remove-Item -Recurse -Force .\\build',
    'del /q *.txt',
    'echo (Get-Item file.txt).Delete()',
    'echo %TASK_PAYLOAD%',
    "echo '%TASK_PAYLOAD%'",
    'echo "unterminated',
    "git status -- 'unterminated",
    'echo hello &&',
    '&&;|',
  ])('requires approval for unknown or unparsed syntax: %s', (command) => {
    expect(classifyCommandRisk(command)).not.toBe('safe')
  })

  it.each(['pwd', 'git status', 'echo "hello world"', "echo 'hello world'", 'ls && echo done'])('retains the known read-only classification: %s', (command) => {
    expect(classifyCommandRisk(command)).toBe('safe')
  })
})
