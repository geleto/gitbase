/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Adapted from microsoft/vscode — extensions/git/src/timelineProvider.ts
// Changes: uses gitOrNull instead of Model, scoped to files in GitBase repos,
// opens basegit: diffs, fires onDidChange when GitBase base selection changes.

import * as vscode from 'vscode'
import * as nodePath from 'path'
import { gitOrNull } from './git'
import { makeBaseUri, EMPTY_URI } from './content'
import { TaskChangesProvider } from './provider'

// ── Commit log ────────────────────────────────────────────────────────────────

interface CommitEntry {
  hash:       string
  authorName: string
  authorDate: number  // unix seconds
  subject:    string
}

async function logFile(root: string, fp: string, limit: number, cursor?: string): Promise<CommitEntry[]> {
  // %x1f = unit separator (field) — git emits ASCII 0x1f; \n separates records; %s strips newlines
  const fmt = '%H%x1f%an%x1f%at%x1f%s'
  const args: string[] = ['log', `--format=${fmt}`, '--follow', `-${limit}`]
  if (cursor) args.push(`${cursor}^`)
  args.push('--', fp)

  const out = await gitOrNull(root, ...args)
  if (!out) return []

  return out.trim().split('\n').filter(Boolean).map(line => {
    const [hash = '', authorName = '', at = '0', ...rest] = line.split('\x1f')
    return { hash, authorName, authorDate: Number(at), subject: rest.join('\x1f') }
  })
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class TaskChangesTimelineProvider implements vscode.TimelineProvider, vscode.Disposable {
  readonly id    = 'taskchanges-history'
  readonly label = 'GitBase History'

  private readonly _onDidChange = new vscode.EventEmitter<vscode.TimelineChangeEvent | undefined>()
  readonly onDidChange          = this._onDidChange.event

  private readonly subs: vscode.Disposable[] = []
  private readonly reg: vscode.Disposable

  constructor(private readonly getProviders: () => IterableIterator<TaskChangesProvider>) {
    this.reg = vscode.workspace.registerTimelineProvider('file', this)
  }

  /** Call whenever any provider's base changes so VS Code refreshes the Timeline panel. */
  fireChanged(): void {
    this._onDidChange.fire(undefined)
  }

  async provideTimeline(
    uri:     vscode.Uri,
    options: vscode.TimelineOptions,
    token:   vscode.CancellationToken,
  ): Promise<vscode.Timeline> {
    if (uri.scheme !== 'file') return { items: [] }

    const provider = this.resolveProvider(uri)
    if (!provider) return { items: [] }

    const root = provider.scm.rootUri!.fsPath
    const fp   = nodePath.relative(root, uri.fsPath).replace(/\\/g, '/')
    if (!fp || fp.startsWith('..')) return { items: [] }

    const limit  = typeof options.limit === 'number' ? options.limit + 1 : 51
    const cursor = typeof options.cursor === 'string' ? options.cursor : undefined

    const entries = await logFile(root, fp, limit, cursor)
    if (token.isCancellationRequested) return { items: [] }

    const hasMore = entries.length >= limit
    const extraHash = hasMore ? entries[entries.length - 1]?.hash : undefined
    if (hasMore) entries.splice(entries.length - 1, 1)

    const paging = hasMore ? { cursor: entries[entries.length - 1]?.hash } : undefined

    const items: vscode.TimelineItem[] = entries.map((c, i) => {
      const prevHash = i < entries.length - 1 ? entries[i + 1]?.hash : extraHash
      const item     = new vscode.TimelineItem(c.subject || c.hash.slice(0, 7), c.authorDate * 1000)

      item.id          = c.hash
      item.description = c.authorName
      item.iconPath    = new vscode.ThemeIcon('git-commit')
      item.tooltip     = new vscode.MarkdownString(
        `**${c.hash.slice(0, 7)}** — ${c.subject}\n\n` +
        `*Author:* ${c.authorName}\n\n` +
        `*Full hash:* \`${c.hash}\``,
      )

      // Open diff: left = parent version, right = this commit's version
      const label   = c.subject.slice(0, 40) || c.hash.slice(0, 7)
      const leftUri = prevHash ? makeBaseUri(root, prevHash, fp, label) : EMPTY_URI
      const rightUri = makeBaseUri(root, c.hash, fp, label)
      const title   = `${nodePath.basename(fp)} (${c.hash.slice(0, 7)})`

      item.command = {
        title:     'Open Diff',
        command:   'vscode.diff',
        arguments: [leftUri, rightUri, title],
      }

      return item
    })

    return { items, paging }
  }

  private resolveProvider(uri: vscode.Uri): TaskChangesProvider | undefined {
    return [...this.getProviders()]
      .sort((a, b) => (b.scm.rootUri?.fsPath.length ?? 0) - (a.scm.rootUri?.fsPath.length ?? 0))
      .find(p => {
        const root = p.scm.rootUri?.fsPath
        return root && (uri.fsPath === root || uri.fsPath.startsWith(root + nodePath.sep))
      })
  }

  dispose(): void {
    this.subs.forEach(d => d.dispose())
    this.reg.dispose()
    this._onDidChange.dispose()
  }
}
