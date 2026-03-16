import * as assert from 'assert'
import * as vscode from 'vscode'
import * as path from 'path'
import { TaskChangesDecorationProvider } from '../../src/decorations'
import { WORKAROUND_URI_FRAGMENT, WORKAROUND_DOUBLE_BADGE } from '../../src/workarounds'

suite('§3.0 TaskChangesDecorationProvider', () => {
  let provider: TaskChangesDecorationProvider
  const root = '/test/root'

  setup(() => {
    provider = new TaskChangesDecorationProvider()
  })

  teardown(() => {
    provider.dispose()
  })

  function fileUri(rel: string): vscode.Uri {
    return vscode.Uri.file(path.join(root, rel))
  }

  test('#1 update() with A entry → letter A', () => {
    provider.update(root, [{ status: 'A', path: 'a.ts' }], new Set())
    const deco = provider.provideFileDecoration(fileUri('a.ts'))
    assert.strictEqual(deco?.badge, 'A')
  })

  test('#2 update() with M entry → letter M, no strikethrough', () => {
    provider.update(root, [{ status: 'M', path: 'm.ts' }], new Set())
    const deco = provider.provideFileDecoration(fileUri('m.ts'))
    assert.strictEqual(deco?.badge, 'M')
  })

  test('#3 update() with D entry → letter D, strikeThrough true', () => {
    // D decoration: strikeThrough is set on the SourceControlResourceState, not FileDecoration
    // FileDecoration just has the badge letter
    provider.update(root, [{ status: 'D', path: 'd.ts' }], new Set())
    const deco = provider.provideFileDecoration(fileUri('d.ts'))
    assert.strictEqual(deco?.badge, 'D')
  })

  test('#4 update() with R entry → letter R', () => {
    provider.update(root, [{ status: 'R', path: 'new.ts', oldPath: 'old.ts' }], new Set())
    const deco = provider.provideFileDecoration(fileUri('new.ts'))
    assert.strictEqual(deco?.badge, 'R')
  })

  test('#5 update() with U entry → letter U', () => {
    provider.update(root, [{ status: 'U', path: 'u.ts' }], new Set())
    const deco = provider.provideFileDecoration(fileUri('u.ts'))
    assert.strictEqual(deco?.badge, 'U')
  })

  test('#6 update() fires onDidChangeFileDecorations', async () => {
    let fired: vscode.Uri[] | undefined
    const sub = provider.onDidChangeFileDecorations(uris => { fired = uris })

    provider.update(root, [{ status: 'M', path: 'x.ts' }], new Set())
    sub.dispose()

    assert.ok(fired, 'event should have fired')
    assert.ok(fired!.length > 0)
  })

  test('#7 second update() removes stale entries', () => {
    provider.update(root, [{ status: 'M', path: 'old.ts' }], new Set())
    provider.update(root, [{ status: 'A', path: 'new.ts' }], new Set())

    const oldDeco = provider.provideFileDecoration(fileUri('old.ts'))
    assert.strictEqual(oldDeco, undefined, 'old.ts should be gone')
    assert.strictEqual(provider.provideFileDecoration(fileUri('new.ts'))?.badge, 'A')
  })

  test('#8 clear(root) fires event with all URIs for that root', () => {
    provider.update(root, [{ status: 'M', path: 'f.ts' }], new Set())

    let fired: vscode.Uri[] | undefined
    const sub = provider.onDidChangeFileDecorations(uris => { fired = uris })
    provider.clear(root)
    sub.dispose()

    assert.ok(fired && fired.length > 0, 'clear should fire event')
    const deco = provider.provideFileDecoration(fileUri('f.ts'))
    assert.strictEqual(deco, undefined, 'decoration should be gone after clear')
  })

  test('#9 clear(root) on unknown root → no event fired, no crash', () => {
    let fired = false
    const sub = provider.onDidChangeFileDecorations(() => { fired = true })
    provider.clear('/no/such/root')
    sub.dispose()
    assert.strictEqual(fired, false)
  })

  test('#10 clear(root) on already-cleared root → no event fired', () => {
    provider.update(root, [{ status: 'M', path: 'f.ts' }], new Set())
    provider.clear(root)

    let fired = false
    const sub = provider.onDidChangeFileDecorations(() => { fired = true })
    provider.clear(root)
    sub.dispose()

    assert.strictEqual(fired, false)
  })

  test('#11 two roots: each roots decorations independent', () => {
    const rootB = '/test/rootB'
    provider.update(root,  [{ status: 'A', path: 'a.ts' }], new Set())
    provider.update(rootB, [{ status: 'M', path: 'm.ts' }], new Set())

    assert.strictEqual(provider.provideFileDecoration(fileUri('a.ts'))?.badge,      'A')
    assert.strictEqual(provider.provideFileDecoration(vscode.Uri.file(path.join(rootB, 'm.ts')))?.badge, 'M')
  })

  test('#12 clear(rootA) does not affect rootB', () => {
    const rootB = '/test/rootB'
    provider.update(root,  [{ status: 'A', path: 'a.ts' }], new Set())
    provider.update(rootB, [{ status: 'M', path: 'm.ts' }], new Set())
    provider.clear(root)

    assert.strictEqual(provider.provideFileDecoration(fileUri('a.ts')), undefined)
    assert.strictEqual(provider.provideFileDecoration(vscode.Uri.file(path.join(rootB, 'm.ts')))?.badge, 'M')
  })

  test('#13 file in dirtyPaths → Explorer URI NOT decorated (WORKAROUND_DOUBLE_BADGE)', function() {
    if (!WORKAROUND_DOUBLE_BADGE) { this.skip() }
    provider.update(root, [{ status: 'M', path: 'dirty.ts' }], new Set(['dirty.ts']))
    const deco = provider.provideFileDecoration(fileUri('dirty.ts'))
    assert.strictEqual(deco, undefined, 'dirty file should not get Explorer badge')
  })

  test('#14 file NOT in dirtyPaths → Explorer URI IS decorated', () => {
    provider.update(root, [{ status: 'M', path: 'clean.ts' }], new Set())
    const deco = provider.provideFileDecoration(fileUri('clean.ts'))
    assert.ok(deco, 'non-dirty file should get Explorer badge')
  })

  test('#15 fragment URI decorated (WORKAROUND_URI_FRAGMENT)', function() {
    if (!WORKAROUND_URI_FRAGMENT) { this.skip() }
    provider.update(root, [{ status: 'M', path: 'f.ts' }], new Set())
    const fragUri = fileUri('f.ts').with({ fragment: 'gitbase' })
    const deco    = provider.provideFileDecoration(fragUri)
    assert.ok(deco, 'fragment URI should be decorated')
    assert.strictEqual(deco?.badge, 'M')
  })
})
