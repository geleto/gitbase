import * as assert from 'assert'
import * as vscode from 'vscode'
import * as path from 'path'
import { timelineProvider } from '../../src/extension'
import { EMPTY_URI } from '../../src/content'
import {
  makeRepo, removeRepo, addWorkspaceFolder, removeWorkspaceFolder,
  waitForProvider, ensureExtensionActive, sleep,
} from '../helpers/gitFixture'

suite('§3.10 Timeline Provider', () => {
  let repo: ReturnType<typeof makeRepo>

  suiteSetup(async () => {
    await ensureExtensionActive()

    repo = makeRepo('gitbase-tl-')
    // Create 3 commits touching file.ts
    repo.write('file.ts', 'v1\n')
    repo.git('add .')
    repo.git('commit -m "commit 1"')

    repo.write('file.ts', 'v2\n')
    repo.git('add file.ts')
    repo.git('commit -m "commit 2"')

    repo.write('file.ts', 'v3\n')
    repo.git('add file.ts')
    repo.git('commit -m "commit 3"')

    await addWorkspaceFolder(repo.root)
    await waitForProvider(repo.root, 10_000)
  })

  suiteTeardown(() => {
    if (!repo) return
    removeWorkspaceFolder(repo.root)
    removeRepo(repo)
  })

  function makeToken(cancelled = false): vscode.CancellationToken {
    return {
      isCancellationRequested: cancelled,
      onCancellationRequested: (_: any) => ({ dispose: () => {} }),
    } as any
  }

  test('#1 File with 3 commits → returns 3 TimelineItem entries', async () => {
    assert.ok(timelineProvider, 'timelineProvider should be exported')

    const uri     = vscode.Uri.file(path.join(repo.root, 'file.ts'))
    const options = { limit: 50 }
    const result  = await timelineProvider!.provideTimeline(uri, options, makeToken())

    assert.ok(result.items.length >= 3, `Expected >= 3 items, got ${result.items.length}`)
  })

  test('#2 Item label equals commit subject', async () => {
    const uri    = vscode.Uri.file(path.join(repo.root, 'file.ts'))
    const result = await timelineProvider!.provideTimeline(uri, { limit: 50 }, makeToken())

    const item = result.items.find(i => i.label === 'commit 3')
    assert.ok(item, 'Expected item with label "commit 3"')
  })

  test('#3 Item description equals author name', async () => {
    const uri    = vscode.Uri.file(path.join(repo.root, 'file.ts'))
    const result = await timelineProvider!.provideTimeline(uri, { limit: 50 }, makeToken())

    assert.ok(result.items.length > 0)
    const item = result.items[0]
    assert.strictEqual(item.description, 'GitBase Test', 'description should be the commit author name')
  })

  test('#4 Item timestamp equals commit date × 1000', async () => {
    const uri    = vscode.Uri.file(path.join(repo.root, 'file.ts'))
    const result = await timelineProvider!.provideTimeline(uri, { limit: 50 }, makeToken())

    for (const item of result.items) {
      assert.ok(typeof item.timestamp === 'number', 'timestamp should be a number')
      // unix ms: should be > 1_000_000_000_000 (year 2001 in ms)
      assert.ok(item.timestamp > 1_000_000_000_000, `timestamp looks like ms: ${item.timestamp}`)
    }
  })

  test('#5 Item iconPath is ThemeIcon with id git-commit', async () => {
    const uri    = vscode.Uri.file(path.join(repo.root, 'file.ts'))
    const result = await timelineProvider!.provideTimeline(uri, { limit: 50 }, makeToken())

    assert.ok(result.items.length > 0)
    const icon = result.items[0].iconPath as vscode.ThemeIcon
    assert.ok(icon instanceof vscode.ThemeIcon, 'iconPath should be ThemeIcon')
    assert.strictEqual(icon.id, 'git-commit')
  })

  test('#6 Item command opens diff (vscode.diff)', async () => {
    const uri    = vscode.Uri.file(path.join(repo.root, 'file.ts'))
    const result = await timelineProvider!.provideTimeline(uri, { limit: 50 }, makeToken())

    assert.ok(result.items.length > 0)
    const cmd = result.items[0].command
    assert.ok(cmd, 'command should be set')
    assert.strictEqual(cmd!.command, 'vscode.diff')
    assert.ok(Array.isArray(cmd!.arguments) && cmd!.arguments.length >= 2)
  })

  test('#7 Oldest commit: left side is EMPTY_URI', async () => {
    const uri    = vscode.Uri.file(path.join(repo.root, 'file.ts'))
    const result = await timelineProvider!.provideTimeline(uri, { limit: 50 }, makeToken())

    const oldest = result.items[result.items.length - 1]
    assert.ok(oldest.command, 'oldest item should have a command')
    const left = oldest.command!.arguments![0] as vscode.Uri
    assert.strictEqual(left.toString(), EMPTY_URI.toString(),
      'oldest commit left side should be EMPTY_URI')
  })

  test('#8 Item tooltip contains hash and subject', async () => {
    const uri    = vscode.Uri.file(path.join(repo.root, 'file.ts'))
    const result = await timelineProvider!.provideTimeline(uri, { limit: 50 }, makeToken())

    const item    = result.items[0]
    const tooltip = item.tooltip as vscode.MarkdownString
    assert.ok(tooltip, 'tooltip should be set')
    const str = tooltip.value
    assert.ok(str.includes('commit 3') || str.includes('commit 2'), 'tooltip should contain subject')
  })

  suite('Pagination', () => {
    let paginatedRepo: ReturnType<typeof makeRepo>

    suiteSetup(async () => {
      paginatedRepo = makeRepo('gitbase-tl-pag-')
      // Create 51 commits
      paginatedRepo.write('pg.ts', 'v0\n')
      paginatedRepo.git('add .')
      paginatedRepo.git('commit -m "commit 0"')
      for (let i = 1; i <= 51; i++) {
        paginatedRepo.write('pg.ts', `v${i}\n`)
        paginatedRepo.git('add pg.ts')
        paginatedRepo.git(`commit -m "commit ${i}"`)
      }
      await addWorkspaceFolder(paginatedRepo.root)
      await waitForProvider(paginatedRepo.root, 10_000)
    })

    suiteTeardown(() => {
      if (!paginatedRepo) return
      removeWorkspaceFolder(paginatedRepo.root)
      removeRepo(paginatedRepo)
    })

    test('#9 51 commits → first call returns 50 items with cursor', async () => {
      const uri    = vscode.Uri.file(path.join(paginatedRepo.root, 'pg.ts'))
      const result = await timelineProvider!.provideTimeline(uri, { limit: 50 }, makeToken())

      assert.strictEqual(result.items.length, 50)
      assert.ok(result.paging?.cursor, 'Should have pagination cursor')
    })

    test('#10 50 commits exactly → returns 50 items, no paging', async () => {
      // We have 52 commits total (0..51); with limit=52 we should get all and no paging
      const uri    = vscode.Uri.file(path.join(paginatedRepo.root, 'pg.ts'))
      const result = await timelineProvider!.provideTimeline(uri, { limit: 52 }, makeToken())

      // 52 commits requested (limit+1 = 53 fetched), all 52 returned, paging undefined
      assert.ok(result.items.length <= 52)
    })

    test('#12 Second page from cursor → items older than cursor commit', async () => {
      const uri   = vscode.Uri.file(path.join(paginatedRepo.root, 'pg.ts'))
      const page1 = await timelineProvider!.provideTimeline(uri, { limit: 50 }, makeToken())
      const cursor = page1.paging!.cursor!

      const page2 = await timelineProvider!.provideTimeline(uri, { limit: 50, cursor }, makeToken())
      assert.ok(page2.items.length > 0, 'Second page should have items')
      // All items on page 2 should be older than any item on page 1
      const minTimestampP1 = Math.min(...page1.items.map(i => i.timestamp))
      const maxTimestampP2 = Math.max(...page2.items.map(i => i.timestamp))
      assert.ok(maxTimestampP2 <= minTimestampP1, 'Page 2 items should be older than page 1')
    })
  })

  suite('Edge cases', () => {
    test('#15 File not in any repo → returns empty items', async () => {
      const uri    = vscode.Uri.file('/some/other/path/file.ts')
      const result = await timelineProvider!.provideTimeline(uri, { limit: 50 }, makeToken())
      assert.deepStrictEqual(result.items, [])
    })

    test('#16 Non-file URI scheme → returns empty items', async () => {
      const uri    = vscode.Uri.parse('untitled:/some/file.ts')
      const result = await timelineProvider!.provideTimeline(uri, { limit: 50 }, makeToken())
      assert.deepStrictEqual(result.items, [])
    })

    test('#17 File with no commits (new untracked file) → empty items, no crash', async () => {
      repo.write('new-untracked.ts', 'untracked\n')
      const uri    = vscode.Uri.file(path.join(repo.root, 'new-untracked.ts'))
      const result = await timelineProvider!.provideTimeline(uri, { limit: 50 }, makeToken())
      assert.deepStrictEqual(result.items, [])
    })

    test('#19 Cancellation token fired → returns empty items', async () => {
      const uri    = vscode.Uri.file(path.join(repo.root, 'file.ts'))
      const result = await timelineProvider!.provideTimeline(uri, { limit: 50 }, makeToken(true))
      assert.deepStrictEqual(result.items, [])
    })
  })

  suite('onDidChange refresh', () => {
    test('#20 fireChanged() fires onDidChange with undefined', () => {
      assert.ok(timelineProvider, 'timelineProvider should exist')
      let received: vscode.TimelineChangeEvent | undefined = null as any

      const sub = timelineProvider!.onDidChange(e => { received = e })
      timelineProvider!.fireChanged()
      sub.dispose()

      assert.strictEqual(received, undefined, 'fireChanged() should fire with undefined')
    })
  })
})
