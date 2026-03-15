# New Features

Proposed additions to GitBase, ordered by priority. Keyboard shortcuts and configuration settings are excluded.

---

## 1. Status Bar Item · High Priority

### What it does
A persistent status bar item (bottom bar) showing the currently selected base at all times — regardless of whether the SCM panel is open. Clicking it invokes `taskChanges.selectBase` for the relevant repository.

**Example appearance:**
- `$(git-branch) main` — Branch base
- `$(tag) v2.1.0` — Tag base
- `$(git-commit) abc1234…` — Commit base
- `$(github) PR #42` — PR base
- `$(git-branch) Select base…` — No base selected

### How gitext implements it
`statusbar.ts` defines `CheckoutStatusBar` and `SyncStatusBar`, composed by `StatusBarCommands`. The checkout bar:
- Holds a `Command` object whose `title` is built from an icon + label
- Icon switches on repo state: `$(lock)` for protected branch, `$(git-branch-changes)` for dirty, `$(git-branch)` for clean, `$(tag)` for tags, `$(git-commit)` for detached HEAD
- Updates on `repository.onDidRunGitStatus` and `repository.onDidChangeOperations`
- The command argument is `this.repository.sourceControl` — so the same command works for multi-repo

The `StatusBarCommands` instance is created per-repository and feeds its `commands` array into VSCode's status bar via the `SourceControl` API (it's wired into `repository.ts`, which calls `window.createStatusBarItem` and keeps it updated).

### How gitbase should implement it
Gitext's approach is heavier than needed because it also tracks sync state, operations, remotes, etc. For gitbase, the status bar item is simpler:

- **One item per provider** — create in `TaskChangesProvider` constructor via `vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)`
- **Update in `syncLabel()`** — this method is already the single place where label/type changes; add status bar text update there
- **Multi-repo:** when the active editor changes, show the status bar item for the repo that owns the active file; hide the others. Wire this via `window.onDidChangeActiveTextEditor` in `extension.ts`
- **Command:** `{ command: 'taskChanges.selectBase', arguments: [this.scm] }` — same pattern as gitext's checkout bar passing `sourceControl` as the argument
- **Dispose** the status bar item in `TaskChangesProvider.dispose()`

### Icon mapping
| `baseType` | Icon |
|---|---|
| `'Branch'` | `$(git-branch)` |
| `'Tag'` | `$(tag)` |
| `'Commit'` | `$(git-commit)` |
| `'PR'` | `$(github)` |
| `undefined` (no base) | `$(git-branch)` with text `Select base…` |

### Reference files in gitext
- [`gitext/src/statusbar.ts`](../gitext/src/statusbar.ts) — `CheckoutStatusBar` class, `getIcon()`, `command` getter (lines 20–129)
- [`gitext/src/statusbar.ts`](../gitext/src/statusbar.ts) — `StatusBarCommands` (lines 288–316)

### Files to modify in gitbase
- [`src/provider.ts`](../src/provider.ts) — add `private statusBarItem: vscode.StatusBarItem`; update in `syncLabel()`; dispose in `dispose()`
- [`src/extension.ts`](../src/extension.ts) — add `window.onDidChangeActiveTextEditor` handler to show/hide per-repo items using `resolveProviderForResource`

### Implementation assessment
- **New file:** No — the item is a field on `TaskChangesProvider`; no distinct interface class is needed
- **Difficulty:** Easy
- **Estimated size:** ~60 lines total across the two modified files
- **License:** Pattern-only reuse from gitext — no attribution required
- **Test plan impact:** Add parallel status bar assertion to each picker step in plan 01 Section D (same action, second surface to verify). Add a new section to plan 04 verifying the item switches to the active file's repo on `onDidChangeActiveTextEditor`.

---

## 2. Quick Diff Provider · High Priority

### What it does
Registers gitbase as a `QuickDiffProvider` on the `SourceControl` object, so that when a file is open in the editor, the **gutter** shows colored bars indicating which lines are added, modified, or removed **relative to the selected base** — not relative to the git index. This gives immediate visual feedback without having to click into the diff panel.

### How gitext implements it
`quickDiffProvider.ts` defines `GitQuickDiffProvider implements vscode.QuickDiffProvider` with a single method:

```ts
async provideOriginalResource(uri: Uri): Promise<Uri | undefined>
```

It:
1. Returns `undefined` for non-`file:` URIs, symlinks, `.git`-internal paths, ignored files, and untracked files
2. Returns `toGitUri(uri, '', { replaceFileExtension: true })` — a `git:`-scheme URI pointing to the index version of the file

The provider is assigned to `sourceControl.quickDiffProvider = new GitQuickDiffProvider(...)` — this is the built-in `SourceControl` property (not a separate registration call).

`StagedResourceQuickDiffProvider` is a second variant that returns `toGitUri(uri, 'HEAD', ...)` for staged files — gitbase does not need this.

### How gitbase should implement it
The approach is the same: assign `this.scm.quickDiffProvider` in `TaskChangesProvider`. The key difference is **what URI to return**:

- Gitext returns a `git:` URI pointing to the index. Gitbase must return a `basegit:` URI pointing to the file at `this.lastDiffRef` — the same URI used on the base side of `vscode.diff` in `makeState()`.
- Use `makeBaseUri(root, this.lastDiffRef, relativePath)` from `content.ts`
- The content provider `BaseGitContentProvider` already handles this URI and caches content — no new infrastructure needed

**Guard conditions** (same spirit as gitext):
- Skip non-`file:` URIs
- Skip files not inside this repo root
- Skip untracked files (status `'U'`) — check against `group.resourceStates.some(r => r.contextValue === 'U' && r.resourceUri.fsPath === uri.fsPath)`
- Skip deleted files (status `'D'`) — the working file no longer exists, gutter diff makes no sense
- Return `undefined` if `baseRef === 'HEAD'` and no base is selected (no meaningful diff)

### Implementation approach
No new file. Make `TaskChangesProvider` implement `vscode.QuickDiffProvider` directly — add `provideOriginalResource()` as a method on the class and assign `this.scm.quickDiffProvider = this` in the constructor. The implementation is a single method and is tightly coupled to the provider's data (`lastDiffRef`, `group.resourceStates`, `scm.rootUri`). A separate file would have no standalone value.

Add `provideOriginalResource(uri)` to `TaskChangesProvider`:
```ts
provideOriginalResource(uri: vscode.Uri): vscode.Uri | undefined {
    if (uri.scheme !== 'file') return undefined
    if (this.baseRef === 'HEAD') return undefined
    const root = this.repo.rootUri.fsPath
    if (!uri.fsPath.startsWith(root + nodePath.sep) && uri.fsPath !== root) return undefined
    const rel = nodePath.relative(root, uri.fsPath).replace(/\\/g, '/')
    const state = this.group.resourceStates.find(r =>
        vscode.Uri.from(r.resourceUri).with({ fragment: '' }).fsPath === uri.fsPath)
    if (!state || state.contextValue === 'U' || state.contextValue === 'D') return undefined
    return makeBaseUri(root, this.lastDiffRef, rel)
}
```

### Reference files in gitext
- [`gitext/src/quickDiffProvider.ts`](../gitext/src/quickDiffProvider.ts) — entire file, especially `provideOriginalResource` (lines 21–79)

### Files to modify in gitbase
- [`src/provider.ts`](../src/provider.ts) — implement `vscode.QuickDiffProvider` on the class; add `provideOriginalResource()`; assign `this.scm.quickDiffProvider = this` in constructor

### Implementation assessment
- **New file:** No — single method, lives on `TaskChangesProvider` directly
- **Difficulty:** Very Easy
- **Estimated size:** ~20 lines added to `provider.ts`
- **License:** Adapted from gitext structure — add Microsoft header comment to the method block or a file-level notice
- **Test plan impact:** Add new **Section G: Quick Diff Gutter** to plan 01. Uses the existing file states (M, U, D) from Section A with no extra setup. Scenarios: open M file → gutter shows markers; open U file → no gutter markers; open D file → no gutter markers; change base → gutter updates.

---

## 3. Explorer & Editor Context Menus · Medium Priority

### What it does
Adds gitbase actions to:
- **Explorer right-click** — "Open Diff Against Base" on any file that has changes
- **Editor title bar** — "Copy Patch" button/menu item when the active file has changes

Both actions are already implemented as commands (`taskChanges.openFile`, `taskChanges.copyPatch`) but are only wired into the SCM panel's resource state context menus.

### How gitext implements it
In `package.json`, gitext registers entries under `"explorer/context"` and `"editor/title"` with `when` conditions that check context keys set via `vscode.commands.executeCommand('setContext', ...)`. For example:

```json
"explorer/context": [
  { "command": "git.openChange", "when": "git.hasChanges && resourceScheme == file", "group": "3_compare@1" }
],
"editor/title": [
  { "command": "git.openFile", "when": "git.hasOpenedRepo && resourceScheme == git", "group": "navigation" }
]
```

The `when` conditions rely on context keys that the extension sets dynamically as state changes.

### How gitbase should implement it
**Two parts: `package.json` menu entries + a context key:**

**`package.json`** additions:
```json
"explorer/context": [
  {
    "command": "taskChanges.openFile",
    "when": "taskChanges.isChangedFile && resourceScheme == file",
    "group": "3_compare@1"
  },
  {
    "command": "taskChanges.copyPatch",
    "when": "taskChanges.isChangedFile && resourceScheme == file",
    "group": "3_compare@2"
  }
],
"editor/title": [
  {
    "command": "taskChanges.copyPatch",
    "when": "taskChanges.isChangedFile && resourceScheme == file",
    "group": "1_diff@1"
  }
]
```

**Context key `taskChanges.isChangedFile`:** set to `true` when the active editor or explorer selection is a file present in any provider's `group.resourceStates`. Managed via `window.onDidChangeActiveTextEditor` in `extension.ts`.

**Command argument handling:** when invoked from the explorer/editor, the command receives a `vscode.Uri` instead of a `vscode.SourceControlResourceState`. The existing `taskChanges.openFile` and `taskChanges.copyPatch` handlers receive `resource.resourceUri` from SCM state — they need to accept `Uri | SourceControlResourceState` and use `resolveProviderForResource` to find the correct provider when given a bare URI.

### Reference files in gitext
- `gitext/package.json` — search for `"explorer/context"` and `"editor/title"` in the `menus` contributes section

### Files to modify in gitbase
- [`package.json`](../package.json) — add `"explorer/context"` and `"editor/title"` entries under `contributes.menus`
- [`src/extension.ts`](../src/extension.ts) — add `window.onDidChangeActiveTextEditor` handler to `setContext('taskChanges.isChangedFile', ...)`; update `taskChanges.openFile` and `taskChanges.copyPatch` handlers to accept `Uri | SourceControlResourceState`

### Implementation assessment
- **New file:** No — purely `package.json` menu entries plus minor changes to existing command handlers
- **Difficulty:** Easy
- **Estimated size:** ~20 lines JSON in `package.json` + ~40 lines TypeScript in `extension.ts`
- **License:** No code copied — no attribution needed
- **Test plan impact:** Add two new steps to plan 01 **Section C** (invoke "Open Diff Against Base" from Explorer right-click on FILE_M; invoke "Copy Patch" from editor title bar — verify same result as SCM panel invocations). Add one step to plan 04 **Section D** verifying that Explorer right-click on a file in repo B resolves to repo B's provider.

---

## 4. Git Blame in Diff View · Medium Priority

### What it does
When the base side of a gitbase diff is open (a `basegit:` URI document), show inline blame annotations at the end of each line: author name and relative time (e.g. `Alice, 3 days ago`). Hovering the annotation shows a richer tooltip with commit hash, full message, and date.

**Scope:** blame only on `basegit:` documents — not on working-tree files. This is simpler than gitext's full blame feature and stays purely read-only.

### How gitext implements it
`blame.ts` contains three main classes:

**`GitBlameController`** — the orchestrator:
- Listens on `window.onDidChangeActiveTextEditor`, `window.onDidChangeTextEditorSelection`, `window.onDidChangeTextEditorDiffInformation`
- `_getBlameInformation(resource, commit)` — runs `repository.blame2(fsPath, commit)` which executes `git blame -p <commit> -- <file>`, then caches result in `GitBlameInformationCache` (an LRU cache keyed by `root + ref + path`)
- `_updateTextEditorBlameInformation()` — maps selected line numbers through the diff information to find the original line in the base file, then looks up blame for those original lines
- Fires `onDidChangeBlameInformation` event consumed by decorations and status bar

**`GitBlameEditorDecoration`** — renders inline `after` text:
- Creates a `TextEditorDecorationType` with `after: { color: ThemeColor('git.blame.editorDecorationForeground') }`
- In `_onDidChangeBlameInformation()`, builds a `DecorationOptions[]` array — one per selected line — using `_createDecoration(lineNumber, contentText)`
- `_createDecoration` returns `{ range: new Range(pos, pos), renderOptions: { after: { contentText, margin: '0 0 0 50px' } } }`
- Registers a `languages.registerHoverProvider` for the active document path via `provideHover()`

**`GitBlameStatusBarItem`** — shows one-liner in status bar (optional for gitbase).

**Blame parsing** is in `gitext/src/git.ts` — `Repository.blame2()` runs `git blame -p <commit> -- <file>` and parses the porcelain format into `BlameInformation[]` where each entry has `hash`, `authorName`, `authorEmail`, `authorDate`, `subject`, and `ranges: { startLineNumber, endLineNumber }[]`.

**`LRUCache`** in `gitext/src/cache.ts` — a simple generic LRU cache used to avoid re-running blame on the same file+commit.

### How gitbase should implement it (simplified)

Only handle `basegit:` scheme editors. This is simpler because:
- The file, ref, and root are directly encoded in the URI — no need to detect which commit the editor is at
- No index/working-tree diff mapping required (the base file is fixed, not modified)
- No need for the complex `TextEditorDiffInformation` handling gitext does

**New file `src/blame.ts`:**

```ts
class GitBaseBlameController {
    // Listen on window.onDidChangeActiveTextEditor
    // When uri.scheme === 'basegit':
    //   parse root, ref, fp from uri.query (same logic as parseBaseUri in content.ts — export it)
    //   run: gitOrNull(root, 'blame', '--porcelain', ref, '--', fp)
    //   parse porcelain output into per-line records
    //   cache by uri.toString() with LRU eviction
    //   set after-decorations on the editor
    //   register hover provider for this document
}
```

**Blame output parsing:** `git blame --porcelain <ref> -- <fp>` groups output by hunk. Each group starts with `<40-char-hash> <orig-line> <final-line> [<n>]`, followed by header lines (`author`, `author-mail`, `author-time`, `summary`, etc.) then a tab-prefixed content line. The `final-line` field gives the 1-based line number in the displayed file.

**Decoration pattern** — copy directly from gitext:
```ts
const decoration = window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('git.blame.editorDecorationForeground') }
})
// Per-line:
{ range: new Range(new Position(lineNumber, Number.MAX_SAFE_INTEGER), ...), renderOptions: { after: { contentText: 'Alice, 3 days ago', margin: '0 0 0 50px' } } }
```

**Hover pattern** — register via `languages.registerHoverProvider({ scheme: 'basegit' }, provider)` — scoped to the scheme so it doesn't affect other editors. Return a `MarkdownString` with hash, author, date, and subject.

**`parseBaseUri` must be exported** from `content.ts` so `blame.ts` can decode the URI.

### Reference files in gitext
- [`gitext/src/blame.ts`](../gitext/src/blame.ts) — `GitBlameController` (lines 156–534), `GitBlameEditorDecoration` (lines 536–673), `_createDecoration()` (lines 643–651)
- [`gitext/src/git.ts`](../gitext/src/git.ts) — search for `blame2` — the method that calls `git blame -p` and parses porcelain output into `BlameInformation[]`
- [`gitext/src/cache.ts`](../gitext/src/cache.ts) — `LRUCache` class (copy or adapt for gitbase)
- [`gitext/src/util.ts`](../gitext/src/util.ts) — `fromNow()` for relative time formatting, `truncate()`

### Files to modify in gitbase
- New file [`src/blame.ts`](../src/blame.ts)
- [`src/content.ts`](../src/content.ts) — export `parseBaseUri` (currently unexported; blame needs it to decode `basegit:` URIs)
- [`src/extension.ts`](../src/extension.ts) — instantiate `GitBaseBlameController` and push to `ctx.subscriptions`

### Implementation assessment
- **New file:** Yes — substantial (~160 lines), implements two distinct VS Code interfaces (`TextEditorDecorationType` management + `HoverProvider`), contains its own blame parser and LRU cache. Matches the pattern set by `decorations.ts`. Adding to an existing file would bloat it significantly.
- **Difficulty:** Hard (relative to the other features) — requires writing a `git blame --porcelain` output parser, a `fromNow()` relative-time helper, an LRU cache, editor decorations, and a scoped hover provider
- **Estimated size:** ~160 lines in `src/blame.ts` + 1 line in `content.ts` + ~10 lines in `extension.ts`
- **License:** `LRUCache` and `_createDecoration`/`fromNow` patterns are direct copies from gitext — add the Microsoft MIT copyright header to `src/blame.ts`
- **Test plan impact:** New plan **`combined-06-blame-timeline.md`** Section A. Requires a repo with multiple commits in the task range that each touch the same file (so different lines have different blame entries). Scenarios: open a diff → observe base-side annotations → hover for tooltip → verify author/date shown correctly → verify annotations absent on the base side of an Added file → change base → annotations update.

---

## 5. Timeline Provider · Medium Priority

### What it does
Registers gitbase as a `vscode.TimelineProvider` so the VS Code **Timeline** panel (at the bottom of the Explorer sidebar) shows — for the currently open file — the commits between the selected base and HEAD that touched that file. Each item opens a diff for that individual commit.

This is distinct from gitext's "Git History" timeline (which shows the full file history). The gitbase timeline is scoped to **your task's commits for that file** — a focused view.

### How gitext implements it
`timelineProvider.ts` defines `GitTimelineProvider implements vscode.TimelineProvider`:

- `id = 'git-history'`, `label = 'Git History'`
- `provideTimeline(uri, options, token)`:
  - Gets the repo via `model.getRepository(uri)`
  - Calls `repo.logFile(uri, { maxEntries, hash, follow, shortStats }, token)` which runs `git log --follow --format=... -- <file>`
  - Creates a `GitTimelineItem` per commit with `ref = c.hash`, `previousRef = commits[index+1]?.hash ?? emptyTree`
  - Sets `item.command` to open a diff (resolved via `commands.resolveTimelineOpenDiffCommand`)
  - Also adds "Staged Changes" and "Uncommitted Changes" entries at the top when `options.cursor === undefined`
  - Supports pagination via `paging.cursor`
- Registered via `workspace.registerTimelineProvider(['file', 'git', 'vscode-remote', ...], this)`
- Fires `onDidChange` on repository events: status change, operation run, file change

### How gitbase should implement it
**New file `src/timelineProvider.ts`:**

**`provideTimeline(uri, options, token)`:**
1. Find the `TaskChangesProvider` for this URI (using the `providers` map from `extension.ts`)
2. If `provider.baseRef === 'HEAD'` (no base selected), return `{ items: [] }`
3. Run: `git log <provider.lastDiffRef>..HEAD --follow --format=%H%x00%s%x00%an%x00%ae%x00%at --name-only -- <relativePath>`
   - `<provider.lastDiffRef>..HEAD` scopes to only the task's commits
   - `--follow` handles renames
4. Parse output into commit records
5. For each commit, create a `vscode.TimelineItem`:
   - `label` = commit subject (first line of message)
   - `timestamp` = author timestamp
   - `iconPath` = `new vscode.ThemeIcon('git-commit')`
   - `description` = author name (optional)
   - `command` = `{ command: 'vscode.diff', arguments: [baseUri, rightUri, title] }` where:
     - `baseUri = makeBaseUri(root, commit + '^', relativePath)` — parent commit's version
     - `rightUri = makeBaseUri(root, commit, relativePath)` — this commit's version
6. Support pagination using `options.limit` and `options.cursor`

**`onDidChange` triggers:** fire when:
- The provider's `lastDiffRef` changes (base was changed)
- The provider's resource states are refreshed (on `repo.state.onDidChange`)

This requires `TaskChangesProvider` to expose an `onDidChangeBase` event (an `EventEmitter<void>`), fired at the end of `selectBase()` and after `syncLabel()` during `run()`.

**Registration:** `workspace.registerTimelineProvider(['file'], this)` — only for real `file:` URIs, not git URIs.

**Avoid conflict with gitext:** use `id = 'gitbase-task-commits'` and `label = 'Task Commits'` so it appears as a separate timeline source that users can toggle independently from "Git History".

### Reference files in gitext
- [`gitext/src/timelineProvider.ts`](../gitext/src/timelineProvider.ts) — `GitTimelineProvider` (lines 63–329), especially `provideTimeline()` (lines 95–272) and `GitTimelineItem` (lines 18–61)
- [`gitext/src/repository.ts`](../gitext/src/repository.ts) — search for `logFile` — the method running `git log --follow` with pagination

### Files to modify in gitbase
- New file [`src/timelineProvider.ts`](../src/timelineProvider.ts)
- [`src/provider.ts`](../src/provider.ts) — add `readonly onDidChangeBase: vscode.Event<void>` backed by an `EventEmitter`; fire it at the end of `selectBase()` and when base changes during `run()`
- [`src/extension.ts`](../src/extension.ts) — instantiate `GitBaseTimelineProvider`, pass the `providers` map reference, register with `workspace.registerTimelineProvider`; push to `ctx.subscriptions`

### Implementation assessment
- **New file:** Yes — ~120 lines, implements `vscode.TimelineProvider`, follows the naming convention of other provider files (`decorations.ts`, `content.ts`). Clear separation of concerns from the SCM panel logic.
- **Difficulty:** Medium — the `TimelineProvider` API is straightforward; the main work is parsing `git log` output, building `TimelineItem` objects with `makeBaseUri` diff commands, and handling the first-commit edge case (no parent → use empty tree). Requires adding `onDidChangeBase` event to `TaskChangesProvider`.
- **Estimated size:** ~120 lines in `src/timelineProvider.ts` + ~20 lines in `provider.ts`
- **License:** Structure adapted from gitext `timelineProvider.ts` — add Microsoft header to the new file
- **Test plan impact:** New plan **`combined-06-blame-timeline.md`** Section B (shares the same multi-commit setup as the blame section). Scenarios: open Timeline panel → verify commits between base and HEAD appear for a changed file → click a timeline item → verify correct per-commit diff opens → verify timeline is empty for a file not touched in the task range → verify timeline clears when no base is selected → change base → timeline updates.
