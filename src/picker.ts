import * as vscode from 'vscode'
import * as https from 'https'
import { gitOrNull, detectDefaultBranch, detectRefType } from './git'

export interface BaseSelection {
  readonly ref:      string
  readonly label:    string
  readonly type:     'Branch' | 'Tag' | 'Commit' | 'PR' | undefined
  /** Set when entering GitHub PR full review. Provider fills in prevBase* before persisting. */
  readonly prEnter?: { prevBranch: string; stashed: boolean }
  /** Set when exiting GitHub PR full review. Provider clears the persisted state. */
  readonly prExit?:  true
}

export interface PrReviewState {
  readonly prevBranch:    string
  readonly prevBase:      string
  readonly prevBaseLabel: string
  readonly prevBaseType:  'Branch' | 'Tag' | 'Commit' | undefined
  readonly stashed:       boolean
}

type PrMetaResult = { baseRef: string; headSha: string } | 'auth-required' | undefined

function fetchPrMeta(owner: string, repo: string, prNumber: number, token?: string): Promise<PrMetaResult> {
  return new Promise(resolve => {
    const req = https.get({
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/pulls/${prNumber}`,
      headers: {
        'User-Agent': 'gitbase-vscode',
        Accept: 'application/vnd.github.v3+json',
        ...(token ? { Authorization: `token ${token}` } : {}),
      },
    }, res => {
      if (res.statusCode === 401 || res.statusCode === 404) {
        res.resume()
        resolve('auth-required')
        return
      }
      let data = ''
      res.on('data', (chunk: string) => { data += chunk })
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          resolve(json.base?.ref && json.head?.sha
            ? { baseRef: json.base.ref, headSha: json.head.sha }
            : undefined)
        } catch { resolve(undefined) }
      })
    })
    req.on('error', () => resolve(undefined))
  })
}

async function resolvePrMeta(
  owner: string, repo: string, prNumber: number
): Promise<{ baseRef: string; headSha: string } | undefined> {
  // Try with a silent session first (no UI shown if not signed in).
  let token: string | undefined
  try {
    token = (await vscode.authentication.getSession('github', ['repo'], { silent: true }))?.accessToken
  } catch { /* no session */ }

  let result = await fetchPrMeta(owner, repo, prNumber, token)

  // On auth failure, prompt the user to sign in and retry once.
  if (result === 'auth-required') {
    try {
      token = (await vscode.authentication.getSession('github', ['repo'], { createIfNone: true }))?.accessToken
    } catch { return undefined }
    result = await fetchPrMeta(owner, repo, prNumber, token)
  }

  return result === 'auth-required' ? undefined : result
}

/**
 * Shows a multi-step quick pick to select a base ref.
 * Returns the selection or undefined if the user cancelled.
 */
export async function pickBase(root: string, prReviewState?: PrReviewState): Promise<BaseSelection | undefined> {
  // Run prerequisite queries in parallel before showing the picker.
  const [defaultBranch, unstaged, staged] = await Promise.all([
    detectDefaultBranch(root),
    gitOrNull(root, 'diff', '--quiet'),
    gitOrNull(root, 'diff', '--cached', '--quiet'),
  ])
  const isDirty = unstaged === null || staged === null

  type TypeItem = vscode.QuickPickItem & { key: string }
  const typeItems: TypeItem[] = []

  // Exit item appears at the very top when in PR review mode.
  if (prReviewState) {
    const exitDesc = prReviewState.stashed
      ? `return to ${prReviewState.prevBranch} · pop stash`
      : `return to ${prReviewState.prevBranch}`
    typeItems.push({ label: '← Exit GitHub PR Review', description: exitDesc, key: 'pr-exit' })
    typeItems.push({ label: '', kind: vscode.QuickPickItemKind.Separator, key: '' })
  }

  if (defaultBranch) {
    typeItems.push({ label: 'Default branch', description: defaultBranch, key: 'default' })
    typeItems.push({ label: '', kind: vscode.QuickPickItemKind.Separator, key: '' })
  }
  typeItems.push(
    { label: 'Branch…',    key: 'branch' },
    { label: 'Tag…',       key: 'tag'    },
    { label: 'Commit…',    key: 'commit' },
    { label: 'Enter ref…', key: 'ref'    },
    { label: '', kind: vscode.QuickPickItemKind.Separator, key: '' },
    { label: 'GitHub PR · my work vs target…',   description: 'compare current branch to PR base', key: 'pr-base'   },
    { label: isDirty ? 'GitHub PR · PR changes… (will stash)' : 'GitHub PR · PR changes…',
      description: 'compare PR to its base', key: 'pr-review' },
  )

  const typeItem = await vscode.window.showQuickPick(typeItems, { placeHolder: 'Select base type' })
  if (!typeItem) return undefined

  // ── Exit GitHub PR Review ────────────────────────────────────────────────────
  if (typeItem.key === 'pr-exit' && prReviewState) {
    const ok = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Exiting GitHub PR Review…', cancellable: false },
      async () => {
        if (await gitOrNull(root, 'checkout', prReviewState.prevBranch) === null) return false
        if (prReviewState.stashed) {
          if (await gitOrNull(root, 'stash', 'pop') === null) {
            void vscode.window.showWarningMessage(
              'Your stashed changes could not be restored automatically — they are still safe in the stash. ' +
              'Run "git stash pop" to apply them; if there are conflicts, resolve them then run "git stash drop".',
              'Copy command'
            ).then(action => {
              if (action === 'Copy command') void vscode.env.clipboard.writeText('git stash pop')
            })
          }
        }
        return true
      }
    )
    if (!ok) {
      void vscode.window.showErrorMessage(`Failed to restore previous branch. Run "git checkout ${prReviewState.prevBranch}" manually.`)
      return undefined
    }
    return { ref: prReviewState.prevBase, label: prReviewState.prevBaseLabel, type: prReviewState.prevBaseType, prExit: true }
  }

  // Default branch: detectDefaultBranch already verified the ref.
  if (typeItem.key === 'default') {
    return { ref: defaultBranch!, label: defaultBranch!, type: 'Branch' }
  }

  // ── GitHub Pull Request flows ────────────────────────────────────────────────
  if (typeItem.key === 'pr-base' || typeItem.key === 'pr-review') {
    const prUrl = await vscode.window.showInputBox({
      prompt: 'Enter GitHub Pull Request URL',
      placeHolder: 'https://github.com/owner/repo/pull/123',
      validateInput: val =>
        /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.test(val)
          ? null
          : 'Expected: https://github.com/owner/repo/pull/123',
    })
    if (!prUrl) return undefined

    const m = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)!
    const [, owner, repo, prNumStr] = m
    const prNumber = parseInt(prNumStr, 10)

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `GitHub PR #${prNumber}…`, cancellable: false },
      async () => {
        const meta = await resolvePrMeta(owner, repo, prNumber)
        if (!meta) return undefined

        const { baseRef, headSha } = meta
        const localBase = `origin/${baseRef}`

        if (!await gitOrNull(root, 'rev-parse', '--verify', localBase)) {
          await gitOrNull(root, 'fetch', 'origin', baseRef)
        }

        if (typeItem.key === 'pr-review') {
          const prevBranch = (await gitOrNull(root, 'symbolic-ref', '--short', 'HEAD'))?.trim() ?? 'HEAD'

          let stashed = false
          if (isDirty) {
            stashed = await gitOrNull(root, 'stash', 'push', '-m', 'gitbase: PR review') !== null
          }

          const fetched = await gitOrNull(root, 'fetch', 'origin', `refs/pull/${prNumber}/head`)
          if (fetched === null || await gitOrNull(root, 'checkout', '--detach', headSha) === null) {
            if (stashed) await gitOrNull(root, 'stash', 'pop')
            return 'checkout-failed'
          }

          return { ref: localBase, label: `GitHub PR #${prNumber} · ${owner}/${repo} · PR changes`, type: 'PR' as const, prEnter: { prevBranch, stashed } }
        }

        return { ref: localBase, label: `GitHub PR #${prNumber} · ${owner}/${repo} · my work vs target`, type: 'PR' as const }
      }
    )

    if (result === undefined) {
      void vscode.window.showErrorMessage(`Could not fetch PR #${prNumber} from GitHub. Check the URL and your network connection.`)
      return undefined
    }
    if (result === 'checkout-failed') {
      void vscode.window.showErrorMessage(`Failed to switch to PR #${prNumber}. Ensure origin points to GitHub.`)
      return undefined
    }

    if (!result.prEnter) {
      void vscode.window.showInformationMessage(
        `Base set to PR #${prNumber} target (${result.ref}). For the exact PR diff, use "GitHub PR · PR changes…".`
      )
    }

    return result
  }

  let newRef:   string | undefined
  let newLabel: string | undefined   // human-readable display name; defaults to newRef

  if (typeItem.key === 'branch') {
    const out = await gitOrNull(root, 'for-each-ref',
      '--format=%(refname)\t%(refname:short)\t%(committerdate:relative)',
      '--exclude=refs/remotes/*/HEAD', 'refs/heads/', 'refs/remotes/')

    type BranchItem = vscode.QuickPickItem & { branch?: string }
    const remotes: BranchItem[] = []
    const locals:  BranchItem[] = []
    for (const line of (out ?? '').split('\n').filter(Boolean)) {
      const [fullRef, name, date] = line.split('\t')
      const item: BranchItem = { label: name, description: date || undefined, branch: name }
      if (fullRef.startsWith('refs/remotes/')) remotes.push(item)
      else locals.push(item)
    }

    const items: BranchItem[] = []
    if (remotes.length) {
      items.push({ label: 'Upstream', kind: vscode.QuickPickItemKind.Separator })
      items.push(...remotes)
    }
    if (locals.length) {
      items.push({ label: 'Local', kind: vscode.QuickPickItemKind.Separator })
      items.push(...locals)
    }

    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select branch…' })
    newRef = picked?.branch

  } else if (typeItem.key === 'tag') {
    const out = await gitOrNull(root, 'for-each-ref',
      '--format=%(refname:short)\t%(creatordate:relative)', 'refs/tags/')
    const items = (out ?? '').split('\n').filter(Boolean).map(line => {
      const [name, date] = line.split('\t')
      return { label: name, description: date || undefined }
    })
    newRef = (await vscode.window.showQuickPick(items, { placeHolder: 'Select tag…' }))?.label

  } else if (typeItem.key === 'commit') {
    const out = await gitOrNull(root, 'log', `--format=%H\x1f%s\x1f%ar`, '-50')
    if (!out) return undefined

    interface CommitItem extends vscode.QuickPickItem { sha: string }
    const items: CommitItem[] = out.trim().split('\n')
      .filter(Boolean)
      .map(line => {
        const [sha, subject, date] = line.split('\x1f')
        return { label: subject, description: `${sha.slice(0, 8)} · ${date}`, sha }
      })

    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select commit…', matchOnDescription: true })
    if (picked) { newRef = picked.sha; newLabel = picked.label }   // label = subject

  } else {  // 'ref'
    newRef = await vscode.window.showInputBox({ prompt: 'Enter a branch name, tag, or SHA' })
  }

  if (!newRef) return undefined

  const resolved = (await gitOrNull(root, 'rev-parse', '--verify', newRef))?.trim()
  if (!resolved) {
    void vscode.window.showErrorMessage(`Task Changes: "${newRef}" is not a valid Git ref.`)
    return undefined
  }

  // Branches: store symbolic name so the diff tracks tip movement.
  // Tags & commits: store the full SHA so the diff is frozen.
  // Enter ref: store as typed (SHA → frozen, branch name → tracks tip).
  const ref   = (typeItem.key === 'branch' || typeItem.key === 'ref') ? newRef : resolved
  const label = newLabel ?? newRef
  const type  = typeItem.key === 'branch' ? 'Branch'
               : typeItem.key === 'tag'    ? 'Tag'
               : typeItem.key === 'commit' ? 'Commit'
               : await detectRefType(root, newRef)

  return { ref, label, type }
}
