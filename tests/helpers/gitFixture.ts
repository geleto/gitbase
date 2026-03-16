import * as vscode from 'vscode'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import * as cp from 'child_process'
import { providers, closedRoots, forceOpenRepository } from '../../src/extension'
import { TaskChangesProvider } from '../../src/provider'

// ── Repo fixture ──────────────────────────────────────────────────────────────

export interface Repo {
  root: string
  /** Run a git command in this repo, returns trimmed stdout. */
  git(...args: string[]): string
  /** Write a file relative to repo root (creates parent dirs). */
  write(rel: string, content?: string): void
  /** Delete a file relative to repo root. */
  rm(rel: string): void
}

export function makeRepo(prefix = 'gitbase-test-'): Repo {
  // Normalise to the path VS Code uses internally (vscode.Uri.file normalises
  // the drive letter to lowercase on Windows, so 'C:\...' → 'c:\...').
  const raw  = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const root = vscode.Uri.file(raw).fsPath
  const git  = (...args: string[]) =>
    cp.execSync(`git ${args.join(' ')}`, { cwd: root, encoding: 'utf8' }).trim()

  git('init')
  git('config user.email "test@gitbase.test"')
  git('config user.name "GitBase Test"')

  // Create an initial commit so HEAD is valid
  fs.writeFileSync(path.join(root, '.gitkeep'), '')
  git('add .')
  git('commit -m "chore: init"')

  return {
    root,
    git,
    write(rel: string, content = `content of ${rel}\n`) {
      const full = path.join(root, rel)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, content)
    },
    rm(rel: string) {
      fs.rmSync(path.join(root, rel), { force: true })
    },
  }
}

export function removeRepo(repo: Repo): void {
  try { fs.rmSync(repo.root, { recursive: true, force: true }) } catch { /* ignore */ }
}

// ── Workspace folder helpers ──────────────────────────────────────────────────

export async function addWorkspaceFolder(root: string): Promise<void> {
  // Clear the ghost guard so addRepo will accept onDidOpenRepository events for this root.
  closedRoots.delete(root)
  const n = (vscode.workspace.workspaceFolders?.length ?? 0)
  vscode.workspace.updateWorkspaceFolders(n, 0, { uri: vscode.Uri.file(root) })
  // VS Code's workspace-folder-based git auto-detection is unreliable in the test
  // extension host (onDidOpenRepository may never fire via that path).  Explicitly
  // opening the repository via the git API guarantees onDidOpenRepository fires.
  const gitExt = vscode.extensions.getExtension<any>('vscode.git')
  if (gitExt?.isActive) {
    const api = gitExt.exports.getAPI(1)
    await api.openRepository(vscode.Uri.file(root))
    // api.openRepository is idempotent in vscode.git: if the repo was already registered
    // (e.g. a re-add after removeWorkspaceFolder), onDidOpenRepository won't re-fire.
    // Use the extension's forceOpenRepository hook to trigger addRepo directly.
    if (!providers.has(root)) {
      await sleep(200)
      if (!providers.has(root)) forceOpenRepository?.(root)
    }
  }
}

export function removeWorkspaceFolder(root: string): void {
  // Block ghost onDidOpenRepository events and explicitly dispose the provider,
  // since onDidChangeWorkspaceFolders is not reliable in the test extension host.
  const p = providers.get(root)
  if (p) { p.dispose(); providers.delete(root) }
  closedRoots.add(root)
  const folders = vscode.workspace.workspaceFolders ?? []
  const idx     = folders.findIndex(f => f.uri.fsPath === root)
  if (idx >= 0) vscode.workspace.updateWorkspaceFolders(idx, 1)
}

// ── Provider base helpers ─────────────────────────────────────────────────────

type BaseType = 'Branch' | 'Tag' | 'Commit' | 'PR'

/**
 * Set the base ref on a provider, bypassing TypeScript's private field access.
 * label defaults to ref when omitted.
 * autoDetectDone is set to true for any typed base so auto-detection does not
 * re-run on the next refresh.
 */
export function setProviderBase(
  provider: TaskChangesProvider,
  ref: string,
  type: BaseType | undefined,
  label = ref,
): void {
  const p = provider as any
  p.baseRef   = ref
  p.baseLabel = label
  p.baseType  = type
  if (type !== undefined) p.autoDetectDone = true
  p.syncLabel()
}

/** Read the current base ref from a provider. */
export function getProviderBase(provider: TaskChangesProvider): string {
  return (provider as any).baseRef as string
}

/** Read the lastDiffRef computed by the most recent refresh. */
export function getProviderDiffRef(provider: TaskChangesProvider): string {
  return (provider as any).lastDiffRef as string
}

/** Read the autoDetectDone flag from a provider. */
export function getProviderAutoDetectDone(provider: TaskChangesProvider): boolean {
  return (provider as any).autoDetectDone as boolean
}

// ── Provider access ───────────────────────────────────────────────────────────

/** Wait until a provider is registered for the given root, up to timeoutMs. */
export async function waitForProvider(root: string, timeoutMs = 25_000): Promise<TaskChangesProvider> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const p = providers.get(root)
    if (p) return p
    await sleep(100)
  }
  throw new Error(`Timeout waiting for provider at ${root}`)
}

/** Wait until providers.size matches the expected count. */
export async function waitForProviderCount(count: number, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (providers.size === count) return
    await sleep(100)
  }
  throw new Error(`Timeout waiting for ${count} providers (have ${providers.size})`)
}

// ── Resource state helpers ────────────────────────────────────────────────────

/**
 * Wait for the next onDidChangeResourceStates event from the provider.
 * Unlike waitForResourceStates, this always waits for at least one new event —
 * it never returns immediately based on current state.
 */
export function waitForRefresh(
  provider: TaskChangesProvider,
  timeoutMs = 5_000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.dispose()
      reject(new Error(`Timeout waiting for provider refresh at ${provider.scm.rootUri?.fsPath}`))
    }, timeoutMs)

    const sub = provider.onDidChangeResourceStates(() => {
      clearTimeout(timer)
      sub.dispose()
      resolve()
    })
  })
}

/**
 * Wait until provider.group.resourceStates satisfies predicate.
 * Polls via onDidChangeResourceStates events; falls back to a polling loop.
 */
export async function waitForResourceStates(
  provider: TaskChangesProvider,
  predicate: (states: vscode.SourceControlResourceState[]) => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  if (predicate(provider.group.resourceStates)) return

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.dispose()
      reject(new Error(`Timeout waiting for resource states. Current count: ${provider.group.resourceStates.length}`))
    }, timeoutMs)

    const sub = provider.onDidChangeResourceStates(() => {
      if (predicate(provider.group.resourceStates)) {
        clearTimeout(timer)
        sub.dispose()
        resolve()
      }
    })
  })
}

// ── Clipboard helpers ─────────────────────────────────────────────────────────

export async function waitForClipboard(
  predicate: (text: string) => boolean,
  timeoutMs = 3_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const text = await vscode.env.clipboard.readText()
    if (predicate(text)) return text
    await sleep(50)
  }
  const last = await vscode.env.clipboard.readText()
  throw new Error(`Timeout waiting for clipboard. Last value: "${last}"`)
}

// ── Notification capture ──────────────────────────────────────────────────────

export interface CapturedNotification {
  severity: 'info' | 'warning' | 'error'
  message: string
}

export async function captureNotifications(
  fn: () => Promise<void>,
): Promise<CapturedNotification[]> {
  const captured: CapturedNotification[] = []

  const origInfo    = vscode.window.showInformationMessage.bind(vscode.window)
  const origWarning = vscode.window.showWarningMessage.bind(vscode.window)
  const origError   = vscode.window.showErrorMessage.bind(vscode.window)

  ;(vscode.window as any).showInformationMessage = (msg: string, ...rest: any[]) => {
    captured.push({ severity: 'info', message: msg })
    return origInfo(msg, ...rest)
  }
  ;(vscode.window as any).showWarningMessage = (msg: string, ...rest: any[]) => {
    captured.push({ severity: 'warning', message: msg })
    return origWarning(msg, ...rest)
  }
  ;(vscode.window as any).showErrorMessage = (msg: string, ...rest: any[]) => {
    captured.push({ severity: 'error', message: msg })
    return origError(msg, ...rest)
  }

  try {
    await fn()
  } finally {
    ;(vscode.window as any).showInformationMessage = origInfo
    ;(vscode.window as any).showWarningMessage     = origWarning
    ;(vscode.window as any).showErrorMessage       = origError
  }

  return captured
}

// ── Command spy ───────────────────────────────────────────────────────────────

export async function spyCommand(
  commandId: string,
  fn: () => Promise<void>,
): Promise<unknown[][]> {
  const calls: unknown[][] = []
  const origExecute = vscode.commands.executeCommand.bind(vscode.commands)

  ;(vscode.commands as any).executeCommand = async (id: string, ...args: unknown[]) => {
    if (id === commandId) calls.push(args)
    return origExecute(id, ...args)
  }

  try {
    await fn()
  } finally {
    ;(vscode.commands as any).executeCommand = origExecute
  }

  return calls
}

// ── Misc ──────────────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Wait for the extension to activate and the vscode.git API to discover the given repo.
 * Returns the extension's exports (activate return value is void, so we just check providers).
 */
export async function ensureExtensionActive(): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const ext = vscode.extensions.getExtension('gitbase.gitbase')
           ?? vscode.extensions.all.find(e => e.packageJSON?.name === 'gitbase')
    if (ext) {
      if (!ext.isActive) await ext.activate()
      return
    }
    await sleep(200)
  }
  const ids = vscode.extensions.all.map(e => e.id).join(', ')
  throw new Error(`gitbase extension not found after 15s. Available extensions: ${ids}`)
}
