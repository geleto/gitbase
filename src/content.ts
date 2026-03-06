import * as vscode from 'vscode'
import { gitOrNull, isSha } from './git'

// ── URI helpers ───────────────────────────────────────────────────────────────

export const EMPTY_URI = vscode.Uri.parse('empty:empty')

export function makeBaseUri(root: string, ref: string, fp: string, suffix = ''): vscode.Uri {
  return vscode.Uri.from({
    scheme:   'basegit',
    path:     '/' + fp,   // gives VS Code a path to derive the tab label from
    query:    [root, ref, fp].map(encodeURIComponent).join('&'),
    fragment: suffix,     // shown parenthetically in the tab title by the ResourceLabelFormatter
  })
}

function parseBaseUri(uri: vscode.Uri): { root: string; ref: string; fp: string } {
  const [root = '', ref = '', fp = ''] = uri.query.split('&').map(decodeURIComponent)
  return { root, ref, fp }
}

// ── Content providers ─────────────────────────────────────────────────────────

export class BaseGitContentProvider implements vscode.TextDocumentContentProvider {
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
    if (!this.branchCaches.has(bkey)) await this.checkBranchTip(root, ref)
    const entry = this.branchCaches.get(bkey)
    if (!entry) return ''
    if (!entry.files.has(fp)) {
      entry.files.set(fp, await gitOrNull(root, 'show', `${ref}:${fp}`) ?? '')
    }
    return entry.files.get(fp)!
  }
}

export class EmptyContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(): string { return '' }
}
