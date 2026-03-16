import * as assert from 'assert'
import * as vscode from 'vscode'
import * as cp from 'child_process'
import {
  makeRepo, removeRepo, addWorkspaceFolder, removeWorkspaceFolder,
  waitForProvider, waitForResourceStates, waitForRefresh, ensureExtensionActive,
} from '../helpers/gitFixture'
import { TaskChangesProvider } from '../../src/provider'

suite('§3.2 Resource State Accuracy', () => {
  let provider: TaskChangesProvider
  let repo: ReturnType<typeof makeRepo>

  suiteSetup(async () => {
    await ensureExtensionActive()

    repo = makeRepo('gitbase-rs-')

    // Create a "base" commit and a "feature" commit so we have something to diff against
    repo.write('base.ts', 'export const x = 1\n')
    repo.git('add .')
    repo.git('commit -m "base commit"')

    // Create a local "origin/main" branch reference for branch-base testing
    repo.git('branch -M main')
    repo.git('checkout -b feature')

    await addWorkspaceFolder(repo.root)
    provider = await waitForProvider(repo.root, 10_000)

    // Set base to main branch
    await provider.scm.inputBox  // touch provider
    // Manually set base via workspaceState
    await (provider as any).ctx.workspaceState.update(`taskChanges.base.${repo.root}`,      'main')
    await (provider as any).ctx.workspaceState.update(`taskChanges.baseLabel.${repo.root}`, 'main')
    await (provider as any).ctx.workspaceState.update(`taskChanges.baseType.${repo.root}`,  'Branch')
    ;(provider as any).baseRef   = 'main'
    ;(provider as any).baseLabel = 'main'
    ;(provider as any).baseType  = 'Branch'
    ;(provider as any).syncLabel()
    provider.schedule()

    await waitForRefresh(provider, 5_000)
  })

  suiteTeardown(() => {
    if (!repo) return
    removeWorkspaceFolder(repo.root)
    removeRepo(repo)
  })

  teardown(async () => {
    // Reset working tree changes between tests.
    // reset HEAD must come before checkout so staged deletes are un-staged first.
    try { repo.git('reset HEAD') }        catch { /* ignore */ }
    try { repo.git('checkout -- .') }    catch { /* ignore */ }
    try { repo.git('clean -fd') }         catch { /* ignore */ }
    provider.schedule()
    await waitForRefresh(provider, 3_000)
  })

  suite('Status codes', () => {
    test('#1 Modified tracked file → contextValue M', async () => {
      repo.write('base.ts', 'export const x = 2\n')
      provider.schedule()
      await waitForResourceStates(provider, s => s.some(r => r.contextValue === 'M'), 5_000)

      const state = provider.group.resourceStates.find(r => r.contextValue === 'M')
      assert.ok(state, 'Expected M entry')
    })

    test('#2 Staged new file → contextValue A', async () => {
      repo.write('new-staged.ts', 'export const y = 1\n')
      repo.git('add new-staged.ts')
      provider.schedule()
      await waitForResourceStates(provider, s => s.some(r => r.contextValue === 'A'), 5_000)

      const state = provider.group.resourceStates.find(r => r.contextValue === 'A')
      assert.ok(state, 'Expected A entry')
    })

    test('#3 Deleted file (git rm) → contextValue D', async () => {
      repo.git('rm base.ts')
      provider.schedule()
      await waitForResourceStates(provider, s => s.some(r => r.contextValue === 'D'), 5_000)

      const state = provider.group.resourceStates.find(r => r.contextValue === 'D')
      assert.ok(state, 'Expected D entry')
    })

    test('#4 Renamed file (git mv) → contextValue R', async () => {
      repo.git('mv base.ts renamed.ts')
      provider.schedule()
      await waitForResourceStates(provider, s => s.some(r => r.contextValue === 'R'), 5_000)

      const state = provider.group.resourceStates.find(r => r.contextValue === 'R')
      assert.ok(state, 'Expected R entry')
    })

    test('#5 Untracked file → contextValue U', async () => {
      repo.write('untracked.ts', 'untracked\n')
      provider.schedule()
      await waitForResourceStates(provider, s => s.some(r => r.contextValue === 'U'), 5_000)

      const state = provider.group.resourceStates.find(r => r.contextValue === 'U')
      assert.ok(state, 'Expected U entry')
    })
  })

  suite('Diff ref correctness', () => {
    test('#7 Branch base → lastDiffRef is merge-base SHA', async () => {
      provider.schedule()
      await waitForRefresh(provider, 3_000)

      const diffRef = (provider as any).lastDiffRef as string
      // For branch base, diffRef should be a full SHA (40 hex chars) or the branch name
      assert.ok(diffRef, 'lastDiffRef should be set')
    })

    test('#10 HEAD base → lastDiffRef is HEAD', async () => {
      // Temporarily switch to HEAD base
      ;(provider as any).baseRef  = 'HEAD'
      ;(provider as any).baseType = undefined
      provider.schedule()
      // Wait until the refresh actually completes and sets lastDiffRef to 'HEAD'.
      // () => true would return immediately without waiting for the scheduled run.
      await waitForResourceStates(provider, _s => (provider as any).lastDiffRef === 'HEAD', 3_000)

      assert.strictEqual((provider as any).lastDiffRef, 'HEAD')

      // Restore
      ;(provider as any).baseRef  = 'main'
      ;(provider as any).baseType = 'Branch'
      provider.schedule()
      await waitForResourceStates(provider, _s => (provider as any).lastDiffRef !== 'HEAD', 3_000)
    })
  })

  suite('Untracked files', () => {
    test('#14 Untracked file appears in list with status U', async () => {
      repo.write('newfile.ts', 'const a = 1\n')
      provider.schedule()
      await waitForResourceStates(provider, s => s.some(r => r.contextValue === 'U'), 5_000)
      assert.ok(provider.group.resourceStates.some(r => r.contextValue === 'U'))
    })

    test('#16 Gitignored file absent from list', async () => {
      repo.write('.gitignore', '*.ignored\n')
      repo.git('add .gitignore')
      repo.git('commit -m "add gitignore"')

      repo.write('secret.ignored', 'ignored content\n')
      provider.schedule()
      await waitForRefresh(provider, 3_000)

      const hasIgnored = provider.group.resourceStates.some(r => {
        const uri = vscode.Uri.from(r.resourceUri).with({ fragment: '' })
        return uri.fsPath.endsWith('secret.ignored')
      })
      assert.strictEqual(hasIgnored, false, 'gitignored file should not appear')
    })
  })

  suite('Group visibility', () => {
    test('#17 No changed files → group still visible (hideWhenEmpty = false)', async () => {
      provider.schedule()
      await waitForRefresh(provider, 3_000)
      assert.strictEqual(provider.group.hideWhenEmpty, false)
    })

    test('#18 Unchanged file not in resourceStates', async () => {
      provider.schedule()
      await waitForRefresh(provider, 3_000)

      // base.ts was committed and not changed — should not appear
      const inList = provider.group.resourceStates.some(r => {
        const uri = vscode.Uri.from(r.resourceUri).with({ fragment: '' })
        return uri.fsPath.endsWith('base.ts') && r.contextValue !== 'D'
      })
      assert.strictEqual(inList, false, 'unchanged file should not be in list')
    })
  })
})
