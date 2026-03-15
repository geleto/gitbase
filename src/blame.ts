/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Adapted from microsoft/vscode — extensions/git/src/blame.ts and extensions/git/src/git.ts
// Changes: scoped to basegit: URIs, simplified cache, no diff-line mapping, no status bar item.

import * as vscode from 'vscode'
import { gitOrNull } from './git'
import { parseBaseUri } from './content'

// ── Blame data types ──────────────────────────────────────────────────────────

interface BlameRange {
  startLineNumber: number
  endLineNumber:   number
}

interface BlameInformation {
  hash:        string
  subject?:    string
  authorName?: string
  authorDate?: number   // unix ms
  ranges:      BlameRange[]
}

// ── Git blame parser ───────────────────────────────────────────────────────────
// Parses `git blame --root --incremental` output.
// Adapted from gitext parseGitBlame() in extensions/git/src/git.ts.

function parseGitBlame(data: string): BlameInformation[] {
  const commitRegex = /^([0-9a-f]{40})/
  const info = new Map<string, BlameInformation>()

  let commitHash:    string | undefined
  let authorName:    string | undefined
  let authorTime:    number | undefined
  let message:       string | undefined
  let startLine:     number | undefined
  let endLine:       number | undefined

  for (const line of data.split(/\r?\n/)) {
    if (!commitHash) {
      const m = line.match(commitRegex)
      if (m) {
        const segs = line.split(' ')
        commitHash = m[1]
        startLine  = Number(segs[2])
        endLine    = Number(segs[2]) + Number(segs[3]) - 1
      }
      continue
    }
    if (line.startsWith('author '))      { authorName = line.slice('author '.length); continue }
    if (line.startsWith('author-time ')) { authorTime = Number(line.slice('author-time '.length)) * 1000; continue }
    if (line.startsWith('summary '))     { message    = line.slice('summary '.length); continue }
    if (line.startsWith('filename ')) {
      if (startLine !== undefined && endLine !== undefined) {
        const existing = info.get(commitHash)
        if (existing) {
          existing.ranges.push({ startLineNumber: startLine, endLineNumber: endLine })
        } else {
          info.set(commitHash, {
            hash:        commitHash,
            subject:     message,
            authorName,
            authorDate:  authorTime,
            ranges:      [{ startLineNumber: startLine, endLineNumber: endLine }],
          })
        }
      }
      commitHash = authorName = authorTime = message = startLine = endLine = undefined
    }
  }

  return Array.from(info.values())
}

// ── Simple LRU cache ──────────────────────────────────────────────────────────

class LRUCache<K, V> {
  private readonly map = new Map<K, V>()
  constructor(private readonly limit: number) {}

  get(key: K): V | undefined {
    const v = this.map.get(key)
    if (v !== undefined) { this.map.delete(key); this.map.set(key, v) }
    return v
  }

  set(key: K, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.limit) {
      this.map.delete(this.map.keys().next().value!)
    }
  }
}

// ── Decoration helpers ────────────────────────────────────────────────────────

function createDecoType(): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('git.blame.editorDecorationForeground'), margin: '0 0 0 3em' },
    isWholeLine: true,
  })
}

function formatDate(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function buildDecorations(
  infos: BlameInformation[],
  lineCount: number,
): vscode.DecorationOptions[] {
  // Build a line-number → blame map (1-based)
  const lineMap = new Map<number, BlameInformation>()
  for (const b of infos) {
    for (const r of b.ranges) {
      for (let ln = r.startLineNumber; ln <= r.endLineNumber; ln++) {
        lineMap.set(ln, b)
      }
    }
  }

  const decos: vscode.DecorationOptions[] = []
  for (let ln = 1; ln <= lineCount; ln++) {
    const b = lineMap.get(ln)
    if (!b) continue
    const date    = b.authorDate ? ` ${formatDate(b.authorDate)}` : ''
    const author  = b.authorName ? ` ${b.authorName}` : ''
    const subject = b.subject ? ` ${b.subject.slice(0, 60)}` : ''
    const text    = `${b.hash.slice(0, 7)}${date}${author} •${subject}`
    decos.push({
      range: new vscode.Range(ln - 1, 0, ln - 1, 0),
      renderOptions: { after: { contentText: text } },
      hoverMessage: buildHover(b),
    })
  }
  return decos
}

function buildHover(b: BlameInformation): vscode.MarkdownString {
  const ms = new vscode.MarkdownString()
  ms.appendMarkdown(`**${b.hash.slice(0, 7)}** — ${b.subject ?? ''}\n\n`)
  if (b.authorName)  ms.appendMarkdown(`*Author:* ${b.authorName}\n\n`)
  if (b.authorDate)  ms.appendMarkdown(`*Date:* ${new Date(b.authorDate).toLocaleString()}\n\n`)
  ms.appendMarkdown(`*Full hash:* \`${b.hash}\``)
  return ms
}

// ── Controller ────────────────────────────────────────────────────────────────

export class GitBaseBlameController implements vscode.Disposable {
  private readonly subs:      vscode.Disposable[] = []
  private readonly cache    = new LRUCache<string, BlameInformation[]>(50)
  private readonly decoType = createDecoType()
  private lastEditor: vscode.TextEditor | undefined

  constructor() {
    this.subs.push(vscode.window.onDidChangeActiveTextEditor(e => this.update(e)))
    this.update(vscode.window.activeTextEditor)
  }

  private async update(editor: vscode.TextEditor | undefined): Promise<void> {
    // Clear blame on the previously decorated editor when switching away
    if (this.lastEditor && this.lastEditor !== editor) {
      this.lastEditor.setDecorations(this.decoType, [])
    }
    this.lastEditor = undefined

    if (!editor || editor.document.uri.scheme !== 'basegit') return

    const { root, ref, fp } = parseBaseUri(editor.document.uri)
    if (!root || !ref || !fp) return

    const cacheKey = editor.document.uri.toString()
    let infos = this.cache.get(cacheKey)

    if (!infos) {
      const raw = await gitOrNull(root, 'blame', '--root', '--incremental', ref, '--', fp)
      if (!raw) return
      infos = parseGitBlame(raw)
      this.cache.set(cacheKey, infos)
    }

    // Guard: if the user switched away while we were awaiting git, skip.
    if (vscode.window.activeTextEditor !== editor) return

    const decos = buildDecorations(infos, editor.document.lineCount)
    editor.setDecorations(this.decoType, decos)
    this.lastEditor = editor
  }

  dispose(): void {
    this.subs.forEach(d => d.dispose())
    this.decoType.dispose()
  }
}
