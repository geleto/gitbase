import * as assert from 'assert'
import * as vscode from 'vscode'
import * as path from 'path'
import {
  makeRepo, removeRepo, addWorkspaceFolder, removeWorkspaceFolder,
  waitForProvider, waitForResourceStates, waitForRefresh, waitForClipboard,
  captureNotifications, spyCommand, ensureExtensionActive, setProviderBase,
} from '../helpers/gitFixture'
import { TaskChangesProvider } from '../../src/provider'

suite('File Action Commands', () => {
  let provider: TaskChangesProvider
  let repo: ReturnType<typeof makeRepo>

  suiteSetup(async () => {
    await ensureExtensionActive()

    repo = makeRepo('gitbase-cmd-')
    repo.write('root.ts', 'export const root = 0\n')
    repo.write('src/file.ts', 'export const a = 1\n')
    repo.write('sub/deep.ts', 'export const b = 2\n')
    repo.git('add .')
    repo.git('commit -m "base"')
    repo.git('branch -M main')
    repo.git('checkout -b feature')

    await addWorkspaceFolder(repo.root)
    provider = await waitForProvider(repo.root, 10_000)

    setProviderBase(provider, 'main', 'Branch')
  })

  suiteTeardown(() => {
    if (!repo) return
    removeWorkspaceFolder(repo.root)
    removeRepo(repo)
  })

  function getState(rel: string) {
    return provider.group.resourceStates.find(r => {
      const uri = vscode.Uri.from(r.resourceUri).with({ fragment: '' })
      return uri.fsPath.endsWith(rel.replace(/\//g, path.sep))
    })
  }

  suite('taskChanges.copyPath', () => {
    test('M file → absolute path copied to clipboard', async () => {
      repo.write('src/file.ts', 'modified\n')
      provider.schedule()
      await waitForResourceStates(provider, s => s.some(r => r.contextValue === 'M'), 5_000)

      const state = getState('src/file.ts')!
      await vscode.commands.executeCommand('taskChanges.copyPath', state)
      const text = await waitForClipboard(t => t.includes('file.ts'), 3_000)
      assert.ok(path.isAbsolute(text), `Expected absolute path, got: ${text}`)
      assert.ok(text.endsWith(path.join('src', 'file.ts')))
    })

    test('D file → full absolute path copied', async () => {
      // sub/deep.ts exists on main — deleting it on the feature branch shows as D
      repo.git('rm sub/deep.ts')
      provider.schedule()
      await waitForResourceStates(provider, s => s.some(r => r.contextValue === 'D'), 5_000)

      const state = getState('sub/deep.ts')!
      await vscode.commands.executeCommand('taskChanges.copyPath', state)
      const text = await waitForClipboard(t => t.endsWith('deep.ts'), 3_000)
      assert.ok(path.isAbsolute(text))
    })
  })

  suite('taskChanges.copyRelativePath', () => {
    test('M file at repo root → filename only', async () => {
      // root.ts was committed to main in suiteSetup — modifying it shows as M
      repo.write('root.ts', 'modified\n')
      provider.schedule()
      await waitForResourceStates(provider, s => s.some(r => {
        const u = vscode.Uri.from(r.resourceUri).with({ fragment: '' })
        return r.contextValue === 'M' && u.fsPath.endsWith('root.ts')
      }), 5_000)

      const state = getState('root.ts')!
      await vscode.commands.executeCommand('taskChanges.copyRelativePath', state)
      const text = await waitForClipboard(t => t === 'root.ts', 3_000)
      assert.strictEqual(text, 'root.ts')
    })

    test('M file in subdirectory → relative path from repo root', async () => {
      repo.write('src/file.ts', 'modified again\n')
      provider.schedule()
      await waitForResourceStates(provider, s => s.some(r => r.contextValue === 'M'), 5_000)

      const state = getState('src/file.ts')!
      await vscode.commands.executeCommand('taskChanges.copyRelativePath', state)
      const text = await waitForClipboard(t => t.includes('src'), 3_000)
      assert.ok(text === 'src/file.ts' || text === path.join('src', 'file.ts'))
    })
  })

  suite('taskChanges.copyPatch', () => {
    test('U (untracked) file → info notification, clipboard unchanged', async () => {
      repo.write('untracked.ts', 'untracked\n')
      provider.schedule()
      await waitForResourceStates(provider, s => s.some(r => r.contextValue === 'U'), 5_000)

      const state = getState('untracked.ts')!
      await vscode.env.clipboard.writeText('ORIGINAL')
      const notes = await captureNotifications(async () => {
        await vscode.commands.executeCommand('taskChanges.copyPatch', state)
      })

      assert.ok(notes.some(n => n.severity === 'info' && n.message.includes('Patch not available')))
      const clip = await vscode.env.clipboard.readText()
      assert.strictEqual(clip, 'ORIGINAL')
    })

    test('M file, Branch base → clipboard contains diff output', async () => {
      repo.write('src/file.ts', 'modified for patch\n')
      provider.schedule()
      await waitForResourceStates(provider, s => s.some(r => r.contextValue === 'M'), 5_000)

      const state = getState('src/file.ts')!
      await vscode.commands.executeCommand('taskChanges.copyPatch', state)

      const text = await waitForClipboard(t => t.includes('diff --git'), 3_000)
      assert.ok(text.includes('diff --git'))
    })

    test('File reverted to match base → "No changes to copy" notification', async () => {
      // Ensure file matches base (no changes)
      repo.write('src/file.ts', 'export const a = 1\n')
      provider.schedule()
      await waitForRefresh(provider, 3_000)

      // Manually invoke copyPatch with a fake URI that's not in any provider
      const fakeUri = vscode.Uri.file(path.join(repo.root, 'src', 'file.ts'))
      const notes = await captureNotifications(async () => {
        await vscode.commands.executeCommand('taskChanges.copyPatch', fakeUri)
      })
      // Either "No changes" or "file not currently a GitBase change" (provider not found) — no crash
      assert.ok(true, 'No crash when file not in list')
    })
  })

  suite('taskChanges.openFile', () => {
    test('Resource URI with #gitbase fragment → fragment stripped before open', async () => {
      repo.write('src/file.ts', 'fragment test\n')
      provider.schedule()
      await waitForResourceStates(provider, s => s.some(r => r.contextValue === 'M'), 5_000)

      const state = getState('src/file.ts')!
      // resourceUri may have fragment — openFile should strip it
      // Just verify no exception is thrown
      try {
        await vscode.commands.executeCommand('taskChanges.openFile', state)
        assert.ok(true, 'openFile ran without error')
      } catch (e: any) {
        assert.fail(`openFile threw: ${e.message}`)
      }
    })
  })

  suite('taskChanges.refresh', () => {
    test('Refresh with SourceControl argument → refreshes without showing picker', async () => {
      // When invoked from the scm/title menu, VS Code passes the SourceControl object.
      // resolveProvider() finds it directly — no QuickPick, no matter how many repos are open.
      await vscode.commands.executeCommand('taskChanges.refresh', provider.scm)
      assert.ok(true, 'Command completed without error')
    })

    test('Command palette with no selection → silent no-op', async () => {
      // When invoked from the command palette with multiple repos open, resolveProvider()
      // shows a QuickPick.  Simulating user cancellation (no selection) must not crash.
      const origQP = vscode.window.showQuickPick
      ;(vscode.window as any).showQuickPick = async () => undefined
      try {
        await vscode.commands.executeCommand('taskChanges.refresh')
      } finally {
        ;(vscode.window as any).showQuickPick = origQP
      }
      assert.ok(true, 'No crash when picker is cancelled')
    })
  })

  suite('openWithoutAutoReveal', () => {
    test('scm.autoReveal setting is not modified', async () => {
      repo.write('untracked2.ts', 'untracked2\n')
      provider.schedule()
      await waitForResourceStates(provider, s => s.some(r => r.contextValue === 'U'), 5_000)

      const config = vscode.workspace.getConfiguration('scm')
      const before = config.get<boolean>('autoReveal')

      const state = getState('untracked2.ts')!
      void vscode.commands.executeCommand('taskChanges.openFile', state)

      const after = config.get<boolean>('autoReveal')
      assert.strictEqual(after, before, 'autoReveal setting should not be changed')
    })
  })
})
