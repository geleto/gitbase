import * as vscode from 'vscode'
import * as cp from 'child_process'
import * as util from 'util'

const execFile = util.promisify(cp.execFile)

// ── Minimal vscode.git API types ──────────────────────────────────────────────

export interface GitExtension { getAPI(version: 1): GitAPI }
export interface GitAPI {
  readonly git: { path: string }
  readonly repositories: GitRepository[]
  readonly onDidOpenRepository: vscode.Event<GitRepository>
  readonly onDidCloseRepository: vscode.Event<GitRepository>
}
export interface GitRepository {
  readonly rootUri: vscode.Uri
  readonly state: { readonly onDidChange: vscode.Event<void> }
}

// ── Git helpers ───────────────────────────────────────────────────────────────

let GIT = 'git'

export function setGitPath(path: string): void { GIT = path }

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await execFile(GIT, args, { cwd, maxBuffer: 10 * 1024 * 1024 })
  return r.stdout
}

export async function gitOrNull(cwd: string, ...args: string[]): Promise<string | null> {
  try {
    return await git(cwd, ...args)
  } catch (err) {
    // Re-throw system-level errors (e.g. ENOENT — git not on PATH, EPERM, etc.).
    // Those have a string error code.  Git process exits (ref not found, etc.)
    // have a numeric exit code and are the expected null case.
    if (typeof (err as NodeJS.ErrnoException).code === 'string') throw err
    return null
  }
}

export function isSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref)
}

export async function detectRefType(root: string, ref: string): Promise<'Branch' | 'Tag' | 'Commit'> {
  if (await gitOrNull(root, 'show-ref', '--verify', `refs/heads/${ref}`)) return 'Branch'
  if (await gitOrNull(root, 'show-ref', '--verify', `refs/tags/${ref}`))  return 'Tag'
  return 'Commit'
}

// ── Parsing ───────────────────────────────────────────────────────────────────

export interface RawChange { status: string; path: string; oldPath?: string }

export function parseNameStatus(out: string): RawChange[] {
  const res: RawChange[] = []
  const parts = out.split('\0')
  let i = 0
  while (i < parts.length) {
    const s = parts[i]
    if (!s) { i++; continue }
    if (s[0] === 'R' || s[0] === 'C') {
      const old = parts[i + 1] ?? ''
      const nw  = parts[i + 2] ?? ''
      if (old && nw) res.push({ status: 'R', path: nw, oldPath: old })
      i += 3
    } else {
      const p = parts[i + 1] ?? ''
      if (p) res.push({ status: s, path: p })
      i += 2
    }
  }
  return res
}

export function parseBinarySet(out: string): Set<string> {
  const bin = new Set<string>()
  const parts = out.split('\0')
  let i = 0
  while (i < parts.length) {
    const t = parts[i]
    if (!t) { i++; continue }
    if (t.startsWith('-\t-\t')) {
      const rest = t.slice(4)
      if (rest) {
        bin.add(rest); i++          // normal binary: path appended to token
      } else {
        const nw = parts[i + 2] ?? ''   // renamed binary: next two tokens are old/new
        if (nw) bin.add(nw)
        i += 3
      }
    } else { i++ }
  }
  return bin
}
