import * as vscode from 'vscode'
import * as https from 'https'
import * as nodePath from 'path'
import { gitOrNull } from './git'
import { log } from './log'

export interface BaseSelection {
  readonly ref:      string
  readonly label:    string
  readonly type:     'Branch' | 'Tag' | 'Commit' | 'PR' | undefined
  /** Set when entering GitHub PR full review. Provider fills in prevBase* before persisting. */
  readonly prEnter?: { prevBranch: string; stashSha?: string }
  /** Set when exiting GitHub PR full review. Provider clears the persisted state. */
  readonly prExit?:  true
  /** True when the PR base was already local and no fetch was performed — diff may be against a stale ref. */
  readonly stale?:   boolean
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
): Promise<{ baseRef: string; headSha: string } | 'not-found' | 'auth-cancelled' | undefined> {
  // Try with a silent session first (no UI shown if not signed in).
  let token: string | undefined
  try {
    token = (await vscode.authentication.getSession('github', ['repo'], { silent: true }))?.accessToken
  } catch { /* no session */ }

  let result = await fetchPrMeta(owner, repo, prNumber, token)

  // 404 means the PR doesn't exist — no point prompting for auth.
  if (result === 'not-found') return 'not-found'

  // On auth failure, prompt the user to sign in and retry once.
  if (result === 'auth-required') {
    try {
      token = (await vscode.authentication.getSession('github', ['repo'], { createIfNone: true }))?.accessToken
    } catch { return 'auth-cancelled' }
    result = await fetchPrMeta(owner, repo, prNumber, token)
    if (result === 'not-found') return 'not-found'
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
): Promise<BaseSelection | 'checkout-failed' | 'checkout-failed-stash-left' | 'fetch-failed' | 'stash-failed' | 'not-found' | 'auth-cancelled' | undefined> {
  const r = nodePath.basename(root)
  log(`[${r}] PR #${prNumber} (${owner}/${repo}) mode=${key}`)

  const meta = await resolvePrMeta(owner, repo, prNumber)
  if (meta === 'not-found') return 'not-found'
  if (meta === 'auth-cancelled') return 'auth-cancelled'
  if (!meta) return undefined

  const { baseRef, headSha } = meta
  const localBase = `origin/${baseRef}`

  let fetched = false
  if (!await gitOrNull(root, 'rev-parse', '--verify', localBase)) {
    log(`[${r}] fetch origin ${baseRef}`)
    if (await gitOrNull(root, 'fetch', 'origin', baseRef) === null) {
      log(`[${r}] ERROR fetch origin ${baseRef} failed`)
      return 'fetch-failed'
    }
    fetched = true
  }

  if (key === 'pr-review') {
    const prevBranch = (await gitOrNull(root, 'symbolic-ref', '--short', 'HEAD'))?.trim() ?? 'HEAD'
    log(`[${r}] entering PR review from branch "${prevBranch}"`)

    let stashSha: string | undefined
    if (isDirty) {
      log(`[${r}] stashing dirty working tree before PR review`)
      if (await gitOrNull(root, 'stash', 'push', '-m', 'gitbase: PR review') === null) {
        log(`[${r}] ERROR stash push failed`)
        return 'stash-failed'
      }
      stashSha = (await gitOrNull(root, 'rev-parse', 'stash@{0}'))?.trim() ?? undefined
      if (!stashSha) {
        // SHA capture failed — pop the stash we just created so the user's changes are restored.
        log(`[${r}] ERROR stash SHA capture failed; popping stash to restore working tree`)
        await gitOrNull(root, 'stash', 'pop')
        return 'stash-failed'
      }
      log(`[${r}] stash created: ${stashSha}`)
    }

    log(`[${r}] fetch refs/pull/${prNumber}/head`)
    const fetched = await gitOrNull(root, 'fetch', 'origin', `refs/pull/${prNumber}/head`)
    log(`[${r}] checkout --detach ${headSha.slice(0, 8)}`)
    if (fetched === null || await gitOrNull(root, 'checkout', '--detach', headSha) === null) {
      log(`[${r}] ERROR checkout --detach ${headSha.slice(0, 8)} failed`)
      if (stashSha) {
        log(`[${r}] restoring stash ${stashSha} after checkout failure`)
        if (!await popStashBySha(root, stashSha)) return 'checkout-failed-stash-left'
      }
      return 'checkout-failed'
    }

    log(`[${r}] now in detached HEAD at ${headSha.slice(0, 8)}, base=${localBase}`)
    return { ref: localBase, label: `GitHub PR #${prNumber} · ${owner}/${repo} · PR changes`, type: 'PR' as const, prEnter: { prevBranch, stashSha } }
  }

  return { ref: localBase, label: `GitHub PR #${prNumber} · ${owner}/${repo} · my work vs target`, type: 'PR' as const, stale: !fetched }
}

export type ExitPrResult =
  | { ok: true;  selection: BaseSelection; stashPopFailed: boolean }
  | { ok: false; reason?: 'dirty' }

/**
 * Checks out the previous branch and restores the stash.
 * No VS Code UI.
 */
export async function exitPr(root: string, state: PrReviewState): Promise<ExitPrResult> {
  const r = nodePath.basename(root)
  log(`[${r}] exiting PR review, returning to "${state.prevBranch}"`)

  const unstaged = await gitOrNull(root, 'diff', '--quiet')
  const staged   = await gitOrNull(root, 'diff', '--cached', '--quiet')
  if (unstaged === null || staged === null) {
    log(`[${r}] WARN exit blocked — uncommitted changes in working tree`)
    return { ok: false, reason: 'dirty' }
  }

  log(`[${r}] checkout ${state.prevBranch}`)
  if (await gitOrNull(root, 'checkout', state.prevBranch) === null) {
    log(`[${r}] ERROR checkout ${state.prevBranch} failed`)
    return { ok: false }
  }

  let stashPopFailed = false
  if (state.stashSha) {
    log(`[${r}] restoring stash ${state.stashSha}`)
    stashPopFailed = !await popStashBySha(root, state.stashSha)
    if (stashPopFailed) log(`[${r}] WARN stash pop failed for ${state.stashSha}`)
  }

  log(`[${r}] PR review exited${stashPopFailed ? ' (stash pop failed — changes still in stash)' : ''}`)
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
