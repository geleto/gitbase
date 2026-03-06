import * as vscode from 'vscode'
import * as nodePath from 'path'
import { RawChange } from './git'
import { WORKAROUND_URI_FRAGMENT, WORKAROUND_DOUBLE_BADGE } from './workarounds'

// ── Decoration constants ───────────────────────────────────────────────────────

interface Deco { letter: string; color: vscode.ThemeColor; strikeThrough: boolean }

export const DECO: Record<string, Deco> = {
  A: { letter: 'A', color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),    strikeThrough: false },
  M: { letter: 'M', color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'), strikeThrough: false },
  D: { letter: 'D', color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),  strikeThrough: true  },
  R: { letter: 'R', color: new vscode.ThemeColor('gitDecoration.renamedResourceForeground'),  strikeThrough: false },
}

const STATUS_LABEL: Record<string, string> = {
  A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed',
}

// ── File decoration provider ──────────────────────────────────────────────────

export class TaskChangesDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[]>()
  readonly onDidChangeFileDecorations = this._onDidChange.event

  private readonly byRoot = new Map<string, Map<string, vscode.Uri>>()
  private readonly decos  = new Map<string, vscode.FileDecoration>()

  update(root: string, changes: RawChange[], dirtyPaths: Set<string>): void {
    const old  = this.byRoot.get(root) ?? new Map<string, vscode.Uri>()
    const next = new Map<string, vscode.Uri>()
    const fired: vscode.Uri[] = []

    for (const c of changes) {
      const fileUri = vscode.Uri.file(nodePath.join(root, c.path))
      const d    = DECO[c.status] ?? DECO['M']
      const deco = new vscode.FileDecoration(d.letter, STATUS_LABEL[c.status] ?? 'Modified', d.color)

      // SCM-panel decoration: keyed by the fragment URI used as resourceUri.
      if (WORKAROUND_URI_FRAGMENT) {
        const fragUri = fileUri.with({ fragment: 'gitbase' })
        const fragKey = fragUri.toString()
        next.set(fragKey, fragUri)
        this.decos.set(fragKey, deco)
        fired.push(fragUri)
      }

      // Explorer decoration: plain file URI, skipped when git already decorates it.
      if (!WORKAROUND_DOUBLE_BADGE || !dirtyPaths.has(c.path)) {
        const fileKey = fileUri.toString()
        next.set(fileKey, fileUri)
        this.decos.set(fileKey, deco)
        fired.push(fileUri)
      }
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
