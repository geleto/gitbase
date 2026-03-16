import * as assert from 'assert'
import { makeBaseUri, parseBaseUri } from '../../src/content'

// Helper: round-trip through makeBaseUri → parseBaseUri
function roundTrip(root: string, ref: string, fp: string, suffix?: string) {
  return parseBaseUri(makeBaseUri(root, ref, fp, suffix))
}

suite('makeBaseUri / parseBaseUri round-trip', () => {
  test('#1 simple path and SHA ref recovers all fields', () => {
    const r = roundTrip('/repo', 'abc'.repeat(13) + 'a', 'src/file.ts')
    assert.strictEqual(r.root, '/repo')
    assert.strictEqual(r.ref,  'abc'.repeat(13) + 'a')
    assert.strictEqual(r.fp,   'src/file.ts')
  })

  test('#2 root with spaces encoded and decoded correctly', () => {
    const r = roundTrip('/my repo/project', 'abc1234', 'file.ts')
    assert.strictEqual(r.root, '/my repo/project')
  })

  test('#3 fp with forward slashes preserved', () => {
    const r = roundTrip('/repo', 'abc1234', 'src/utils/helpers.ts')
    assert.strictEqual(r.fp, 'src/utils/helpers.ts')
  })

  test('#4 ref with slash (origin/main) encoded as %2F and decoded back', () => {
    const r = roundTrip('/repo', 'origin/main', 'file.ts')
    assert.strictEqual(r.ref, 'origin/main')
  })

  test('#5 ref containing & encoded as %26, not split by & separator', () => {
    const r = roundTrip('/repo', 'a&b', 'file.ts')
    assert.strictEqual(r.ref, 'a&b')
  })

  test('#6 fp containing & encoded correctly', () => {
    const r = roundTrip('/repo', 'abc1234', 'src/a&b.ts')
    assert.strictEqual(r.fp, 'src/a&b.ts')
  })

  test('#7 default suffix → fragment is empty string', () => {
    const uri = makeBaseUri('/repo', 'abc1234', 'file.ts')
    assert.strictEqual(uri.fragment, '')
  })

  test('#8 non-empty suffix stored in fragment', () => {
    const uri = makeBaseUri('/repo', 'abc1234', 'file.ts', 'origin/main')
    assert.strictEqual(uri.fragment, 'origin/main')
  })

  test('#9 URI scheme is basegit', () => {
    const uri = makeBaseUri('/repo', 'abc1234', 'file.ts')
    assert.strictEqual(uri.scheme, 'basegit')
  })

  test('#10 URI path is / + fp', () => {
    const uri = makeBaseUri('/repo', 'abc1234', 'src/file.ts')
    assert.strictEqual(uri.path, '/src/file.ts')
  })

  test('#11 Windows-style root path encoded and decoded correctly', () => {
    const r = roundTrip('C:\\Users\\name\\repo', 'abc1234', 'file.ts')
    assert.strictEqual(r.root, 'C:\\Users\\name\\repo')
  })

  test('#12 Unicode chars in root and fp preserved', () => {
    const r = roundTrip('/r\u00e9po', 'abc1234', 'caf\u00e9.ts')
    assert.strictEqual(r.root, '/r\u00e9po')
    assert.strictEqual(r.fp,   'caf\u00e9.ts')
  })

  test('#13 parseBaseUri with malformed query (no & separator) → treats whole string as root', () => {
    const fakeUri = { query: 'missingampersands' } as any
    const r = parseBaseUri(fakeUri)
    assert.strictEqual(r.root, 'missingampersands')
    assert.strictEqual(r.ref,  '')
    assert.strictEqual(r.fp,   '')
  })

  test('#14 parseBaseUri with empty query → no crash, all fields empty strings', () => {
    const fakeUri = { query: '' } as any
    const r = parseBaseUri(fakeUri)
    assert.strictEqual(r.root, '')
    assert.strictEqual(r.ref,  '')
    assert.strictEqual(r.fp,   '')
  })
})
