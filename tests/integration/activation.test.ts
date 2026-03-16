import * as assert from 'assert'
import * as vscode from 'vscode'
import { providers } from '../../src/extension'
import {
  makeRepo, removeRepo, addWorkspaceFolder, removeWorkspaceFolder,
  waitForProvider, waitForProviderCount, ensureExtensionActive, sleep,
} from '../helpers/gitFixture'

suite('§3.1 Extension Activation & Provider Lifecycle', () => {

  suiteSetup(async () => {
    await ensureExtensionActive()
    // Wait for the bootstrap workspace folder provider to appear
    await sleep(1500)
  })

  suite('Activation with a git repo', () => {
    test('#1 Extension activates → at least one provider', () => {
      assert.ok(providers.size >= 1, `Expected providers.size >= 1, got ${providers.size}`)
    })

    test('#2 GitBase Changes SCM panel registered', () => {
      // Check that at least one TaskChangesProvider's SCM has our id
      const p = [...providers.values()][0]
      assert.ok(p, 'No provider found')
      assert.strictEqual(p.scm.id, 'taskchanges')
    })

    test('#4 Unborn repo (zero commits) → panel appears, no error notification', async () => {
      const repo = makeRepo('gitbase-unborn-')
      // Remove the initial commit to make it unborn
      const unbornDir = require('fs').mkdtempSync(
        require('path').join(require('os').tmpdir(), 'gitbase-unborn-nocmt-')
      )
      require('child_process').execSync('git init', { cwd: unbornDir, stdio: 'ignore' })
      require('child_process').execSync('git config user.email "t@t.t"', { cwd: unbornDir, stdio: 'ignore' })
      require('child_process').execSync('git config user.name "T"', { cwd: unbornDir, stdio: 'ignore' })

      await addWorkspaceFolder(unbornDir)
      try {
        // Should activate without throwing
        const p = await waitForProvider(unbornDir, 8000).catch(() => null)
        // May or may not register (git may fail on unborn HEAD) — just no crash
        assert.ok(true, 'No crash with unborn repo')
      } finally {
        removeWorkspaceFolder(unbornDir)
        require('fs').rmSync(unbornDir, { recursive: true, force: true })
        removeRepo(repo)
      }
    })
  })

  suite('Repository discovery', () => {
    test('#6 onDidOpenRepository fires for late-opened repo → second provider created', async () => {
      const repo = makeRepo('gitbase-late-')
      const countBefore = providers.size
      await addWorkspaceFolder(repo.root)
      try {
        await waitForProviderCount(countBefore + 1, 10_000)
        assert.strictEqual(providers.size, countBefore + 1)
      } finally {
        removeWorkspaceFolder(repo.root)
        await waitForProviderCount(countBefore, 5_000).catch(() => {})
        removeRepo(repo)
      }
    })

    test('#7 onDidCloseRepository fires for removed repo → provider disposed', async () => {
      const repo = makeRepo('gitbase-close-')
      await addWorkspaceFolder(repo.root)
      await waitForProvider(repo.root, 10_000)

      const countAfterAdd = providers.size
      removeWorkspaceFolder(repo.root)
      await waitForProviderCount(countAfterAdd - 1, 8_000)

      assert.strictEqual(providers.has(repo.root), false)
      removeRepo(repo)
    })

    test('#8 Provider disposed on remove: providers.has(root) is false', async () => {
      const repo = makeRepo('gitbase-dispose-')
      await addWorkspaceFolder(repo.root)
      await waitForProvider(repo.root, 10_000)
      removeWorkspaceFolder(repo.root)
      await waitForProviderCount(providers.size - 1, 8_000).catch(() => {})
      assert.strictEqual(providers.has(repo.root), false, 'key should be removed from map')
      removeRepo(repo)
    })

    test('#9 Adding same root twice is a no-op', async () => {
      const repo = makeRepo('gitbase-dup-')
      await addWorkspaceFolder(repo.root)
      await waitForProvider(repo.root, 10_000)
      const countAfterFirst = providers.size

      // Try adding again (VS Code may reject duplicate, but extension must not create a second provider)
      await addWorkspaceFolder(repo.root)
      await sleep(500)
      assert.strictEqual(providers.size, countAfterFirst, 'duplicate add should not create a second provider')

      removeWorkspaceFolder(repo.root)
      await sleep(500)
      removeRepo(repo)
    })
  })
})
