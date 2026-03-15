import * as vscode from 'vscode'
import * as nodePath from 'path'
import { GitRepository, RawChange, gitOrNull, getMergeBase, detectDefaultBranch, parseNameStatus, parseBinarySet } from './git'
import { pickBase } from './picker'
import { PrReviewState } from './pr'
import { EMPTY_URI, makeBaseUri, BaseGitContentProvider } from './content'
import { DECO, TaskChangesDecorationProvider } from './decorations'
import { WORKAROUND_URI_FRAGMENT, assertScmContext } from './workarounds'
import { diffTitle, baseFragment } from './labels'

// ── TaskChangesProvider ───────────────────────────────────────────────────────

export class TaskChangesProvider implements vscode.Disposable, vscode.QuickDiffProvider {
  static readonly NO_BASE_LABEL = 'HEAD · Select a base to begin'

  readonly scm: vscode.SourceControl
  readonly group: vscode.SourceControlResourceGroup
  readonly statusBarItem: vscode.StatusBarItem
  private _statusBarVisible = true
  private readonly _onDidChangeResourceStates = new vscode.EventEmitter<void>()
  readonly onDidChangeResourceStates: vscode.Event<void> = this._onDidChangeResourceStates.event
  private readonly _onDidChangeBase = new vscode.EventEmitter<void>()
  readonly onDidChangeBase: vscode.Event<void> = this._onDidChangeBase.event
  private readonly subs: vscode.Disposable[] = []

  private baseRef         = 'HEAD'
  private baseLabel       = 'HEAD'
  private baseType: 'Branch' | 'Tag' | 'Commit' | 'PR' | undefined = undefined
  private autoDetectDone  = false
  private running         = false
  lastDiffRef             = 'HEAD'
  private dirty           = false
  private disposed        = false
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

    this.group = this.scm.createResourceGroup('changes', TaskChangesProvider.NO_BASE_LABEL)
    this.group.hideWhenEmpty = false

    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
    this.statusBarItem.command = { command: 'taskChanges.selectBase', arguments: [this.scm], title: 'Select Base' }
    this.statusBarItem.show()
    this.scm.quickDiffProvider = this

    const stored = ctx.workspaceState.get<string>(`taskChanges.base.${root}`)
    if (stored) {
      this.baseRef   = stored
      this.baseLabel = ctx.workspaceState.get<string>(`taskChanges.baseLabel.${root}`) ?? stored
      this.baseType  = ctx.workspaceState.get<'Branch' | 'Tag' | 'Commit' | 'PR'>(`taskChanges.baseType.${root}`)
    }
    this.syncLabel()

    this.subs.push(repo.state.onDidChange(() => this.schedule()))
    this.schedule()
  }

  private syncLabel(): void {
    this.group.label = this.baseLabel === 'HEAD'
      ? TaskChangesProvider.NO_BASE_LABEL
      : !this.baseType || this.baseType === 'PR'
        ? this.baseLabel
        : `${this.baseType} · ${this.baseLabel}`
    this.statusBarItem.text    = this.statusBarText()
    this.statusBarItem.tooltip = new vscode.MarkdownString('**GitBase** — click to select base')
    this._onDidChangeBase.fire()
  }

  private statusBarText(): string {
    if (!this.baseType || this.baseLabel === 'HEAD') return '$(git-branch) Select base\u2026'
    if (this.baseType === 'PR') {
      const m = this.baseLabel.match(/GitHub PR #(\d+)/)
      return m ? `$(github) PR #${m[1]}` : `$(github) ${this.baseLabel.slice(0, 25)}\u2026`
    }
    const icon  = this.baseType === 'Tag' ? '$(tag)' : this.baseType === 'Commit' ? '$(git-commit)' : '$(git-branch)'
    const label = this.baseLabel.length > 30 ? this.baseLabel.slice(0, 30) + '\u2026' : this.baseLabel
    return `${icon} ${label}`
  }

  get statusBarVisible(): boolean { return this._statusBarVisible }
  showStatusBar(): void { this._statusBarVisible = true;  this.statusBarItem.show() }
  hideStatusBar(): void { this._statusBarVisible = false; this.statusBarItem.hide() }

  // ── QuickDiffProvider ──────────────────────────────────────────────────────
  // Returns the base-ref version of a file so VS Code can render gutter diff
  // markers (added/modified lines) relative to the selected GitBase base.
  provideOriginalResource(uri: vscode.Uri): vscode.Uri | undefined {
    if (uri.scheme !== 'file') return undefined
    if (this.baseRef === 'HEAD') return undefined
    const root = this.repo.rootUri.fsPath
    if (!uri.fsPath.startsWith(root + nodePath.sep) && uri.fsPath !== root) return undefined
    // Match against tracked resource states (strip the #gitbase fragment first)
    const state = this.group.resourceStates.find(r =>
      vscode.Uri.from(r.resourceUri).with({ fragment: '' }).fsPath === uri.fsPath
    )
    if (!state) return undefined
    // Untracked (U) has no base; deleted (D) has no working-tree counterpart
    if (state.contextValue === 'U' || state.contextValue === 'D') return undefined
    const rel = nodePath.relative(root, uri.fsPath).replace(/\\/g, '/')
    return makeBaseUri(root, this.lastDiffRef, rel)
  }

  // ── Public helpers for extension.ts ───────────────────────────────────────
  getResourceState(uri: vscode.Uri): vscode.SourceControlResourceState | undefined {
    return this.group.resourceStates.find(r =>
      vscode.Uri.from(r.resourceUri).with({ fragment: '' }).fsPath === uri.fsPath
    )
  }

  openDiffForUri(uri: vscode.Uri): void {
    const state = this.getResourceState(uri)
    if (state?.command) {
      void vscode.commands.executeCommand(state.command.command, ...(state.command.arguments ?? []))
    }
  }

  schedule(): void {
    if (this.disposed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.refresh(), 400)
  }

  private async refresh(): Promise<void> {
    if (this.disposed) return
    if (this.running) { this.dirty = true; return }
    this.running = true; this.dirty = false
    try {
      await this.run()
    } catch (err) {
      void vscode.window.showErrorMessage(`GitBase: refresh failed — ${(err as Error).message ?? err}`)
    } finally {
      this.running = false
      if (this.dirty) this.schedule()
    }
  }

  private async run(): Promise<void> {
    const root = this.repo.rootUri.fsPath

    // On first run with no stored base, auto-detect the upstream default branch.
    if (this.baseRef === 'HEAD' && !this.autoDetectDone) {
      this.autoDetectDone = true
      const detected = await detectDefaultBranch(root)
      if (detected) {
        this.baseRef   = detected
        this.baseLabel = detected
        this.baseType  = 'Branch'
        await Promise.all([
          this.ctx.workspaceState.update(`taskChanges.base.${root}`,      detected),
          this.ctx.workspaceState.update(`taskChanges.baseLabel.${root}`, detected),
          this.ctx.workspaceState.update(`taskChanges.baseType.${root}`,  'Branch'),
        ])
        this.syncLabel()
      }
    }

    const ref = this.baseRef

    // Validate ref (HEAD is always resolvable; skip to avoid spurious warning on unborn repos)
    const ok = ref === 'HEAD' || await gitOrNull(root, 'rev-parse', '--verify', ref)
    if (!ok) {
      this.group.resourceStates = []
      this.decoProvider.clear(root)
      this.baseRef   = 'HEAD'
      this.baseLabel = 'HEAD'
      this.baseType  = undefined
      await Promise.all([
        this.ctx.workspaceState.update(`taskChanges.base.${root}`,      undefined),
        this.ctx.workspaceState.update(`taskChanges.baseLabel.${root}`, undefined),
        this.ctx.workspaceState.update(`taskChanges.baseType.${root}`,  undefined),
      ])
      this.syncLabel()
      assertScmContext()

      // Attempt auto-recovery BEFORE notifying, so notification wording matches outcome.
      const detected = await detectDefaultBranch(root)
      if (detected) {
        this.baseRef   = detected
        this.baseLabel = detected
        this.baseType  = 'Branch'
        this.autoDetectDone = true
        await Promise.all([
          this.ctx.workspaceState.update(`taskChanges.base.${root}`,      detected),
          this.ctx.workspaceState.update(`taskChanges.baseLabel.${root}`, detected),
          this.ctx.workspaceState.update(`taskChanges.baseType.${root}`,  'Branch'),
        ])
        this.syncLabel()
        // Inform, don't alarm — no action needed.
        void vscode.window.showInformationMessage(
          `GitBase: base ref "${ref}" no longer exists; auto-recovered to ${detected}.`
        )
        this.schedule()
      } else {
        this.autoDetectDone = false
        // No recovery possible — user must act.
        void vscode.window.showWarningMessage(
          `GitBase: base ref "${ref}" no longer exists. Select a new base to continue.`,
          'Select Base',
        ).then(action => {
          if (action === 'Select Base') void vscode.commands.executeCommand('taskChanges.selectBase', this.scm)
        })
      }
      return
    }

    await this.content.checkBranchTip(root, ref)

    // For branches, diff against the merge base so only our changes are shown,
    // not diverging commits on the base branch.
    let diffRef = ref
    if (this.baseType === 'Branch' || this.baseType === 'PR') {
      const mb = await getMergeBase(root, 'HEAD', ref)
      if (mb) diffRef = mb
    }
    this.lastDiffRef = diffRef

    // Refresh stat cache so files that were only touched (timestamp changed, content unchanged)
    // don't show up as spurious diff entries. Errors are intentionally ignored.
    await gitOrNull(root, 'update-index', '--refresh', '-q')

    const [nsOut, numOut, dirtyOut, untrackedOut] = await Promise.all([
      gitOrNull(root, 'diff', '--name-status', '-z', diffRef, '--'),
      gitOrNull(root, 'diff', '--numstat',     '-z', diffRef, '--'),
      ref === 'HEAD' ? null : gitOrNull(root, 'diff', 'HEAD', '--name-only', '-z', '--'),
      gitOrNull(root, 'ls-files', '--others', '--exclude-standard', '-z'),
    ])

    if (nsOut === null) { this.group.resourceStates = []; this.decoProvider.clear(root); assertScmContext(); return }

    const changes = parseNameStatus(nsOut)
    const binary  = numOut ? parseBinarySet(numOut) : new Set<string>()

    // Append untracked files as 'U' — git diff does not report them.
    const untracked = (untrackedOut ?? '').split('\0').filter(Boolean)
    for (const p of untracked) changes.push({ status: 'U', path: p })

    this.group.resourceStates = changes.map(c => {
      const isBin = binary.has(c.path) || (c.oldPath ? binary.has(c.oldPath) : false)
      return this.makeState(root, diffRef, c, isBin)
    })
    // Include untracked in dirtyPaths so WORKAROUND_DOUBLE_BADGE suppresses our 'A'
    // badge where git already shows 'U' (untracked) in the Explorer.
    const dirtyPaths = ref === 'HEAD'
      ? new Set(changes.map(c => c.path))
      : new Set([...(dirtyOut ?? '').split('\0').filter(Boolean), ...untracked])
    this.decoProvider.update(root, changes, dirtyPaths)
    this._onDidChangeResourceStates.fire()
  }

  private makeState(root: string, ref: string, c: RawChange, isBin: boolean): vscode.SourceControlResourceState {
    const workUri     = vscode.Uri.file(nodePath.join(root, c.path))
    const resourceUri = WORKAROUND_URI_FRAGMENT ? workUri.with({ fragment: 'gitbase' }) : workUri
    const { status }  = c

    let baseUri: vscode.Uri
    let rightUri: vscode.Uri

    if (status === 'A') {
      baseUri  = EMPTY_URI
      rightUri = workUri
    } else if (status === 'D') {
      baseUri  = makeBaseUri(root, ref, c.path.replace(/\\/g, '/'), baseFragment(this.baseType, this.baseRef, this.baseLabel, 'Deleted'))
      rightUri = EMPTY_URI
    } else {
      // M or R — for renames the base side uses the old path
      const baseFp = (status === 'R' ? c.oldPath! : c.path).replace(/\\/g, '/')
      baseUri  = makeBaseUri(root, ref, baseFp, baseFragment(this.baseType, this.baseRef, this.baseLabel, 'Working Tree'))
      rightUri = workUri
    }

    const d = DECO[status] ?? DECO['M']!
    const truncate = (s: string) => s.length > 30 ? s.slice(0, 30) + '…' : s
    const diffSuffix = this.baseType === 'Commit' ? this.baseRef.slice(0, 7) + '…'
                     : this.baseType === 'PR'     ? truncate(this.baseLabel.match(/GitHub PR #\d+/)?.[0] ?? this.baseLabel)
                     :                              truncate(this.baseLabel)
    // diffTitle is the fallback used when LABEL_FORMATTER_ENABLED is false.
    // When true, vscode.diff derives the tab label from the formatter via the basegit: URI fragment.
    const title = diffTitle(nodePath.basename(c.path), diffSuffix)

    const command: vscode.Command = isBin
      ? { title: 'Binary file', command: 'taskChanges.binaryNotice', arguments: [c.path] }
      : (status === 'A' || status === 'U')
        ? { title: 'Open file', command: 'taskChanges.openUntracked',     arguments: [workUri] }
        : status === 'D'
          ? { title: 'Open file', command: 'vscode.open', arguments: [baseUri] }
          : { title: 'Open diff', command: 'vscode.diff', arguments: [baseUri, rightUri, title] }

    const decorations: vscode.SourceControlResourceDecorations = {
      strikeThrough: d.strikeThrough,
    }

    return { resourceUri, decorations, command, contextValue: status }
  }

  async selectBase(): Promise<void> {
    const root         = this.repo.rootUri.fsPath
    const prReviewState = this.ctx.workspaceState.get<PrReviewState>(`taskChanges.prReview.${root}`)
    const picked = await pickBase(root, prReviewState, () => this.schedule())
    if (!picked) return

    if (picked.prEnter) {
      const state: PrReviewState = {
        ...picked.prEnter,
        prevBase:      this.baseRef,
        prevBaseLabel: this.baseLabel,
        prevBaseType:  this.baseType === 'PR' ? undefined : this.baseType,
      }
      await this.ctx.workspaceState.update(`taskChanges.prReview.${root}`, state)
    } else if (picked.prExit) {
      await this.ctx.workspaceState.update(`taskChanges.prReview.${root}`, undefined)
    }

    this.baseRef   = picked.ref
    this.baseLabel = picked.label
    this.baseType  = picked.type
    await Promise.all([
      this.ctx.workspaceState.update(`taskChanges.base.${root}`,      picked.ref),
      this.ctx.workspaceState.update(`taskChanges.baseLabel.${root}`, picked.label),
      this.ctx.workspaceState.update(`taskChanges.baseType.${root}`,  picked.type),
    ])
    this.syncLabel()
    this.schedule()
  }

  dispose(): void {
    this.disposed = true
    this.subs.forEach(d => d.dispose())
    if (this.timer) clearTimeout(this.timer)
    this._onDidChangeResourceStates.dispose()
    this._onDidChangeBase.dispose()
    this.statusBarItem.dispose()
    this.scm.dispose()
    this.decoProvider.clear(this.repo.rootUri.fsPath)
  }
}
