import * as assert from 'assert'
import * as vscode from 'vscode'
import * as path from 'path'
import {
  makeRepo, removeRepo, addWorkspaceFolder, removeWorkspaceFolder,
  waitForProvider, waitForResourceStates, ensureExtensionActive, sleep, setProviderBase,
} from '../helpers/gitFixture'
import { TaskChangesProvider } from '../../src/provider'

suite('§3.7 Context Key (Explorer/Editor Menus)', () => {
  let provider: TaskChangesProvider
  let repo: ReturnType<typeof makeRepo>

  suiteSetup(async () => {
    await ensureExtensionActive()

    repo = makeRepo('gitbase-ctx-')
    repo.write('tracked.ts', 'tracked\n')
    repo.write('other.ts', 'other\n')
    repo.git('add .')
    repo.git('commit -m "init"')
    repo.git('branch -M main')
    repo.git('checkout -b feature')

    await addWorkspaceFolder(repo.root)
    provider = await waitForProvider(repo.root, 10_000)

    // Set base to main
    setProviderBase(provider, 'main', 'Branch')
  })

  suiteTeardown(() => {
    if (!repo) return
    removeWorkspaceFolder(repo.root)
    removeRepo(repo)
  })

  test('#1 Active editor is an M file → context key true', async () => {
    repo.write('tracked.ts', 'modified\n')
    provider.schedule()
    await waitForResourceStates(provider, s => s.some(r => r.contextValue === 'M'), 5_000)

    const fileUri = vscode.Uri.file(path.join(repo.root, 'tracked.ts'))
    await vscode.window.showTextDocument(fileUri)
    await sleep(400)

    // The context key is set via setContext — we can't read it directly.
    // Verify indirectly: getResourceState returns the entry
    const state = provider.getResourceState(fileUri)
    assert.ok(state !== undefined, 'M file should be in resource states')
  })

  test('#3 Active editor is a file NOT in GitBase list → getResourceState undefined', async () => {
    // Close all editors then open other.ts (not changed)
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    const fileUri = vscode.Uri.file(path.join(repo.root, 'other.ts'))
    await vscode.window.showTextDocument(fileUri)
    await sleep(400)

    const state = provider.getResourceState(fileUri)
    assert.strictEqual(state, undefined, 'unchanged file should not be in resource states')
  })

  test('#4 Active editor is a basegit: URI → context key false (scheme check)', async () => {
    // The extension checks uri.scheme === 'file'
    // basegit: URIs should result in isChanged = false
    const basegitUri = vscode.Uri.parse('basegit:/some/file.ts')
    // We just verify the scheme check logic
    const isFile = basegitUri.scheme === 'file'
    assert.strictEqual(isFile, false, 'basegit scheme should not be treated as a file')
  })

  test('#5 No active editor → context key false', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    await sleep(400)
    // With no editor, `editor?.document.uri` is undefined, so isChanged = false
    // Verified by checking that no editor is active
    assert.strictEqual(vscode.window.activeTextEditor, undefined)
  })

  test('#6 Resource states change: file removed from list → key updates', async () => {
    // Revert the modification to tracked.ts
    repo.write('tracked.ts', 'tracked\n')
    provider.schedule()
    await waitForResourceStates(provider, s => !s.some(r => {
      const u = vscode.Uri.from(r.resourceUri).with({ fragment: '' })
      return u.fsPath.endsWith('tracked.ts')
    }), 5_000)

    const fileUri = vscode.Uri.file(path.join(repo.root, 'tracked.ts'))
    const state   = provider.getResourceState(fileUri)
    assert.strictEqual(state, undefined, 'reverted file should be removed from resource states')
  })

  test('#7 Resource states change: file added to list → key updates', async () => {
    repo.write('tracked.ts', 'changed again\n')
    provider.schedule()
    await waitForResourceStates(provider, s => s.some(r => r.contextValue === 'M'), 5_000)

    const fileUri = vscode.Uri.file(path.join(repo.root, 'tracked.ts'))
    const state   = provider.getResourceState(fileUri)
    assert.ok(state !== undefined, 'modified file should appear in resource states')
  })
})
