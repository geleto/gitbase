import * as vscode from 'vscode'
import * as nodePath from 'path'
import { GitRepository, RawChange, gitOrNull, getMergeBase, detectDefaultBranch, detectRefType, parseNameStatus, parseBinarySet } from './git'
import { EMPTY_URI, makeBaseUri, BaseGitContentProvider } from './content'
import { DECO, TaskChangesDecorationProvider } from './decorations'
import { WORKAROUND_URI_FRAGMENT, assertScmContext } from './workarounds'

// ── TaskChangesProvider ───────────────────────────────────────────────────────

export class TaskChangesProvider implements vscode.Disposable {
  static readonly NO_BASE_LABEL = 'HEAD · Select a base to begin'

  readonly scm: vscode.SourceControl
  private readonly group: vscode.SourceControlResourceGroup
  private readonly subs: vscode.Disposable[] = []

  private baseRef         = 'HEAD'
  private baseLabel       = 'HEAD'
  private baseType: 'Branch' | 'Tag' | 'Commit' | undefined = undefined
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

    const stored = ctx.workspaceState.get<string>(`taskChanges.base.${root}`)
    if (stored) {
      this.baseRef   = stored
      this.baseLabel = ctx.workspaceState.get<string>(`taskChanges.baseLabel.${root}`) ?? stored
      this.baseType  = ctx.workspaceState.get<'Branch' | 'Tag' | 'Commit'>(`taskChanges.baseType.${root}`)
      this.syncLabel()
    }

    this.subs.push(repo.state.onDidChange(() => this.schedule()))
    this.schedule()
  }

  private syncLabel(): void {
    this.group.label = this.baseLabel === 'HEAD'
      ? TaskChangesProvider.NO_BASE_LABEL
      : !this.baseType
        ? this.baseLabel
        : `${this.baseType} · ${this.baseLabel}`
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
      // Always notify — the stored base is gone.
      void vscode.window.showWarningMessage(
        `GitBase: base ref "${ref}" no longer exists. Select a new base to continue.`,
        'Select Base',
      ).then(action => {
        if (action === 'Select Base') void vscode.commands.executeCommand('taskChanges.selectBase', this.scm)
      })
      // Independently try to auto-recover; if it works, the panel self-heals.
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
        this.schedule()
      } else {
        this.autoDetectDone = false
      }
      return
    }

    await this.content.checkBranchTip(root, ref)

    // For branches, diff against the merge base so only our changes are shown,
    // not diverging commits on the base branch.
    let diffRef = ref
    if (this.baseType === 'Branch') {
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
    assertScmContext()
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
      baseUri  = makeBaseUri(root, ref, c.path.replace(/\\/g, '/'), 'Deleted')
      rightUri = EMPTY_URI
    } else {
      // M or R — for renames the base side uses the old path
      const baseFp = (status === 'R' ? c.oldPath! : c.path).replace(/\\/g, '/')
      baseUri  = makeBaseUri(root, ref, baseFp, `since ${this.baseLabel}`)
      rightUri = workUri
    }

    const d = DECO[status] ?? DECO['M']!
    const diffTitle = `${nodePath.basename(c.path)} (since ${this.baseLabel})`

    const command: vscode.Command = isBin
      ? { title: 'Binary file', command: 'taskChanges.binaryNotice', arguments: [c.path] }
      : (status === 'A' || status === 'U')
        ? { title: 'Open file', command: 'taskChanges.openUntracked',     arguments: [workUri] }
        : status === 'D'
          ? { title: 'Open file', command: 'vscode.open', arguments: [baseUri] }
          : { title: 'Open diff', command: 'vscode.diff', arguments: [baseUri, rightUri, diffTitle] }

    const decorations: vscode.SourceControlResourceDecorations = {
      strikeThrough: d.strikeThrough,
    }

    return { resourceUri, decorations, command, contextValue: status }
  }

  async selectBase(): Promise<void> {
    const root = this.repo.rootUri.fsPath

    // Detect default branch for the one-click shortcut at the top of the picker.
    const defaultBranch = await detectDefaultBranch(root)

    type TypeItem = vscode.QuickPickItem & { key: string }
    const typeItems: TypeItem[] = []
    if (defaultBranch) {
      typeItems.push({ label: 'Default branch', description: defaultBranch, key: 'default' })
      typeItems.push({ label: '', kind: vscode.QuickPickItemKind.Separator, key: '' })
    }
    typeItems.push(
      { label: 'Branch…',    key: 'branch' },
      { label: 'Tag…',       key: 'tag'    },
      { label: 'Commit…',    key: 'commit' },
      { label: 'Enter ref…', key: 'ref'    },
    )

    const typeItem = await vscode.window.showQuickPick(typeItems, { placeHolder: 'Select base type' })
    if (!typeItem) return

    // Default branch: detectDefaultBranch already verified the ref, apply directly.
    if (typeItem.key === 'default') {
      this.baseRef   = defaultBranch!
      this.baseLabel = defaultBranch!
      this.baseType  = 'Branch'
      await Promise.all([
        this.ctx.workspaceState.update(`taskChanges.base.${root}`,      this.baseRef),
        this.ctx.workspaceState.update(`taskChanges.baseLabel.${root}`, this.baseLabel),
        this.ctx.workspaceState.update(`taskChanges.baseType.${root}`,  this.baseType),
      ])
      this.syncLabel()
      this.schedule()
      return
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

    } else {  // 'ref'
      newRef = await vscode.window.showInputBox({ prompt: 'Enter a branch name, tag, or SHA' })
    }

    if (!newRef) return

    const resolved = (await gitOrNull(root, 'rev-parse', '--verify', newRef))?.trim()
    if (!resolved) {
      void vscode.window.showErrorMessage(`Task Changes: "${newRef}" is not a valid Git ref.`)
      return
    }

    // Branches: store symbolic name so the diff tracks tip movement.
    // Tags & commits: store the full SHA so the diff is frozen.
    // Enter ref: store as typed (SHA → frozen, branch name → tracks tip).
    this.baseRef   = (typeItem.key === 'branch' || typeItem.key === 'ref') ? newRef : resolved
    this.baseLabel = newLabel ?? newRef   // commits use subject; everything else uses the ref name
    this.baseType  = typeItem.key === 'branch' ? 'Branch'
                   : typeItem.key === 'tag'    ? 'Tag'
                   : typeItem.key === 'commit' ? 'Commit'
                   : await detectRefType(root, newRef)

    await this.ctx.workspaceState.update(`taskChanges.base.${root}`,      this.baseRef)
    await this.ctx.workspaceState.update(`taskChanges.baseLabel.${root}`, this.baseLabel)
    await this.ctx.workspaceState.update(`taskChanges.baseType.${root}`,  this.baseType)
    this.syncLabel()
    this.schedule()
  }

  dispose(): void {
    this.disposed = true
    this.subs.forEach(d => d.dispose())
    if (this.timer) clearTimeout(this.timer)
    this.scm.dispose()
    this.decoProvider.clear(this.repo.rootUri.fsPath)
  }
}
