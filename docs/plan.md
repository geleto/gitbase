# VS Code Extension — Architecture & Design

## SCM Changes View for Branch / Commit / Tag

---

## 1. Purpose

Provide a **task-level diff view in the Source Control panel** showing working-tree changes relative to a selected Git branch, commit, or tag — looking and behaving exactly like the native Changes and Staged Changes panels.

### Primary Use Case

When working iteratively — especially with AI coding agents — you want to commit often while still seeing **the full scope of a task**, not just the delta of the last commit. This extension provides a persistent, task-level diff anchored to a chosen Git reference.

### Comparison Semantics

> All comparisons are: **selected base reference ↔ current working tree.**
> The Git index and HEAD are never comparison targets.

---

## 2. Core Loop

Everything reduces to this:

```
git diff <baseRef> --name-status -z -- → resource states → click → vscode.diff(baseUri, workingUri)
```

The `--` prevents path/ref ambiguity and is required.

---

## 3. Design Principles

- **The Git SCM provider is untouched.** This extension adds a separate, read-only provider.
- **Shell out for diffs, use the Git API for everything else.** The `vscode.git` API v1 is strong for repo discovery, refs, and branch/tag listing — but weak for arbitrary diff surfaces. `git diff` and `git show` via shell are simpler and more reliable.
- **No `repository.show()`.** This method does not exist in Git API v1. Base file content is always fetched via `git show <ref>:<path>`.
- **Fail fast.** If Git is unavailable or the repo is invalid, show an explicit error and stop. No silent degradation.

---

## 4. SCM Panel Structure

```
Source Control panel
├── Git                          ← untouched, owned by VS Code
│   ├── Staged Changes
│   └── Changes
│
└── Task Changes (repo name)     ← this extension
    └── Since <baseRef>          ← single resource group, read-only
        ├── src/foo.ts   [M]
        ├── src/bar.ts   [A]
        └── old/baz.ts   [D]
```

One provider per repository. One resource group. No staging UI. No commit actions.

**Multi-root workspaces:** `gitApi.repositories` is iterated at activation to create one provider per repo. New repos added mid-session are handled via `gitApi.onDidOpenRepository`, which triggers provider creation for the new repo dynamically.

---

## 5. APIs Used

| API | Role |
|-----|------|
| `vscode.git` extension API v1 | Repo discovery, branch/tag/commit listing |
| `vscode.scm.createSourceControl` | SCM panel UI |
| `registerTextDocumentContentProvider` | Base file content (`basegit:` scheme) and empty content (`empty:` scheme) |
| `vscode.diff` command | Diff rendering |
| Git CLI (`git diff`, `git show`) | Change enumeration, base file content |

### Repo Discovery

```ts
const gitExtension = vscode.extensions.getExtension('vscode.git')
const gitApi = gitExtension.exports.getAPI(1)

// Initial repos
for (const repo of gitApi.repositories) {
  createProviderForRepo(repo)
}

// Repos opened mid-session
gitApi.onDidOpenRepository(repo => createProviderForRepo(repo))
```

---

## 6. Change Enumeration

Shell out to Git:

```bash
git diff --name-status -z <baseRef> --
```

Parse the output into resource states with status codes:

| Git status | Decoration |
|------------|------------|
| `A` | Added |
| `M` | Modified |
| `D` | Deleted |
| `R` | Renamed |

**Rename rendering:** Show the new path only, with a Renamed decoration. This matches native Git SCM behavior. The old path is used only to resolve the base-side content.

**Binary files:** During each refresh, run `git diff --numstat -z <ref> --` as a batch call alongside `--name-status`. Binary files output `-\t-\t<path>` instead of line counts — collect these into a Set. When a binary file is clicked, open the native VS Code binary diff (which displays file size and a "files are binary" message) rather than attempting to serve content through the `basegit:` provider.

---

## 7. Base File Content — Virtual Document Providers

Register **two** URI scheme providers. Neither is built into VS Code — both must be registered explicitly or Added/Deleted diffs will blow up silently.

**`basegit:` scheme** — serves base-side file content:

```bash
git show <ref>:<path>
```

**`empty:` scheme** — returns an empty string. Required for Added files (no base) and Deleted files (no working tree side).

### Content Cache (`basegit:` only)

Cache content keyed by `ref:path` to avoid shelling out on every diff panel open or re-render:

- **SHA-based refs** (commits, tags): content is immutable — cache for the entire session.
- **Branch refs**: at refresh time, run `git rev-parse <branch>` once and compare with the cached tip SHA. Invalidate only if the tip has moved. When static, the cache is reused and no `git show` calls are needed.

| Case | Left side URI | Right side URI |
|------|--------------|----------------|
| Modified | `basegit:` | working-tree `file:` |
| Added | `empty:` | working-tree `file:` |
| Deleted | `basegit:` | `empty:` |
| Renamed | `basegit:` (old path) | working-tree `file:` (new path) |

---

## 8. Diff on Click

```ts
vscode.commands.executeCommand(
  'vscode.diff',
  baseUri,      // basegit:// or empty://
  workingUri,   // file on disk
  `foo.ts (since ${baseRef})`
)
```

Identical to how the native Changes panel works.

---

## 9. Refresh Strategy

One trigger covers everything, one debounced handler (~400ms):

```ts
// repository.state.onDidChange fires on any working-tree change Git detects:
// saves, agent writes, deletions, renames — no manual .git filtering needed.
repo.state.onDidChange(() => scheduleRefresh())
```

Also triggers on: base ref change, manual refresh command.

**Why not a `**/*` FS watcher:** `repository.state.onDidChange` is semantically correct (Git-tracked changes only), requires no `.git`/submodule filtering, and reuses what the Git extension already polls. An explicit FS watcher would fire on temp files, build artifacts, and nested `.git` dirs and require careful filtering to avoid the same noise.

### Overlap Protection — "Skip but Mark Dirty"

A simple `if (refreshRunning) return` guard drops the last write in a burst, which is the worst case for agent activity. Use a dirty flag instead:

```ts
let refreshRunning = false
let dirty = false

async function refresh() {
  if (refreshRunning) { dirty = true; return }
  refreshRunning = true
  dirty = false
  try {
    await runGitDiffAndUpdateProvider()
  } finally {
    refreshRunning = false
    if (dirty) refresh()  // re-run if writes arrived during the refresh
  }
}
```

---

## 10. Base Selection UX

Two-level QuickPick:

**Level 1** — title bar button opens a 4-item type picker:
```
Select base…
  ├── Branch…
  ├── Tag…
  ├── Commit…
  └── Enter ref…   (free-text input for raw SHA / any ref string)
```

**Level 2** — selecting Branch, Tag, or Commit opens a second `showQuickPick` listing all items of that type, fetched from the Git API. VS Code's QuickPick natively provides command-palette-style filtering: typing narrows the list in real time. No extra implementation needed.

```ts
const branches = await repo.getBranches({ remote: true })
const pick = await vscode.window.showQuickPick(
  branches.map(b => b.name),
  { placeHolder: 'Select branch…', matchOnDescription: true }
)
```

Large lists (many tags, many commits) are handled by the built-in filtering — the user types to narrow without scrolling.

**Commit list display:** show short SHA + subject line + relative date as description so the list is scannable before typing.

Changing the base triggers a full provider refresh.

---

## 11. Persistence

Stored per repository, per workspace, in `workspaceState`:

```ts
// Key
`taskChanges.base.${repoRoot}`

// Value
// - Branches: store symbolic ref (e.g. "feature/foo") — intentionally tracks tip movement
// - Commits and tags: store full SHA — frozen point in history
```

Display always shows the symbolic name where available.

**Ref validity check:** On every refresh, verify the stored ref still resolves:

```bash
git rev-parse <ref>
```

If it fails (branch deleted, ref gone), clear the resource group, show a warning, and prompt the user to select a new base. Force-push is handled implicitly — the ref still resolves but the diff updates on the next refresh, which is the correct behaviour for a branch-tracking base.

Default when unset: `HEAD` (shows no changes until a meaningful base is selected).

---

## 12. Error Handling

| Condition | Behavior |
|-----------|----------|
| Git extension unavailable | `showErrorMessage(...)`, extension deactivates |
| Invalid / deleted base ref | Clear resource group, show warning, prompt re-selection |
| `git diff` failure | Clear resource group, log error |
| Binary file | Open native VS Code binary diff |
| Repo removed mid-session | Dispose provider, clear state |

No silent degradation. Errors are always surfaced explicitly.

---

## 13. Edge Cases

| Case | Behavior |
|------|----------|
| New file | `empty:` base vs working tree |
| Deleted file | Base vs `empty:` |
| Rename | Base old path vs working new path, shown as new path with [R] |
| Binary file | Native binary diff (file size + "files are binary") |
| Detached HEAD | Supported — HEAD resolves to a SHA |
| Invalid / deleted base ref | Empty group + warning + re-selection prompt |
| Force-pushed branch | Ref still resolves; diff updates on next refresh (correct) |
| Large repo under agent load | Debounce + dirty-flag refresh prevent thrashing |

---

## 14. Activation & Lifecycle

**Activation events** (in `package.json`):
- `workspaceContains:.git` — activates automatically in any Git repo, but not in non-Git workspaces
- `onCommand:<base-selection-commands>` — any base picker command invoked

Do **not** use `*` (eager startup). `onView:scm` does not work here — that event is for custom views contributed via `contributes.views`, not the built-in SCM panel.

**Note:** `gitApi.onDidOpenRepository` is a runtime subscription wired up *inside* the already-activated extension — it is not a VS Code activation event and does not belong in `package.json`.

---

## 15. Implementation Order

1. **Scaffold** — activate, discover repos via Git API, create one SCM provider per repo, wire `onDidOpenRepository` for mid-session repos
2. **Virtual doc providers** — register both `basegit:` and `empty:` schemes explicitly
3. **Change enumeration + diff** — shell `git diff --name-status -z <ref> --`, parse to resource states, wire up `vscode.diff` on click. **Use a hardcoded ref (e.g. `main`) at this stage** to allow full end-to-end testing of the diff flow before the picker exists
4. **Refresh loop** — debounced, wired to `repository.state.onDidChange`, with dirty-flag overlap protection
5. **Base picker** — QuickPick for branch/tag/commit/manual ref, persisted to `workspaceState`, ref validity check on refresh
6. **Content cache** — add `basegit:` caching keyed by `ref:path`, with SHA vs branch invalidation logic
7. **Polish** — A/M/D/R decorations, diff titles, error states, binary file handling

---

## 16. Explicit Non-Goals

- No Git index / staging comparison
- No staging UI
- No commit actions
- No revert-to-base
- No hunk-level operations
- No Proposed APIs
- No custom diff UI

All can be added later without redesign.

---

## 17. Risk Areas — Prototype These First

- **Rename rendering** — verify that showing new path only with [R] decoration renders cleanly in the resource group
- **Binary detection** — confirm `git diff --numstat` `-\t-\t` output is reliable for binary detection across platforms
- **`basegit:` cache invalidation** — test that branch-ref cache correctly clears on refresh while SHA-ref cache persists
- **Large repos under agent load** — validate the dirty-flag refresh pattern under rapid file writes (20+ per second)