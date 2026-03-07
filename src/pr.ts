import * as vscode from 'vscode'
import * as https from 'https'
import { gitOrNull } from './git'

export interface BaseSelection {
  readonly ref:      string
  readonly label:    string
  readonly type:     'Branch' | 'Tag' | 'Commit' | 'PR' | undefined
  /** Set when entering GitHub PR full review. Provider fills in prevBase* before persisting. */
  readonly prEnter?: { prevBranch: string; stashSha?: string }
  /** Set when exiting GitHub PR full review. Provider clears the persisted state. */
  readonly prExit?:  true
}

export interface PrReviewState {
  readonly prevBranch:    string
  readonly prevBase:      string
  readonly prevBaseLabel: string
  readonly prevBaseType:  'Branch' | 'Tag' | 'Commit' | undefined
  readonly stashSha?:     string
}

type PrMetaResult = { baseRef: string; headSha: string } | 'auth-required' | 'not-found' | undefined

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
      if (res.statusCode === 401) { res.resume(); resolve('auth-required'); return }
      if (res.statusCode === 404) { res.resume(); resolve('not-found');     return }
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

  // 404 means the PR doesn't exist — no point prompting for auth.
  if (result === 'not-found') return undefined

  // On auth failure, prompt the user to sign in and retry once.
  if (result === 'auth-required') {
    try {
      token = (await vscode.authentication.getSession('github', ['repo'], { createIfNone: true }))?.accessToken
    } catch { return undefined }
    result = await fetchPrMeta(owner, repo, prNumber, token)
    if (result === 'not-found') return undefined
  }

  return result === 'auth-required' ? undefined : result
}

/** Finds a stash entry by SHA and pops it. Returns true on success or if not found (already gone). */
async function popStashBySha(root: string, sha: string): Promise<boolean> {
  const list = await gitOrNull(root, 'stash', 'list', '--format=%H')
  const idx  = (list ?? '').split('\n').filter(Boolean).indexOf(sha)
  if (idx < 0) return true   // already gone — nothing to pop
  return await gitOrNull(root, 'stash', 'pop', '--index', `stash@{${idx}}`) !== null
}

/**
 * Fetches PR metadata and performs the git operations for the selected mode.
 * No VS Code UI except authentication prompts.
 */
export async function resolvePr(
  root: string,
  isDirty: boolean,
  key: 'pr-base' | 'pr-review',
  owner: string,
  repo: string,
  prNumber: number,
): Promise<BaseSelection | 'checkout-failed' | 'checkout-failed-stash-left' | 'fetch-failed' | undefined> {
  const meta = await resolvePrMeta(owner, repo, prNumber)
  if (!meta) return undefined

  const { baseRef, headSha } = meta
  const localBase = `origin/${baseRef}`

  if (!await gitOrNull(root, 'rev-parse', '--verify', localBase)) {
    if (await gitOrNull(root, 'fetch', 'origin', baseRef) === null) return 'fetch-failed'
  }

  if (key === 'pr-review') {
    const prevBranch = (await gitOrNull(root, 'symbolic-ref', '--short', 'HEAD'))?.trim() ?? 'HEAD'

    let stashSha: string | undefined
    if (isDirty) {
      if (await gitOrNull(root, 'stash', 'push', '-m', 'gitbase: PR review') !== null) {
        stashSha = (await gitOrNull(root, 'rev-parse', 'stash@{0}'))?.trim() ?? undefined
      }
    }

    const fetched = await gitOrNull(root, 'fetch', 'origin', `refs/pull/${prNumber}/head`)
    if (fetched === null || await gitOrNull(root, 'checkout', '--detach', headSha) === null) {
      if (stashSha && !await popStashBySha(root, stashSha)) return 'checkout-failed-stash-left'
      return 'checkout-failed'
    }

    return { ref: localBase, label: `GitHub PR #${prNumber} · ${owner}/${repo} · PR changes`, type: 'PR' as const, prEnter: { prevBranch, stashSha } }
  }

  return { ref: localBase, label: `GitHub PR #${prNumber} · ${owner}/${repo} · my work vs target`, type: 'PR' as const }
}

export type ExitPrResult =
  | { ok: true;  selection: BaseSelection; stashPopFailed: boolean }
  | { ok: false; reason?: 'dirty' }

/**
 * Checks out the previous branch and restores the stash.
 * No VS Code UI.
 */
export async function exitPr(root: string, state: PrReviewState): Promise<ExitPrResult> {
  const unstaged = await gitOrNull(root, 'diff', '--quiet')
  const staged   = await gitOrNull(root, 'diff', '--cached', '--quiet')
  if (unstaged === null || staged === null) return { ok: false, reason: 'dirty' }

  if (await gitOrNull(root, 'checkout', state.prevBranch) === null) return { ok: false }

  let stashPopFailed = false
  if (state.stashSha) {
    stashPopFailed = !await popStashBySha(root, state.stashSha)
  }

  return {
    ok: true,
    selection: { ref: state.prevBase, label: state.prevBaseLabel, type: state.prevBaseType, prExit: true },
    stashPopFailed,
  }
}

/** Returns the number of commits reachable from HEAD but not from any local branch (detached HEAD commits). */
export async function countDetachedCommits(root: string): Promise<number> {
  const out = await gitOrNull(root, 'log', 'HEAD', '--not', '--branches', '--oneline')
  return out ? out.trim().split('\n').filter(Boolean).length : 0
}
