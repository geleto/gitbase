import * as vscode from 'vscode'
import * as nodePath from 'path'
import { GitExtension, GitRepository, setGitPath, gitOrNull } from './git'
import { BaseGitContentProvider, EmptyContentProvider } from './content'
import { TaskChangesDecorationProvider } from './decorations'
import { openWithoutAutoReveal } from './workarounds'
import { registerLabelFormatter } from './labels'
import { TaskChangesProvider } from './provider'

// ── Activation ────────────────────────────────────────────────────────────────

const providers = new Map<string, TaskChangesProvider>()

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  providers.clear()
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git')
  if (!ext) {
    vscode.window.showErrorMessage('Task Changes: VS Code Git extension not found. Extension disabled.')
    return
  }
  if (!ext.isActive) await ext.activate()

  const api = ext.exports.getAPI(1)
  setGitPath(api.git.path)
  registerLabelFormatter(ctx)

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

  // onDidOpenRepository handles repos opened after initialization (e.g. multi-root).
  // For the initial scan we must wait for state === 'initialized'; otherwise
  // api.repositories can be empty when vscode.git fires onDidOpenRepository
  // during its own activate() — before we have a chance to register the listener.
  ctx.subscriptions.push(api.onDidOpenRepository(addRepo))
  if (api.state === 'initialized') {
    api.repositories.forEach(addRepo)
  } else {
    ctx.subscriptions.push(api.onDidChangeState(state => {
      if (state === 'initialized') api.repositories.forEach(addRepo)
    }))
  }
  ctx.subscriptions.push(
    api.onDidCloseRepository(repo => {
      const p = providers.get(repo.rootUri.fsPath)
      if (p) { p.dispose(); providers.delete(repo.rootUri.fsPath) }
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
      // A/U files live in the git panel too — use openWithoutAutoReveal so it does not expand.
      if (resource.contextValue === 'A' || resource.contextValue === 'U') {
        void openWithoutAutoReveal(uri)
      } else {
        void vscode.commands.executeCommand('vscode.open', uri)
      }
    }),
    vscode.commands.registerCommand('taskChanges.openUntracked', (uri: vscode.Uri) => {
      void openWithoutAutoReveal(vscode.Uri.from(uri))
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
    vscode.commands.registerCommand('taskChanges.copyPatch', async (resource: vscode.SourceControlResourceState) => {
      if (!resource?.resourceUri) return
      const uri = vscode.Uri.from(resource.resourceUri).with({ fragment: '' })
      const provider = resolveProviderForResource(uri)
      if (!provider) return
      const root  = provider.scm.rootUri!.fsPath
      const fp    = nodePath.relative(root, uri.fsPath).replace(/\\/g, '/')
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
