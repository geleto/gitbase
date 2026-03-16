import * as assert from 'assert'
import * as vscode from 'vscode'
import * as path from 'path'
import { makeBaseUri, parseBaseUri, EMPTY_URI, EmptyContentProvider } from '../../src/content'
import {
  makeRepo, removeRepo, addWorkspaceFolder, removeWorkspaceFolder,
  waitForProvider, waitForResourceStates, waitForRefresh, ensureExtensionActive,
  setProviderBase, getProviderBase,
} from '../helpers/gitFixture'
import { TaskChangesProvider } from '../../src/provider'

suite('§3.4 Diff Content Correctness', () => {
  let provider: TaskChangesProvider
  let repo: ReturnType<typeof makeRepo>
  let baseCommitSha: string

  suiteSetup(async () => {
    await ensureExtensionActive()

    repo = makeRepo('gitbase-diff-')
    repo.write('hello.ts', 'export const msg = "hello"\n')
    repo.git('add .')
    repo.git('commit -m "initial"')
    baseCommitSha = repo.git('rev-parse HEAD')

    repo.git('branch -M main')
    repo.git('checkout -b feature')

    repo.write('hello.ts', 'export const msg = "world"\n')
    repo.git('add .')
    repo.git('commit -m "modify hello"')

    await addWorkspaceFolder(repo.root)
    provider = await waitForProvider(repo.root, 10_000)

    setProviderBase(provider, 'main', 'Branch')
    provider.schedule()
    await waitForRefresh(provider, 5_000)
  })

  suiteTeardown(() => {
    if (!repo) return
    removeWorkspaceFolder(repo.root)
    removeRepo(repo)
  })

  test('#1 provideTextDocumentContent for M file matches git show', async () => {
    const fp  = 'hello.ts'
    const uri = makeBaseUri(repo.root, baseCommitSha, fp)

    const doc = await vscode.workspace.openTextDocument(uri)
    const content = doc.getText()

    assert.ok(content.includes('hello'), `Expected base content to contain "hello", got: ${content}`)
    assert.ok(!content.includes('world'), `Expected base content NOT to contain "world"`)
  })

  test('#4 File that did not exist at ref → placeholder message', async () => {
    const fp  = 'nonexistent.ts'
    const uri = makeBaseUri(repo.root, baseCommitSha, fp)

    const doc = await vscode.workspace.openTextDocument(uri)
    const content = doc.getText()

    assert.ok(
      content.includes('did not exist') || content.includes('not exist') || content === '',
      `Expected placeholder or empty, got: ${content}`,
    )
  })

  test('#7b EmptyContentProvider returns empty string', async () => {
    const emptyProvider = new EmptyContentProvider()
    const content = emptyProvider.provideTextDocumentContent()
    assert.strictEqual(content, '')
  })

  test('#8 provideOriginalResource returns undefined for non-file URI', () => {
    const uri    = vscode.Uri.parse('git:/some/path')
    const result = provider.provideOriginalResource(uri)
    assert.strictEqual(result, undefined)
  })

  test('#9 provideOriginalResource returns undefined when base = HEAD', () => {
    const savedRef = getProviderBase(provider)
    setProviderBase(provider, 'HEAD', undefined)

    const uri    = vscode.Uri.file(path.join(repo.root, 'hello.ts'))
    const result = provider.provideOriginalResource(uri)

    setProviderBase(provider, savedRef, 'Branch')
    assert.strictEqual(result, undefined)
  })

  test('#10 provideOriginalResource returns basegit: URI for M file', async () => {
    provider.schedule()
    await waitForResourceStates(provider, s => s.some(r => r.contextValue === 'M'), 5_000)

    const uri    = vscode.Uri.file(path.join(repo.root, 'hello.ts'))
    const result = provider.provideOriginalResource(uri)

    assert.ok(result, 'Expected basegit: URI for M file')
    assert.strictEqual(result!.scheme, 'basegit')

    const { root, fp } = parseBaseUri(result!)
    assert.strictEqual(root, repo.root)
    assert.strictEqual(fp, 'hello.ts')
  })

  test('#11 provideOriginalResource returns undefined for U files', async () => {
    // Write an untracked file
    repo.write('untracked.ts', 'u\n')
    provider.schedule()
    await waitForResourceStates(provider, s => s.some(r => r.contextValue === 'U'), 5_000)

    const uri    = vscode.Uri.file(path.join(repo.root, 'untracked.ts'))
    const result = provider.provideOriginalResource(uri)
    assert.strictEqual(result, undefined, 'U files should not have an original resource')
  })

  test('#11b provideOriginalResource returns undefined for D files', async () => {
    // hello.ts exists on main — deleting it on the feature branch shows as D relative to main
    repo.git('rm hello.ts')
    provider.schedule()
    await waitForResourceStates(provider, s => s.some(r => r.contextValue === 'D'), 5_000)

    const uri    = vscode.Uri.file(path.join(repo.root, 'hello.ts'))
    const result = provider.provideOriginalResource(uri)
    assert.strictEqual(result, undefined, 'D files should not have an original resource for QuickDiff')
  })

  test('#12 provideOriginalResource returns undefined for file outside repo', () => {
    const uri    = vscode.Uri.file('/some/other/path/file.ts')
    const result = provider.provideOriginalResource(uri)
    assert.strictEqual(result, undefined)
  })
})
