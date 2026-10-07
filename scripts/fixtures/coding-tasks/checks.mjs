import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const [taskId, rawWorkspace] = process.argv.slice(2)
const workspace = resolve(rawWorkspace)
const load = file => import(pathToFileURL(join(workspace, file)).href)
const contents = file => readFileSync(join(workspace, file), 'utf8')

switch (taskId) {
  case 'sum-empty': {
    const { sum } = await load('src/math.mjs')
    assert.equal(sum([]), 0)
    assert.equal(sum([-2, 2, 0]), 0)
    assert.equal(sum([0.5, 1.5]), 2)
    break
  }
  case 'clamp-boundary': {
    const { clamp } = await load('src/clamp.mjs')
    assert.equal(clamp(-5, 0, 10), 0)
    assert.equal(clamp(15, 0, 10), 10)
    assert.equal(clamp(0, -2, 2), 0)
    assert.equal(clamp(99, 3, 3), 3)
    break
  }
  case 'path-boundary': {
    const { belongs } = await load('src/path.mjs')
    assert.equal(belongs('api', 'api'), true)
    assert.equal(belongs('api2/item', 'api'), false)
    assert.equal(belongs('api/item/nested', 'api'), true)
    assert.equal(belongs('other/api', 'api'), false)
    break
  }
  case 'unicode-count': {
    const { countLabel } = await load('src/label.mjs')
    assert.equal(countLabel(''), 0)
    assert.equal(countLabel('更正🙂'), 3)
    assert.equal(countLabel('𠮷a'), 2)
    break
  }
  case 'rename-money': {
    const money = await load('src/money.mjs')
    const { invoice } = await load('src/invoice.mjs')
    assert.equal(typeof money.formatPrice, 'function')
    assert.equal(Object.hasOwn(money, 'price'), false)
    assert.equal(money.formatPrice(0), '$0.00')
    assert.equal(invoice(12.3), 'Total: $12.30')
    break
  }
  case 'shared-normalizer': {
    const { normalizeName } = await load('src/normalize.mjs')
    const { customerName } = await load('src/customer.mjs')
    const { orderName } = await load('src/order.mjs')
    assert.equal(normalizeName(' Z '), 'z')
    assert.equal(customerName(' Alice '), 'alice')
    assert.equal(orderName(' Order '), 'order')
    assert.match(contents('src/customer.mjs'), /from ['"]\.\/normalize\.mjs['"]/)
    assert.match(contents('src/order.mjs'), /from ['"]\.\/normalize\.mjs['"]/)
    break
  }
  case 'split-parser': {
    const parser = await load('src/parser.mjs')
    const csv = await load('src/csv.mjs')
    const { renderRow } = await load('src/render.mjs')
    assert.equal(csv.parseRow, parser.parseRow)
    assert.deepEqual(parser.parseRow(',a,'), ['', 'a', ''])
    assert.equal(renderRow(',a,'), '|a|')
    assert.match(contents('src/render.mjs'), /from ['"]\.\/parser\.mjs['"]/)
    break
  }
  case 'builtin-dependency': {
    const { check } = await load('src/check.mjs')
    assert.equal(check(true), 'checked')
    assert.throws(() => check(false))
    break
  }
  case 'build-entry': {
    const packageJson = JSON.parse(contents('package.json'))
    assert.equal(packageJson.scripts.build, 'node scripts/build.mjs')
    execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: workspace, timeout: 10000, windowsHide: true })
    assert.ok(existsSync(join(workspace, 'dist/entry.mjs')))
    assert.equal((await load('dist/entry.mjs')).value, 'build-ok')
    break
  }
  case 'image-text': {
    const { theme } = await load('src/theme.mjs')
    assert.deepEqual(theme, { left: '#ff0000', right: '#0000ff', label: 'Status' })
    assert.equal(contents('src/auth.mjs'), "export const authentication = 'unchanged'\n")
    break
  }
  case 'cancel-resume': {
    const { value } = await load('src/value.mjs')
    assert.equal(value(), 'after')
    break
  }
  case 'external-conflict': {
    assert.equal(contents('src/value.mjs'), "export function value() { return 'external-user' }\n")
    break
  }
  default: throw new Error('Unknown coding acceptance task')
}
process.stdout.write(JSON.stringify({ taskId, passed: true }) + '\n')
