const read = file => ({ name: 'Read', input: { file_path: file } })
const edit = (file, oldText, newText) => ({ name: 'Edit', input: { file_path: file, old_string: oldText, new_string: newText } })
const write = (file, content) => ({ name: 'Write', input: { file_path: file, content } })
const test = { name: 'Bash', input: { command: 'node --test tests/public.test.mjs', timeout: 10000 } }
const publicTest = body => `import assert from 'node:assert/strict'\n${body}\n`

export const fixtureTasks = [
  {
    id: 'sum-empty', category: 'bug', prompt: 'Fix sum so an empty list returns zero and ordinary sums remain correct. Change only src/math.mjs. Read the source, make a targeted edit, and run the public test.',
    files: { 'src/math.mjs': 'export function sum(values) { return values.reduce((total, value) => total + value) }\n', 'tests/public.test.mjs': publicTest("import { sum } from '../src/math.mjs'\nassert.equal(sum([1, 2, 3]), 6)") },
    allowedPaths: ['src/math.mjs'], steps: [read('src/math.mjs'), edit('src/math.mjs', 'values.reduce((total, value) => total + value)', 'values.reduce((total, value) => total + value, 0)'), test],
  },
  {
    id: 'clamp-boundary', category: 'bug', prompt: 'Correct clamp for values below, inside, and above the inclusive bounds, including zero and equal bounds. Change only src/clamp.mjs and run the public test.',
    files: { 'src/clamp.mjs': 'export function clamp(value, min, max) { return Math.min(min, Math.max(max, value)) }\n', 'tests/public.test.mjs': publicTest("import { clamp } from '../src/clamp.mjs'\nassert.equal(clamp(5, 0, 10), 5)") },
    allowedPaths: ['src/clamp.mjs'], steps: [read('src/clamp.mjs'), edit('src/clamp.mjs', 'Math.min(min, Math.max(max, value))', 'Math.max(min, Math.min(max, value))'), test],
  },
  {
    id: 'path-boundary', category: 'bug', prompt: 'Fix belongs so api and api/item belong to api but api2/item does not. Preserve nested names and do not edit tests. Read, edit, and test src/path.mjs.',
    files: { 'src/path.mjs': "export function belongs(path, root) { return path.startsWith(root) }\n", 'tests/public.test.mjs': publicTest("import { belongs } from '../src/path.mjs'\nassert.equal(belongs('api/item', 'api'), true)") },
    allowedPaths: ['src/path.mjs'], steps: [read('src/path.mjs'), edit('src/path.mjs', 'path.startsWith(root)', "path === root || path.startsWith(root + '/')"), test],
  },
  {
    id: 'unicode-count', category: 'bug', prompt: 'Count Unicode code points rather than UTF-16 code units, including CJK and emoji. Do not claim grapheme-cluster handling. Change only src/label.mjs and run tests.',
    files: { 'src/label.mjs': 'export function countLabel(text) { return text.length }\n', 'tests/public.test.mjs': publicTest("import { countLabel } from '../src/label.mjs'\nassert.equal(countLabel('abc'), 3)") },
    allowedPaths: ['src/label.mjs'], steps: [read('src/label.mjs'), edit('src/label.mjs', 'return text.length', 'return Array.from(text).length'), test],
  },
  {
    id: 'rename-money', category: 'refactor', prompt: 'Rename the price export to formatPrice and migrate its invoice caller. Keep invoice output identical; remove the old price export. Change only src/money.mjs and src/invoice.mjs; read both before editing and test.',
    files: { 'src/money.mjs': "export function price(value) { return '$' + value.toFixed(2) }\n", 'src/invoice.mjs': "import { price } from './money.mjs'\nexport function invoice(value) { return 'Total: ' + price(value) }\n", 'tests/public.test.mjs': publicTest("import { invoice } from '../src/invoice.mjs'\nassert.equal(invoice(2), 'Total: $2.00')") },
    allowedPaths: ['src/money.mjs', 'src/invoice.mjs'], steps: [read('src/money.mjs'), read('src/invoice.mjs'), edit('src/money.mjs', 'function price(', 'function formatPrice('), edit('src/invoice.mjs', 'import { price }', 'import { formatPrice }'), edit('src/invoice.mjs', 'price(value)', 'formatPrice(value)'), test],
  },
  {
    id: 'shared-normalizer', category: 'refactor', prompt: 'Extract the duplicated trim/lowercase rule to normalizeName in src/normalize.mjs and use it from customer and order. Preserve their public return values. Only modify those three source files and run tests.',
    files: { 'src/customer.mjs': "export function customerName(value) { return value.trim().toLowerCase() }\n", 'src/order.mjs': "export function orderName(value) { return value.trim().toLowerCase() }\n", 'tests/public.test.mjs': publicTest("import { customerName } from '../src/customer.mjs'\nimport { orderName } from '../src/order.mjs'\nassert.equal(customerName(' A '), 'a')\nassert.equal(orderName(' B '), 'b')") },
    allowedPaths: ['src/normalize.mjs', 'src/customer.mjs', 'src/order.mjs'], steps: [read('src/customer.mjs'), read('src/order.mjs'), write('src/normalize.mjs', "export function normalizeName(value) { return value.trim().toLowerCase() }\n"), edit('src/customer.mjs', "export function customerName(value) { return value.trim().toLowerCase() }", "import { normalizeName } from './normalize.mjs'\nexport function customerName(value) { return normalizeName(value) }"), edit('src/order.mjs', "export function orderName(value) { return value.trim().toLowerCase() }", "import { normalizeName } from './normalize.mjs'\nexport function orderName(value) { return normalizeName(value) }"), test],
  },
  {
    id: 'split-parser', category: 'refactor', prompt: 'Move parseRow into src/parser.mjs, keep parseRow re-exported from csv.mjs for compatibility, and migrate render.mjs to import the parser directly. Preserve empty fields. Read, refactor only these files, and test.',
    files: { 'src/csv.mjs': "export function parseRow(text) { return text.split(',') }\n", 'src/render.mjs': "import { parseRow } from './csv.mjs'\nexport function renderRow(text) { return parseRow(text).join('|') }\n", 'tests/public.test.mjs': publicTest("import { parseRow } from '../src/csv.mjs'\nimport { renderRow } from '../src/render.mjs'\nassert.deepEqual(parseRow('a,b'), ['a', 'b'])\nassert.equal(renderRow('a,b'), 'a|b')") },
    allowedPaths: ['src/csv.mjs', 'src/parser.mjs', 'src/render.mjs'], steps: [read('src/csv.mjs'), read('src/render.mjs'), write('src/parser.mjs', "export function parseRow(text) { return text.split(',') }\n"), edit('src/csv.mjs', "export function parseRow(text) { return text.split(',') }", "export { parseRow } from './parser.mjs'"), edit('src/render.mjs', "'./csv.mjs'", "'./parser.mjs'"), test],
  },
  {
    id: 'builtin-dependency', category: 'build', prompt: 'Repair the invalid builtin dependency import in src/check.mjs, preserve the check function, and demonstrate that importing and running it works. No package installation or network calls.',
    files: { 'src/check.mjs': "import assert from 'node:assert/strictt'\nexport function check(value) { assert.equal(value, true); return 'checked' }\n", 'tests/public.test.mjs': publicTest("import { check } from '../src/check.mjs'\nassert.equal(check(true), 'checked')") },
    allowedPaths: ['src/check.mjs'], steps: [read('src/check.mjs'), edit('src/check.mjs', "'node:assert/strictt'", "'node:assert/strict'"), test],
  },
  {
    id: 'build-entry', category: 'build', prompt: 'Fix the build entry path in scripts/build.mjs so a real build copies src/entry.mjs into dist/entry.mjs. Do not change package.json or tests. Read and edit the build script, run the public test and build.',
    files: { 'src/entry.mjs': "export const value = 'build-ok'\n", 'scripts/build.mjs': "import { mkdirSync, copyFileSync } from 'node:fs'\nmkdirSync('dist', { recursive: true })\ncopyFileSync('src/missing.mjs', 'dist/entry.mjs')\n", 'tests/public.test.mjs': publicTest("import { value } from '../src/entry.mjs'\nassert.equal(value, 'build-ok')") },
    allowedPaths: ['scripts/build.mjs', 'dist/entry.mjs'], packageScripts: { build: 'node scripts/build.mjs' }, steps: [read('scripts/build.mjs'), edit('scripts/build.mjs', "'src/missing.mjs'", "'src/entry.mjs'"), test, { name: 'Bash', input: { command: 'node scripts/build.mjs', timeout: 10000 } }],
  },
  {
    id: 'image-text', category: 'multimodal', prompt: 'Use the attached two-pixel PNG as the red-left/blue-right layout reference. Correction: keep the accessible label Status and do not modify authentication. Update only src/theme.mjs, then test. This fixture checks image transport and text constraints, not learned visual understanding.',
    files: { 'src/theme.mjs': "export const theme = { left: '#000000', right: '#000000', label: 'Status' }\n", 'src/auth.mjs': "export const authentication = 'unchanged'\n", 'tests/public.test.mjs': publicTest("import { theme } from '../src/theme.mjs'\nassert.equal(theme.label, 'Status')") },
    allowedPaths: ['src/theme.mjs'], steps: [read('src/theme.mjs'), edit('src/theme.mjs', "left: '#000000', right: '#000000'", "left: '#ff0000', right: '#0000ff'"), test],
    image: true,
  },
  {
    id: 'cancel-resume', category: 'cancellation', prompt: 'Change value() from before to after in src/value.mjs, using Read/Edit/test. A controlled cancellation will occur after the first read; preserve and resume its saved history before finishing.',
    files: { 'src/value.mjs': "export function value() { return 'before' }\n", 'tests/public.test.mjs': publicTest("import { value } from '../src/value.mjs'\nassert.equal(value(), 'after')") },
    allowedPaths: ['src/value.mjs'], steps: [read('src/value.mjs'), edit('src/value.mjs', "'before'", "'after'"), test],
    cancel: true,
  },
  {
    id: 'external-conflict', category: 'conflict', prompt: 'Attempt a Read/Edit/test update of value() in src/value.mjs. If another writer changes the file after your read, stop and preserve that external content; do not reread and overwrite it.',
    files: { 'src/value.mjs': "export function value() { return 'before' }\n", 'tests/public.test.mjs': publicTest("import { value } from '../src/value.mjs'\nassert.equal(value(), 'after')") },
    allowedPaths: ['src/value.mjs'], steps: [read('src/value.mjs'), edit('src/value.mjs', "'before'", "'after'"), test],
    externalWrite: { path: 'src/value.mjs', content: "export function value() { return 'external-user' }\n" },
  },
]

export function fixtureFiles(task) {
  return {
    '.gitignore': 'sessions/\novogo_progress.json\ndist/\n',
    '.ovolv999.json': JSON.stringify({ enabledModules: [], permissionMode: 'auto', maxIterations: 48, modelSettings: { 'offline-coding-fixture-v1': { protocol: 'chat-completions', capabilities: { tools: true, vision: true, reasoning: false, structuredOutput: false, contextWindow: 128000, maxOutputTokens: 8192 } } } }) + '\n',
    'package.json': JSON.stringify({ name: 'offline-coding-fixture', private: true, type: 'module', scripts: { test: 'node --test tests/public.test.mjs', ...task.packageScripts } }) + '\n',
    'sentinel.txt': 'Do not modify this unrelated file.\n',
    ...task.files,
  }
}
