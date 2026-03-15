import * as vscode from 'vscode'
import * as nodePath from 'path'
import { GitExtension, GitRepository, setGitPath, gitOrNull } from './git'
import { BaseGitContentProvider, EmptyContentProvider } from './content'
import { TaskChangesDecorationProvider } from './decorations'
import { openWithoutAutoReveal } from './workarounds'
import { registerLabelFormatter } from './labels'
import { TaskChangesProvider } from './provider'
import { GitBaseBlameController } from './blame'
import { TaskChangesTimelineProvider } from './timelineProvider'

// ── Activation ────────────────────────────────────────────────────────────────

const providers = new Map<string, TaskChangesProvider>()

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  providers.clear()
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git')
  if (!ext) {
    vscode.window.showErrorMessage('GitBase: VS Code Git extension not found. Extension disabled.')
    return
  }
  if (!ext.isActive) await ext.activate()

  const api = ext.exports.getAPI(1)
  setGitPath(api.git.path)
  registerLabelFormatter(ctx)

  const content          = new BaseGitContentProvider()
  const decoProvider     = new TaskChangesDecorationProvider()
  const timelineProvider = new TaskChangesTimelineProvider(() => providers.values())
  ctx.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('basegit', content),
    vscode.workspace.registerTextDocumentContentProvider('empty',   new EmptyContentProvider()),
    vscode.window.registerFileDecorationProvider(decoProvider),
    decoProvider,
    new GitBaseBlameController(),
    timelineProvider,
  )

  function addRepo(repo: GitRepository): void {
    const root = repo.rootUri.fsPath
    if (providers.has(root)) return
    const p = new TaskChangesProvider(repo, ctx, content, decoProvider)
    providers.set(root, p)
    ctx.subscriptions.push(p)
    // Re-evaluate the Explorer/editor context key whenever this provider's files change
    ctx.subscriptions.push(p.onDidChangeResourceStates(() =>
      updateActiveEditorContext(vscode.window.activeTextEditor)
    ))
    // Refresh the Timeline panel when this repo's base changes
    ctx.subscriptions.push(p.onDidChangeBase(() => timelineProvider.fireChanged()))
  }

  // onDidOpenRepository handles repos opened after initialization (e.g. multi-root).
  // For the initial scan we must wait for state === 'initialized'; otherwise
  // api.repositories can be empty when vscode.git fires onDidOpenRepository
  // during its own activate() — before we have a chance to register the listener.
  // Update status bar visibility and the Explorer/editor "isChangedFile" context key
  // whenever the active editor changes. Called also on repo open/close and provider refresh.
  function updateActiveEditorContext(editor?: vscode.TextEditor): void {
    // Status bars: show only the item for the active editor's repo (hide others in multi-repo)
    if (providers.size <= 1) { providers.forEach(p => p.showStatusBar()) }
    else {
      const owner = editor?.document.uri ? resolveProviderForResource(editor.document.uri) : undefined
      providers.forEach(p => owner && p !== owner ? p.hideStatusBar() : p.showStatusBar())
    }
    // Context key for Explorer/editor menus: true when the active file has GitBase changes
    const uri = editor?.document.uri
    const isChanged = uri?.scheme === 'file'
      ? [...providers.values()].some(p => p.getResourceState(uri) !== undefined)
      : false
    void vscode.commands.executeCommand('setContext', 'taskChanges.isChangedFile', isChanged)
  }
  ctx.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateActiveEditorContext))

  ctx.subscriptions.push(api.onDidOpenRepository(repo => { addRepo(repo); updateActiveEditorContext(vscode.window.activeTextEditor) }))
  if (api.state === 'initialized') {
    api.repositories.forEach(addRepo)
    updateActiveEditorContext(vscode.window.activeTextEditor)
  } else {
    ctx.subscriptions.push(api.onDidChangeState(state => {
      if (state === 'initialized') { api.repositories.forEach(addRepo); updateActiveEditorContext(vscode.window.activeTextEditor) }
    }))
  }
  ctx.subscriptions.push(
    api.onDidCloseRepository(repo => {
      const p = providers.get(repo.rootUri.fsPath)
      if (p) { p.dispose(); providers.delete(repo.rootUri.fsPath) }
      updateActiveEditorContext(vscode.window.activeTextEditor)
    })
  )

  // When called from the scm/title menu, VS Code passes the SourceControl as first arg.
  // When invoked from the command palette with multiple repos open, ask the user to pick.
  async function resolveProvider(sc?: vscode.SourceControl): Promise<TaskChangesProvider | undefined> {
    if (sc) return [...providers.values()].find(p => p.scm === sc)
    if (providers.size === 0) return undefined
    if (providers.size === 1) return [...providers.values()][0]
    const items = [...providers.values()].map(p => ({
      label:       nodePath.basename(p.scm.rootUri?.fsPath ?? '(unknown)'),
      description: p.scm.rootUri?.fsPath,
      provider:    p,
    }))
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select repository' })
    return picked?.provider
  }

  // Helper: resolve the provider that owns the given resource URI.
  // Sort by root path length descending so the most-specific (deepest) repo wins.
  function resolveProviderForResource(uri: vscode.Uri): TaskChangesProvider | undefined {
    return [...providers.values()]
      .sort((a, b) => (b.scm.rootUri?.fsPath.length ?? 0) - (a.scm.rootUri?.fsPath.length ?? 0))
      .find(p => {
        const root = p.scm.rootUri?.fsPath
        return root && (uri.fsPath === root || uri.fsPath.startsWith(root + nodePath.sep))
      })
  }

  ctx.subscriptions.push(
    vscode.commands.registerCommand('taskChanges.selectBase', async (sc?: vscode.SourceControl) => {
      void (await resolveProvider(sc))?.selectBase()
    }),
    vscode.commands.registerCommand('taskChanges.refresh', async (sc?: vscode.SourceControl) => {
      (await resolveProvider(sc))?.schedule()
    }),
    vscode.commands.registerCommand('taskChanges.openFile', (resource: vscode.SourceControlResourceState) => {
      if (!resource?.resourceUri) return
      // resourceUri may arrive as a plain JSON object (not a vscode.Uri instance) when
      // VS Code serialises the resource state before invoking the command from the inline menu.
      // Strip the #gitbase fragment (WORKAROUND_URI_FRAGMENT) before opening.
      const uri = vscode.Uri.from(resource.resourceUri).with({ fragment: '' })
      // All files may appear in the native git panel (e.g. M files appear in Staged Changes
      // when partially staged) — always suppress scm.autoReveal so it does not expand.
      void openWithoutAutoReveal(uri)
    }),
    vscode.commands.registerCommand('taskChanges.openUntracked', (uri: vscode.Uri) => {
      void openWithoutAutoReveal(vscode.Uri.from(uri))
    }),
    // Invoked from Explorer/editor context menus — opens the diff (or file) for the given URI
    // by re-using the same command stored on the resource state (identical to a row click).
    vscode.commands.registerCommand('taskChanges.openDiff', (uri: vscode.Uri) => {
      if (!uri) return
      const fileUri = vscode.Uri.from(uri).with({ fragment: '' })
      resolveProviderForResource(fileUri)?.openDiffForUri(fileUri)
    }),
    vscode.commands.registerCommand('taskChanges.binaryNotice', (filePath: string) => {
      void vscode.window.showInformationMessage(`Binary file: ${nodePath.basename(filePath)} — diff not available.`)
    }),
    vscode.commands.registerCommand('taskChanges.copyPath', (resource: vscode.SourceControlResourceState) => {
      if (!resource?.resourceUri) return
      const uri = vscode.Uri.from(resource.resourceUri).with({ fragment: '' })
      void vscode.env.clipboard.writeText(uri.fsPath)
    }),
    vscode.commands.registerCommand('taskChanges.copyRelativePath', (resource: vscode.SourceControlResourceState) => {
      if (!resource?.resourceUri) return
      const uri = vscode.Uri.from(resource.resourceUri).with({ fragment: '' })
      const provider = resolveProviderForResource(uri)
      void vscode.env.clipboard.writeText(nodePath.relative(provider?.scm.rootUri?.fsPath ?? '', uri.fsPath))
    }),
    vscode.commands.registerCommand('taskChanges.copyPatch', async (resourceOrUri: vscode.SourceControlResourceState | vscode.Uri) => {
      // Resolve URI and context value regardless of invocation source (SCM panel or Explorer/editor)
      let uri: vscode.Uri
      let contextValue: string | undefined
      if (resourceOrUri instanceof vscode.Uri) {
        uri = resourceOrUri.with({ fragment: '' })
        contextValue = resolveProviderForResource(uri)?.getResourceState(uri)?.contextValue
        if (!contextValue) return  // file not currently a GitBase change
      } else {
        if (!resourceOrUri?.resourceUri) return
        uri = vscode.Uri.from(resourceOrUri.resourceUri).with({ fragment: '' })
        contextValue = resourceOrUri.contextValue
      }
      const provider = resolveProviderForResource(uri)
      if (!provider) return
      const root = provider.scm.rootUri!.fsPath
      const fp   = nodePath.relative(root, uri.fsPath).replace(/\\/g, '/')
      if (contextValue === 'U') {
        void vscode.window.showInformationMessage(`Patch not available for untracked file: ${nodePath.basename(uri.fsPath)}`)
        return
      }
      const patch = await gitOrNull(root, 'diff', provider.lastDiffRef, '--', fp)
      if (patch) {
        await vscode.env.clipboard.writeText(patch)
        void vscode.window.showInformationMessage(`Patch copied for ${nodePath.basename(uri.fsPath)}`)
      } else {
        void vscode.window.showInformationMessage(`No changes to copy for ${nodePath.basename(uri.fsPath)}`)
      }
    }),
  )
}

export function deactivate(): void {
  providers.forEach(p => p.dispose())
  providers.clear()
}
