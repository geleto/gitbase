import * as vscode from 'vscode'
import * as cp from 'child_process'
import * as nodePath from 'path'
import * as util from 'util'

const execFile = util.promisify(cp.execFile)

// ── Minimal vscode.git API types ──────────────────────────────────────────────

interface GitExtension { getAPI(version: 1): GitAPI }
interface GitAPI {
  readonly git: { path: string }
  readonly repositories: GitRepository[]
  readonly onDidOpenRepository: vscode.Event<GitRepository>
  readonly onDidCloseRepository: vscode.Event<GitRepository>
}
interface GitRepository {
  readonly rootUri: vscode.Uri
  readonly state: { readonly onDidChange: vscode.Event<void> }
}

// ── Git helpers ───────────────────────────────────────────────────────────────

let GIT = 'git'

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await execFile(GIT, args, { cwd, maxBuffer: 10 * 1024 * 1024 })
  return r.stdout
}

async function gitOrNull(cwd: string, ...args: string[]): Promise<string | null> {
  try { return await git(cwd, ...args) } catch { return null }
}

function isSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref)
}

async function detectRefType(root: string, ref: string): Promise<'Branch' | 'Tag' | 'Commit'> {
  if (await gitOrNull(root, 'show-ref', '--verify', `refs/heads/${ref}`)) return 'Branch'
  if (await gitOrNull(root, 'show-ref', '--verify', `refs/tags/${ref}`))  return 'Tag'
  return 'Commit'
}

// ── Parsing ───────────────────────────────────────────────────────────────────

interface RawChange { status: string; path: string; oldPath?: string }

function parseNameStatus(out: string): RawChange[] {
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

function parseBinarySet(out: string): Set<string> {
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

// ── URI helpers ───────────────────────────────────────────────────────────────

const EMPTY_URI = vscode.Uri.parse('empty:empty')

function makeBaseUri(root: string, ref: string, fp: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: 'basegit',
    query: new URLSearchParams({ root, ref, fp }).toString(),
  })
}

function parseBaseUri(uri: vscode.Uri): { root: string; ref: string; fp: string } {
  const p = new URLSearchParams(uri.query)
  return { root: p.get('root') ?? '', ref: p.get('ref') ?? '', fp: p.get('fp') ?? '' }
}

// ── Content providers ─────────────────────────────────────────────────────────

class BaseGitContentProvider implements vscode.TextDocumentContentProvider {
  // SHA-based refs: permanent for the session
  private readonly shaCache = new Map<string, string>()
  // Branch/tag-based refs: keyed by "root\0ref"; invalidated when tip SHA changes
  private readonly branchCaches = new Map<string, { tipSha: string; files: Map<string, string> }>()

  /** Call once per refresh before serving content, to invalidate stale branch caches. */
  async checkBranchTip(root: string, ref: string): Promise<void> {
    if (isSha(ref)) return
    const tip = (await gitOrNull(root, 'rev-parse', ref))?.trim()
    if (!tip) return
    const key = `${root}\0${ref}`
    const entry = this.branchCaches.get(key)
    if (!entry || entry.tipSha !== tip) {
      this.branchCaches.set(key, { tipSha: tip, files: new Map() })
    }
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { root, ref, fp } = parseBaseUri(uri)
    if (!root || !ref || !fp) return ''

    if (isSha(ref)) {
      const key = `${root}\0${ref}\0${fp}`
      if (!this.shaCache.has(key)) {
        this.shaCache.set(key, await gitOrNull(root, 'show', `${ref}:${fp}`) ?? '')
      }
      return this.shaCache.get(key)!
    }

    const bkey = `${root}\0${ref}`
    let entry = this.branchCaches.get(bkey)
    if (!entry) {
      // Lazy-seed before the first refresh has run
      const tip = (await gitOrNull(root, 'rev-parse', ref))?.trim() ?? ''
      entry = { tipSha: tip, files: new Map() }
      this.branchCaches.set(bkey, entry)
    }
    if (!entry.files.has(fp)) {
      entry.files.set(fp, await gitOrNull(root, 'show', `${ref}:${fp}`) ?? '')
    }
    return entry.files.get(fp)!
  }
}

class EmptyContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(): string { return '' }
}

// ── Decorations ───────────────────────────────────────────────────────────────

interface Deco { letter: string; color: vscode.ThemeColor; strikeThrough: boolean }

const DECO: Record<string, Deco> = {
  A: { letter: 'A', color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),    strikeThrough: false },
  M: { letter: 'M', color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'), strikeThrough: false },
  D: { letter: 'D', color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),  strikeThrough: true  },
  R: { letter: 'R', color: new vscode.ThemeColor('gitDecoration.renamedResourceForeground'),  strikeThrough: false },
}

const STATUS_LABEL: Record<string, string> = {
  A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed',
}

// ── File decoration provider ──────────────────────────────────────────────────

class TaskChangesDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[]>()
  readonly onDidChangeFileDecorations = this._onDidChange.event

  private readonly byRoot = new Map<string, Map<string, vscode.Uri>>()
  private readonly decos  = new Map<string, vscode.FileDecoration>()

  update(root: string, changes: RawChange[], dirtyPaths: Set<string>): void {
    const old  = this.byRoot.get(root) ?? new Map<string, vscode.Uri>()
    const next = new Map<string, vscode.Uri>()
    const fired: vscode.Uri[] = []

    for (const c of changes) {
      if (dirtyPaths.has(c.path)) continue   // git extension already decorates this file
      const uri = vscode.Uri.file(nodePath.join(root, c.path))
      const key = uri.toString()
      next.set(key, uri)
      const d = DECO[c.status] ?? DECO['M']
      this.decos.set(key, new vscode.FileDecoration(d.letter, STATUS_LABEL[c.status] ?? 'Modified', d.color))
      fired.push(uri)
    }

    for (const [key, uri] of old) {
      if (!next.has(key)) { this.decos.delete(key); fired.push(uri) }
    }

    this.byRoot.set(root, next)
    if (fired.length) this._onDidChange.fire(fired)
  }

  clear(root: string): void {
    const old = this.byRoot.get(root)
    if (!old?.size) return
    const fired = [...old.values()]
    for (const key of old.keys()) this.decos.delete(key)
    this.byRoot.delete(root)
    this._onDidChange.fire(fired)
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    return this.decos.get(uri.toString())
  }

  dispose(): void { this._onDidChange.dispose() }
}

// ── TaskChangesProvider ───────────────────────────────────────────────────────

export class TaskChangesProvider implements vscode.Disposable {
  readonly scm: vscode.SourceControl
  private readonly group: vscode.SourceControlResourceGroup
  private readonly subs: vscode.Disposable[] = []

  private baseRef   = 'HEAD'
  private baseLabel = 'HEAD'
  private baseType  = 'Task'
  private running = false
  private dirty   = false
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly repo:        GitRepository,
    private readonly ctx:         vscode.ExtensionContext,
    private readonly content:     BaseGitContentProvider,
    private readonly decoProvider: TaskChangesDecorationProvider,
  ) {
    const root = repo.rootUri.fsPath

    this.scm = vscode.scm.createSourceControl('taskchanges', 'GitBase Changes', repo.rootUri)
    this.scm.inputBox.visible = false

    this.group = this.scm.createResourceGroup('changes', 'HEAD · Select a base to begin')
    this.group.hideWhenEmpty = false

    const stored = ctx.workspaceState.get<string>(`taskChanges.base.${root}`)
    if (stored) {
      this.baseRef   = stored
      this.baseLabel = ctx.workspaceState.get<string>(`taskChanges.baseLabel.${root}`) ?? stored
      this.baseType  = ctx.workspaceState.get<string>(`taskChanges.baseType.${root}`) ?? 'Task'
      this.syncLabel()
    }

    this.subs.push(repo.state.onDidChange(() => this.schedule()))
    this.schedule()
  }

  private syncLabel(): void {
    this.group.label = this.baseLabel === 'HEAD'
      ? 'HEAD · Select a base to begin'
      : this.baseType === 'Task'
        ? this.baseLabel
        : `${this.baseType} · ${this.baseLabel}`
  }

  schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.refresh(), 400)
  }

  private async refresh(): Promise<void> {
    if (this.running) { this.dirty = true; return }
    this.running = true; this.dirty = false
    try { await this.run() } finally {
      this.running = false
      if (this.dirty) this.refresh()
    }
  }

  private async run(): Promise<void> {
    const root = this.repo.rootUri.fsPath
    const ref  = this.baseRef

    // Validate ref
    const ok = await gitOrNull(root, 'rev-parse', '--verify', ref)
    if (!ok) {
      this.group.resourceStates = []
      this.decoProvider.clear(root)
      this.baseRef   = 'HEAD'
      this.baseLabel = 'HEAD'
      this.baseType  = 'Task'
      await this.ctx.workspaceState.update(`taskChanges.base.${root}`,      undefined)
      await this.ctx.workspaceState.update(`taskChanges.baseLabel.${root}`, undefined)
      await this.ctx.workspaceState.update(`taskChanges.baseType.${root}`,  undefined)
      this.syncLabel()
      vscode.window.showWarningMessage(
        `GitBase: base ref "${ref}" no longer exists. Select a new base to continue.`,
        'Select Base',
      ).then(action => {
        if (action === 'Select Base') vscode.commands.executeCommand('taskChanges.selectBase', this.scm)
      })
      return
    }

    await this.content.checkBranchTip(root, ref)

    const [nsOut, numOut, dirtyOut] = await Promise.all([
      gitOrNull(root, 'diff', '--name-status', '-z', ref,    '--'),
      gitOrNull(root, 'diff', '--numstat',     '-z', ref,    '--'),
      gitOrNull(root, 'diff', 'HEAD',   '--name-only', '-z', '--'),
    ])

    if (nsOut === null) { this.group.resourceStates = []; this.decoProvider.clear(root); return }

    const changes = parseNameStatus(nsOut)
    const binary  = numOut ? parseBinarySet(numOut) : new Set<string>()

    this.group.resourceStates = changes.map(c => {
      const isBin = binary.has(c.path) || (c.oldPath ? binary.has(c.oldPath) : false)
      return this.makeState(root, ref, this.baseLabel, c, isBin)
    })
    const dirtyPaths = new Set((dirtyOut ?? '').split('\0').filter(Boolean))
    this.decoProvider.update(root, changes, dirtyPaths)
  }

  private makeState(root: string, ref: string, label: string, c: RawChange, isBin: boolean): vscode.SourceControlResourceState {
    const workUri = vscode.Uri.file(nodePath.join(root, c.path))
    const { status } = c

    let baseUri: vscode.Uri
    let rightUri: vscode.Uri

    if (status === 'A') {
      baseUri  = EMPTY_URI
      rightUri = workUri
    } else if (status === 'D') {
      baseUri  = makeBaseUri(root, ref, c.path.replace(/\\/g, '/'))
      rightUri = EMPTY_URI
    } else {
      // M or R — for renames the base side uses the old path
      const baseFp = (status === 'R' ? c.oldPath! : c.path).replace(/\\/g, '/')
      baseUri  = makeBaseUri(root, ref, baseFp)
      rightUri = workUri
    }

    const d = DECO[status] ?? DECO['M']
    const diffTitle = `${nodePath.basename(c.path)} (since ${label})`

    const command: vscode.Command = isBin
      ? { title: 'Binary file', command: 'taskChanges.binaryNotice', arguments: [c.path] }
      : { title: 'Open diff',   command: 'vscode.diff',              arguments: [baseUri, rightUri, diffTitle] }

    const decorations: vscode.SourceControlResourceDecorations = {
      strikeThrough: d.strikeThrough,
    }

    return { resourceUri: workUri, decorations, command }
  }

  async selectBase(): Promise<void> {
    const root = this.repo.rootUri.fsPath

    const typeItem = await vscode.window.showQuickPick(
      ['Branch…', 'Tag…', 'Commit…', 'Enter ref…'],
      { placeHolder: 'Select base type' },
    )
    if (!typeItem) return

    let newRef:   string | undefined
    let newLabel: string | undefined   // human-readable display name; defaults to newRef

    if (typeItem === 'Branch…') {
      const out   = await gitOrNull(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/', 'refs/remotes/')
      const items = (out ?? '').split('\n').map(s => s.trim()).filter(Boolean)
      newRef = await vscode.window.showQuickPick(items, { placeHolder: 'Select branch…', matchOnDescription: true })

    } else if (typeItem === 'Tag…') {
      const out   = await gitOrNull(root, 'tag', '--sort=-version:refname')
      const items = (out ?? '').split('\n').map(s => s.trim()).filter(Boolean)
      newRef = await vscode.window.showQuickPick(items, { placeHolder: 'Select tag…', matchOnDescription: true })

    } else if (typeItem === 'Commit…') {
      const out = await gitOrNull(root, 'log', `--format=%H\x1f%s\x1f%ar`, '-50')
      if (!out) return

      interface CommitItem extends vscode.QuickPickItem { sha: string }
      const items: CommitItem[] = out.trim().split('\n')
        .filter(Boolean)
        .map(line => {
          const [sha, subject, date] = line.split('\x1f')
          return { label: subject, description: `${sha.slice(0, 8)} · ${date}`, sha }
        })

      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select commit…', matchOnDescription: true })
      if (picked) { newRef = picked.sha; newLabel = picked.label }   // label = subject

    } else {
      newRef = await vscode.window.showInputBox({ prompt: 'Enter a branch name, tag, or SHA' })
    }

    if (!newRef) return

    const resolved = (await gitOrNull(root, 'rev-parse', '--verify', newRef))?.trim()
    if (!resolved) {
      vscode.window.showErrorMessage(`Task Changes: "${newRef}" is not a valid Git ref.`)
      return
    }

    // Branches: store symbolic name so the diff tracks tip movement.
    // Tags & commits: store the full SHA so the diff is frozen.
    // Enter ref: store as typed (SHA → frozen, branch name → tracks tip).
    this.baseRef   = (typeItem === 'Branch…' || typeItem === 'Enter ref…') ? newRef : resolved
    this.baseLabel = newLabel ?? newRef   // commits use subject; everything else uses the ref name
    this.baseType  = typeItem === 'Branch…' ? 'Branch'
                   : typeItem === 'Tag…'    ? 'Tag'
                   : typeItem === 'Commit…' ? 'Commit'
                   : await detectRefType(root, newRef)

    await this.ctx.workspaceState.update(`taskChanges.base.${root}`,      this.baseRef)
    await this.ctx.workspaceState.update(`taskChanges.baseLabel.${root}`, this.baseLabel)
    await this.ctx.workspaceState.update(`taskChanges.baseType.${root}`,  this.baseType)
    this.syncLabel()
    this.schedule()
  }

  dispose(): void {
    this.subs.forEach(d => d.dispose())
    if (this.timer) clearTimeout(this.timer)
    this.scm.dispose()
    this.decoProvider.clear(this.repo.rootUri.fsPath)
  }
}

// ── Activation ────────────────────────────────────────────────────────────────

const providers = new Map<string, TaskChangesProvider>()

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git')
  if (!ext) {
    vscode.window.showErrorMessage('Task Changes: VS Code Git extension not found. Extension disabled.')
    return
  }
  if (!ext.isActive) await ext.activate()

  const api = ext.exports.getAPI(1)
  GIT = api.git.path

  const content      = new BaseGitContentProvider()
  const decoProvider = new TaskChangesDecorationProvider()
  ctx.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('basegit', content),
    vscode.workspace.registerTextDocumentContentProvider('empty',   new EmptyContentProvider()),
    vscode.window.registerFileDecorationProvider(decoProvider),
    decoProvider,
  )

  function addRepo(repo: GitRepository): void {
    const root = repo.rootUri.fsPath
    if (providers.has(root)) return
    const p = new TaskChangesProvider(repo, ctx, content, decoProvider)
    providers.set(root, p)
    ctx.subscriptions.push(p)
  }

  api.repositories.forEach(addRepo)
  ctx.subscriptions.push(api.onDidOpenRepository(addRepo))
  ctx.subscriptions.push(
    api.onDidCloseRepository(repo => {
      const p = providers.get(repo.rootUri.fsPath)
      if (p) { p.dispose(); providers.delete(repo.rootUri.fsPath) }
    })
  )

  // When called from the scm/title menu, VS Code passes the SourceControl as first arg.
  function resolveProvider(sc?: vscode.SourceControl): TaskChangesProvider | undefined {
    if (sc) return [...providers.values()].find(p => p.scm === sc)
    if (providers.size === 1) return [...providers.values()][0]
    return undefined
  }

  ctx.subscriptions.push(
    vscode.commands.registerCommand('taskChanges.selectBase', (sc?: vscode.SourceControl) => {
      resolveProvider(sc)?.selectBase()
    }),
    vscode.commands.registerCommand('taskChanges.refresh', (sc?: vscode.SourceControl) => {
      resolveProvider(sc)?.schedule()
    }),
    vscode.commands.registerCommand('taskChanges.binaryNotice', (filePath: string) => {
      vscode.window.showInformationMessage(`Binary file: ${nodePath.basename(filePath)} — diff not available.`)
    }),
  )
}

export function deactivate(): void {
  providers.forEach(p => p.dispose())
  providers.clear()
}
