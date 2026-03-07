import * as vscode from 'vscode'
import { gitOrNull, detectDefaultBranch, detectRefType } from './git'

export interface BaseSelection {
  readonly ref:   string
  readonly label: string
  readonly type:  'Branch' | 'Tag' | 'Commit' | undefined
}

/**
 * Shows a multi-step quick pick to select a base ref.
 * Returns the selection or undefined if the user cancelled.
 */
export async function pickBase(root: string): Promise<BaseSelection | undefined> {
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
  if (!typeItem) return undefined

  // Default branch: detectDefaultBranch already verified the ref.
  if (typeItem.key === 'default') {
    return { ref: defaultBranch!, label: defaultBranch!, type: 'Branch' }
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
    if (!out) return undefined

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

  if (!newRef) return undefined

  const resolved = (await gitOrNull(root, 'rev-parse', '--verify', newRef))?.trim()
  if (!resolved) {
    void vscode.window.showErrorMessage(`Task Changes: "${newRef}" is not a valid Git ref.`)
    return undefined
  }

  // Branches: store symbolic name so the diff tracks tip movement.
  // Tags & commits: store the full SHA so the diff is frozen.
  // Enter ref: store as typed (SHA → frozen, branch name → tracks tip).
  const ref   = (typeItem.key === 'branch' || typeItem.key === 'ref') ? newRef : resolved
  const label = newLabel ?? newRef
  const type  = typeItem.key === 'branch' ? 'Branch'
               : typeItem.key === 'tag'    ? 'Tag'
               : typeItem.key === 'commit' ? 'Commit'
               : await detectRefType(root, newRef)

  return { ref, label, type }
}
