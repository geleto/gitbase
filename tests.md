# Gitbase Automated Test Strategy

This document describes the automated test coverage plan for the gitbase VS Code extension.
Manual end-to-end testing is covered by the test plans in `docs/test-plans/`; this document
focuses exclusively on automated tests: unit tests, integration tests, and the infrastructure
needed to run them.

---

## Table of Contents

1. [Infrastructure Setup](#1-infrastructure-setup)
2. [Unit Tests](#2-unit-tests)
   - [2.1 parseNameStatus](#21-parsenamestatusout-string-rawchange)
   - [2.2 parseBinarySet](#22-parsebinarysetout-string-setstring)
   - [2.3 isSha](#23-issharef-string-boolean)
   - [2.4 parseGitBlame](#24-parsegitblamedata-string-blameinformation)
   - [2.5 LRUCache](#25-lrucachek-v)
   - [2.6 makeBaseUri / parseBaseUri](#26-makebaseuri--parsebaseuri-round-trip)
   - [2.7 TaskChangesDecorationProvider](#27-taskchangesdecorationprovider)
   - [2.8 diffTitle / baseFragment](#28-difftitle--basefragment)
3. [Integration Tests](#3-integration-tests)
   - [3.1 Extension Activation & Provider Lifecycle](#31-extension-activation--provider-lifecycle)
   - [3.2 Resource State Accuracy](#32-resource-state-accuracy)
   - [3.3 File Action Commands](#33-file-action-commands)
   - [3.4 Diff Content Correctness](#34-diff-content-correctness)
   - [3.5 Base Persistence & Recovery](#35-base-persistence--recovery)
   - [3.6 Status Bar](#36-status-bar)
   - [3.7 Context Key (Explorer/Editor Menus)](#37-context-key-exploreditor-menus)
   - [3.8 Multi-Repo](#38-multi-repo)
   - [3.9 Git Blame Decorations](#39-git-blame-decorations)
   - [3.10 Timeline Provider](#310-timeline-provider)

---

## 1. Infrastructure Setup

### Test framework and runner

Unit tests require no VS Code API and run with plain Node.js:

```jsonc
// package.json additions
"devDependencies": {
  "mocha":            "^10.0.0",
  "@types/mocha":     "^10.0.0",
  "@vscode/test-electron": "^2.4.0"
},
"scripts": {
  "test:unit":        "mocha --ui tdd --timeout 10000 out/test/unit/**/*.test.js",
  "test:integration": "node out/test/integration/runTests.js"
}
```

Integration tests run inside a VS Code extension host via `@vscode/test-electron`. They require
a compiled extension and a VS Code installation. Both test suites use Mocha TDD style
(`suite` / `test` / `suiteSetup` / `teardown`).

### File layout

```
src/
  test/
    unit/
      parseNameStatus.test.ts
      parseBinarySet.test.ts
      isSha.test.ts
      parseGitBlame.test.ts
      lruCache.test.ts
      uriHelpers.test.ts
      decorationProvider.test.ts
    integration/
      runTests.ts          ← @vscode/test-electron entry point
      activation.test.ts
      resourceStates.test.ts
      commands.test.ts
      diffContent.test.ts
      persistence.test.ts
      statusBar.test.ts
      contextKey.test.ts
      multiRepo.test.ts
      blame.test.ts
      timeline.test.ts
    helpers/
      gitFixture.ts        ← creates temp repos for integration tests
```

### Exports required before tests can run

Some functions are currently unexported. They need `export` added:

| Symbol | File | Needed for |
|--------|------|-----------|
| `parseGitBlame` | `src/blame.ts` | Unit test 2.4 |
| `LRUCache` | `src/blame.ts` | Unit test 2.5 |
| `buildDecorations` | `src/blame.ts` | Unit test 2.4 (optional) |
| `logFile` | `src/timelineProvider.ts` | Unit test (log parsing) |

---

## 2. Unit Tests

Unit tests are pure Node.js — no VS Code extension host, no `vscode` module, no git process.
All input is supplied as string literals representing real git command output.

### 2.1 `parseNameStatus(out: string): RawChange[]`

**Location:** `src/git.ts`

Git produces `git diff --name-status -z` output where each entry is NUL-delimited. The parser
must handle all status letters and the three-token rename/copy format.

```
suite('parseNameStatus', () => {
```

| # | Description | Input (`\0` = NUL) | Expected output |
|---|-------------|-------------------|-----------------|
| 1 | Empty string | `""` | `[]` |
| 2 | Single string of only NULs | `"\0\0\0"` | `[]` |
| 3 | Single M entry | `"M\0file.txt\0"` | `[{status:'M', path:'file.txt'}]` |
| 4 | Single A entry | `"A\0added.txt\0"` | `[{status:'A', path:'added.txt'}]` |
| 5 | Single D entry | `"D\0deleted.txt\0"` | `[{status:'D', path:'deleted.txt'}]` |
| 6 | Rename R100 | `"R100\0old.txt\0new.txt\0"` | `[{status:'R', path:'new.txt', oldPath:'old.txt'}]` |
| 7 | Rename R95 (partial) | `"R095\0src/a.ts\0src/b.ts\0"` | `[{status:'R', path:'src/b.ts', oldPath:'src/a.ts'}]` |
| 8 | Copy C100 treated as R | `"C100\0orig.txt\0copy.txt\0"` | `[{status:'R', path:'copy.txt', oldPath:'orig.txt'}]` |
| 9 | Multiple mixed entries | `"M\0a.ts\0A\0b.ts\0D\0c.ts\0"` | Three entries in order |
| 10 | R entry missing second path | `"R100\0old.txt\0"` | `[]` — both paths required |
| 11 | Path with spaces | `"M\0src/my file.txt\0"` | `[{status:'M', path:'src/my file.txt'}]` |
| 12 | Path with special chars (`#`, `&`, unicode) | Various | Preserved verbatim |
| 13 | Trailing NUL absent (last entry has no trailing NUL) | `"M\0file.txt"` | Same as with trailing NUL |
| 14 | Unknown status letter `T` (type change) | `"T\0file.txt\0"` | `[{status:'T', path:'file.txt'}]` — any non-R/C status passes through |
| 15 | Back-to-back renames | Two R entries | Both entries produced |
| 16 | Empty path token skipped | `"M\0\0A\0real.txt\0"` | Only `{status:'A', path:'real.txt'}` |

### 2.2 `parseBinarySet(out: string): Set<string>`

**Location:** `src/git.ts`

Git produces `git diff --numstat -z` output. Text files get `<added>\t<removed>\t<path>`;
binary files get `-\t-\t<path>` (or a three-token rename form when binary renamed).

| # | Description | Input | Expected set |
|---|-------------|-------|-------------|
| 1 | Empty string | `""` | `Set {}` |
| 2 | Single text file | `"5\t3\tfile.ts\0"` | `Set {}` |
| 3 | Single binary | `"-\t-\tlogo.png\0"` | `Set { 'logo.png' }` |
| 4 | Binary with subdirectory | `"-\t-\tassets/img.jpg\0"` | `Set { 'assets/img.jpg' }` |
| 5 | Binary rename (three tokens) | `"-\t-\t\0old.png\0new.png\0"` | `Set { 'new.png' }` — new path only |
| 6 | Mixed text and binary | `"3\t1\ta.ts\0-\t-\tb.png\0"` | `Set { 'b.png' }` |
| 7 | Multiple binaries | Two binary entries | Both paths in set |
| 8 | Binary rename: old path not in set | `"-\t-\t\0old.png\0new.png\0"` | `'old.png'` is NOT in the set |
| 9 | Token that starts with dash but not `-\t-\t` | `"--cached\t0\tfile\0"` | Not added (falls through) |

### 2.3 `isSha(ref: string): boolean`

**Location:** `src/git.ts`

| # | Input | Expected |
|---|-------|---------|
| 1 | 40 lowercase hex chars | `true` |
| 2 | 39 chars (too short) | `false` |
| 3 | 41 chars (too long) | `false` |
| 4 | Contains uppercase `A-F` | `false` |
| 5 | Contains `g` | `false` |
| 6 | Branch name `origin/main` | `false` |
| 7 | Tag name `v1.0` | `false` |
| 8 | Empty string | `false` |
| 9 | All zeros `000...000` (40) | `true` — structurally valid |

### 2.4 `parseGitBlame(data: string): BlameInformation[]`

**Location:** `src/blame.ts` (requires export)

`git blame --root --incremental` emits one hunk per commit-file-range combination.
Each hunk begins with `<hash> <orig_line> <final_line> <num_lines>` and ends with
`filename <file>`. The parser accumulates ranges per commit hash.

#### Basic parsing

| # | Description | Notes |
|---|-------------|-------|
| 1 | Empty string | Returns `[]` |
| 2 | Single commit, single line (`count=1`) | One `BlameInformation` with `ranges: [{startLineNumber:N, endLineNumber:N}]` |
| 3 | Single commit, multi-line range (`count=5`) | `endLineNumber = startLineNumber + 4` |
| 4 | `author-time` multiplied by 1000 | Stored as unix ms; input is unix seconds |
| 5 | `author` line captured | `authorName` matches |
| 6 | `summary` line captured | `subject` matches |
| 7 | Two different commits | Two entries in result |
| 8 | Same commit appearing twice (two ranges in output) | Single entry with two ranges, not duplicated |

#### Edge cases

| # | Description | Notes |
|---|-------------|-------|
| 9 | Missing `author` line in hunk | `authorName` is `undefined`, no crash |
| 10 | Missing `summary` line in hunk | `subject` is `undefined`, no crash |
| 11 | Missing `author-time` line | `authorDate` is `undefined` |
| 12 | Lines before first commit hash (non-hash prefix line) | Skipped cleanly by `if (!commitHash)` guard |
| 13 | Root commit (hash = all zeros in practice, or any 40-char hash without `previous` line) | Parsed normally — `previous` line is not used |
| 14 | Hunk ends at EOF without `filename` line | Incomplete hunk not added to result; no crash |
| 15 | `author-mail` line (not extracted, but must not corrupt state) | Other fields remain correct |
| 16 | `filename` line with a path containing spaces | Filename line merely triggers reset; path not captured |
| 17 | Three commits, commit #2 appears again later | Second appearance merges its range into existing entry |

#### Boundary: line number arithmetic

| # | Description | Expected |
|---|-------------|----------|
| 18 | `<hash> 1 1 3` → startLineNumber=1, count=3 | `endLineNumber = 1 + 3 - 1 = 3` |
| 19 | `<hash> 10 10 1` → count=1 | `startLineNumber === endLineNumber === 10` |

### 2.5 `LRUCache<K, V>`

**Location:** `src/blame.ts` (requires export)

| # | Description | Expected |
|---|-------------|----------|
| 1 | `get()` on empty cache | Returns `undefined` |
| 2 | `set()` then `get()` with same key | Returns stored value |
| 3 | `set()` beyond limit evicts oldest entry | The first-inserted key is evicted when `size > limit` |
| 4 | `get()` promotes key to MRU — fill to limit with a, b, c; `get(a)`; add d | b is evicted, not a |
| 5 | `set()` on existing key — count stays at limit | Overwrite does not increase size |
| 6 | Overwrite moves to MRU | After re-`set(a)`, `a` is last to be evicted |
| 7 | Limit of 1: second insert evicts first | Only one entry survives |
| 8 | Get-promoted entry still evictable eventually | After limit insertions of other keys, promoted entry evicted |

### 2.6 `makeBaseUri` / `parseBaseUri` round-trip

**Location:** `src/content.ts`

These two functions are inverses; the round-trip must be lossless for all inputs.

| # | Input | Asserted property |
|---|-------|------------------|
| 1 | Simple path, SHA ref | `parseBaseUri(makeBaseUri(root, ref, fp))` recovers all three fields verbatim |
| 2 | `root` with spaces | Encoded in query, decoded correctly |
| 3 | `fp` with forward slashes | Preserved through encode/decode |
| 4 | `ref = 'origin/main'` (slash in ref) | Slash encoded as `%2F`; decoded back |
| 5 | `ref` containing `&` | Encoded as `%26`; split-by-literal-`&` not fooled |
| 6 | `fp` containing `&` | Same as above |
| 7 | Default suffix (empty) | `uri.fragment === ''` |
| 8 | Non-empty suffix | `uri.fragment` equals the suffix string |
| 9 | URI scheme | `uri.scheme === 'basegit'` |
| 10 | URI path | `uri.path === '/' + fp` (used by VS Code for tab label) |
| 11 | Windows-style root path (`C:\Users\...`) | Encoded in query and decoded correctly |
| 12 | Unicode chars in root/fp | Preserved through percent-encoding |

### 2.8 `diffTitle` / `baseFragment`

**Location:** `src/labels.ts`

`LABEL_FORMATTER_ENABLED` is hardcoded `false`. Both functions fall through to their simple
fallback: `diffTitle` always returns `${filename} (${shortSuffix})` and `baseFragment` always
returns the `comparison` argument unchanged.

| # | Function | Input | Expected |
|---|----------|-------|----------|
| 1 | `diffTitle` | `('file.ts', 'abc1234')` | `'file.ts (abc1234)'` |
| 2 | `diffTitle` | `('utils/helpers.ts', 'origin/main')` | `'utils/helpers.ts (origin/main)'` |
| 3 | `baseFragment` | any four args | Returns `comparison` arg unchanged |
| 4 | `baseFragment` | `comparison = 'base-to-head'` | `'base-to-head'` |

---

### 2.7 `TaskChangesDecorationProvider`

**Location:** `src/decorations.ts`

This class uses `vscode.Uri.file()`, `vscode.EventEmitter`, and `vscode.FileDecoration`.
These are available in a VS Code extension host test but not in plain Node. If a lightweight
mock of `vscode` is available (e.g. `vscode-test-stub`), tests can run in plain Node;
otherwise they belong in the integration suite.

| # | Description | Expected |
|---|-------------|----------|
| 1 | `update()` with A entry | `provideFileDecoration` returns decoration with letter `'A'` |
| 2 | `update()` with M entry | Letter `'M'`, no strikethrough |
| 3 | `update()` with D entry | Letter `'D'`, `strikeThrough = true` |
| 4 | `update()` with R entry | Letter `'R'` |
| 5 | `update()` with U entry | Letter `'U'` |
| 6 | `update()` fires `onDidChangeFileDecorations` | Event includes all newly-decorated URIs |
| 7 | Second `update()` removes stale entries | Old URIs fired in event; `provideFileDecoration` returns `undefined` for them |
| 8 | `clear(root)` fires event with all URIs for that root | All previous URIs fired; all return `undefined` after |
| 9 | `clear(root)` on unknown root | No event fired, no crash |
| 10 | `clear(root)` on already-cleared root | No event fired (guard: `if (!old?.size) return`) |
| 11 | Two roots: `update(rootA, ...)` then `update(rootB, ...)` | Each root's decorations independent |
| 12 | Two roots: `clear(rootA)` | Only rootA's URIs fired; rootB unaffected |
| 13 | File appears in git's dirty set (`dirtyPaths`) | Explorer URI NOT decorated (avoids double badge alongside git's own badge) |
| 14 | File not in git's dirty set | Explorer URI IS decorated |
| 15 | Fragment URI (`file.txt#gitbase`) | Decorated in addition to the plain URI (supports SCM row highlighting) |

---

## 3. Integration Tests

Integration tests run inside a real VS Code extension host via `@vscode/test-electron`.
Each test suite creates a temporary git repository in a `tmp` directory, registers it
as a workspace folder, and waits for the extension to activate. A shared helper
(`gitFixture.ts`) handles repo creation, commits, and cleanup.

```ts
// helpers/gitFixture.ts (sketch)
export async function makeRepo(opts: { commits?: CommitSpec[] }): Promise<{ root: string; dispose: () => void }>
export async function git(root: string, ...args: string[]): Promise<string>
```

Where needed, tests access the provider instance directly via the extension's exported
`activate()` function, or through the `providers` map exposed for testing.

### 3.1 Extension Activation & Provider Lifecycle

**File:** `src/test/integration/activation.test.ts`

#### Activation with a git repo

| # | Description | Setup | Expected |
|---|-------------|-------|---------|
| 1 | Extension activates when workspace contains `.git` | Open folder with `.git` | `providers.size === 1` |
| 2 | GitBase Changes SCM panel registered | Same | `vscode.scm.inputBox` (or any SCM API query) sees `'taskchanges'` source control |
| 3 | `vscode.git` extension not available | Disable `vscode.git` (mock or test-only path) | Error message shown; `providers.size === 0`; no crash |
| 4 | Unborn repo (zero commits) | `git init` only, no commits | Panel appears, no error notification, SCM list empty |
| 5 | First commit on unborn repo | Make initial commit while extension active | Refresh fires without error; SCM list still empty (base = HEAD) |

#### Repository discovery

| # | Description | Expected |
|---|-------------|----------|
| 6 | `onDidOpenRepository` fires for late-opened repo | Add second workspace folder → second provider created without reload |
| 7 | `onDidCloseRepository` fires for removed repo | Remove workspace folder → provider disposed, `providers.size` decreases |
| 8 | Provider disposed on remove: `providers.has(root)` false | Same | Key removed from map |
| 9 | Adding same root twice is a no-op | `addRepo` called twice with same root | Still one provider for that root |

### 3.2 Resource State Accuracy

**File:** `src/test/integration/resourceStates.test.ts`

**Setup:** Repo with `origin/main` as base, branch `feature` diverging. Apply working-tree
changes and assert the SCM list.

#### Status codes

| # | File state | Expected contextValue | Expected path |
|---|-----------|----------------------|--------------|
| 1 | Modified tracked file | `'M'` | Relative path from root |
| 2 | Staged new file | `'A'` | Relative path |
| 3 | Deleted file (`git rm`) | `'D'` | Relative path |
| 4 | Renamed file (`git mv`) | `'R'` | New path; `oldPath` in URI carries original name |
| 5 | Untracked file | `'U'` | Relative path |
| 6 | Binary file (staged PNG) | `contextValue` = git status letter (e.g. `'M'`); `command` = `taskChanges.binaryNotice` | Binary status preserved; click shows info message |

#### Diff ref correctness

| # | Base type | Expected `lastDiffRef` | Verification |
|---|-----------|----------------------|-------------|
| 7 | Branch base | merge-base SHA between HEAD and branch | `git merge-base HEAD origin/main` |
| 8 | Tag base | tag SHA itself (frozen; no merge-base) | `git rev-parse v1.0` |
| 9 | Commit base | commit SHA itself | SHA as typed |
| 10 | HEAD base | `'HEAD'` | List is empty (no changes vs self) |

#### Auto-refresh

| # | Description | Expected |
|---|-------------|----------|
| 11 | External file modification detected | Within ~500ms, `group.resourceStates` updates |
| 12 | Timestamp-only `touch` not shown | After `git update-index --refresh`, file absent from list |
| 13 | `repo.state.onDidChange` triggers schedule | File staged in native git panel → GitBase list updates |

#### Untracked files

| # | Description | Expected |
|---|-------------|----------|
| 14 | Untracked file appears in list | `'U'` entry present |
| 15 | Untracked file excluded from patch | `copyPatch` shows info message, no patch |
| 16 | gitignored file absent | `.gitignore`-excluded file not in list |

#### Group visibility

| # | Description | Expected |
|---|-------------|----------|
| 17 | No changed files | `group.resourceStates` is empty; SCM group still visible (`hideWhenEmpty = false`) |
| 18 | File in repo but unchanged versus base | Not in `group.resourceStates`; `provideOriginalResource` returns `undefined` for it |

### 3.3 File Action Commands

**File:** `src/test/integration/commands.test.ts`

#### `taskChanges.copyPath`

| # | Description | Expected clipboard |
|---|-------------|-------------------|
| 1 | M file | Full absolute path |
| 2 | D file | Full absolute path |

#### `taskChanges.copyRelativePath`

| # | Description | Expected clipboard |
|---|-------------|-------------------|
| 3 | M file at repo root | Filename only (no path separator) |
| 4 | M file in subdirectory | Relative path from repo root |
| 5 | Rename R: uses new path | New path relative to root |

#### `taskChanges.copyPatch`

| # | Description | Expected |
|---|-------------|----------|
| 6 | M file, Branch base | Clipboard = `git diff <merge-base> -- <file>` |
| 7 | M file, Tag base | Clipboard = `git diff <tag-sha> -- <file>` |
| 8 | D file | Clipboard contains a deletion patch (all `-` lines) |
| 9 | A (staged new) file | Clipboard contains an addition patch (all `+` lines) |
| 10 | U (untracked) file | Info notification "Patch not available"; clipboard unchanged |
| 11 | Binary file | `copyPatch` is absent from SCM context menu (`when` clause) |
| 12 | File reverted to match base after list was built | "No changes to copy" notification |
| 13 | Invoked from Explorer URI (not SCM resource) | Resolves via `getResourceState`; same patch produced |
| 14 | Invoked from editor title bar URI | Same patch as from SCM panel |

#### `taskChanges.openDiff`

| # | Description | Expected |
|---|-------------|----------|
| 15 | M file from SCM panel click | Diff editor opens with `basegit:` on left, `file:` on right |
| 16 | D file from SCM panel click | Read-only `basegit:` opens (no right side) |
| 17 | A/U file from SCM panel click | Working file opens (no diff) |
| 18 | Binary file click | `binaryNotice` info message; no editor opened |
| 19 | `taskChanges.openDiff` command from Explorer | `openDiffForUri` resolves correct provider |
| 20 | `taskChanges.openDiff` when file not in any provider | No-op (no crash) |

#### `taskChanges.openFile`

| # | Description | Expected |
|---|-------------|----------|
| 21 | Resource URI has `#gitbase` fragment | Fragment stripped before `openWithoutAutoReveal`; opened URI has no fragment |
| 22 | Resource URI arrives as plain JSON (not `vscode.Uri` instance) | `vscode.Uri.from()` normalises it; file opens correctly |

#### `taskChanges.refresh`

| # | Description | Expected |
|---|-------------|----------|
| 23 | From SCM title bar (passes `SourceControl`) | Schedules refresh without repo picker |
| 24 | From command palette, one repo open | No repo picker; refreshes directly |
| 25 | From command palette, two repos open | Repo picker appears |
| 26 | From command palette, zero repos open | Silent no-op (no picker, no error) |
| 27 | `selectBase` with `sc` arg that does not match any provider | Silent no-op (returns `undefined`) |

#### `openWithoutAutoReveal`

| # | Description | Expected |
|---|-------------|----------|
| 28 | Untracked file opened via click | File appears in editor; no error |
| 29 | `scm.autoReveal` setting is not read or written | Setting value unchanged before and after the call |
| 30 | SCM sidebar becomes the focused view | `workbench.view.scm` command executes (verify via command spy) |

### 3.4 Diff Content Correctness

**File:** `src/test/integration/diffContent.test.ts`

These tests verify the `basegit:` content provider returns the correct historical file content.

| # | Description | Expected |
|---|-------------|----------|
| 1 | `provideTextDocumentContent` for M file | Matches `git show <ref>:<path>` |
| 2 | SHA-based ref: content cached after first call | Second call returns same content without git invocation |
| 3 | Branch-based ref: cache invalidates when tip advances | After `git push` advances branch, `checkBranchTip` clears cache; new content returned |
| 4 | File that did not exist at ref | Returns `(file did not exist at <ref>)` placeholder |
| 5 | Rename R entry: left side uses `oldPath` | Content matches `git show <ref>:<oldPath>` |
| 6 | D file: base-side shows historical content | Full historical content visible |
| 7 | A/U file: base-side is empty | `EMPTY_URI` produces empty content |
| 8 | `provideOriginalResource` returns `undefined` for non-file URI | No gutter markers for scheme other than `file:` |
| 9 | `provideOriginalResource` returns `undefined` when base = HEAD | No gutter markers when no base selected |
| 10 | `provideOriginalResource` returns `basegit:` URI for M file | URI query encodes correct root/ref/fp |
| 11 | `provideOriginalResource` returns `undefined` for U and D files | No gutter markers (no base or no working tree) |
| 12 | `provideOriginalResource` returns `undefined` for file outside repo | Path-prefix check excludes non-repo files |

### 3.5 Base Persistence & Recovery

**File:** `src/test/integration/persistence.test.ts`

#### WorkspaceState storage

| # | Description | Expected |
|---|-------------|----------|
| 1 | Select Branch base | `workspaceState.get('taskChanges.base.<root>')` equals branch name |
| 2 | Select Tag base | Stored value is frozen SHA, not symbolic tag name |
| 3 | Select Commit base | Stored value is full 40-char SHA |
| 4 | Label stored separately | `taskChanges.baseLabel.<root>` equals human-readable label |
| 5 | Type stored separately | `taskChanges.baseType.<root>` equals `'Branch'`, `'Tag'`, or `'Commit'` |
| 6 | Cancel picker | Stored values unchanged |
| 7 | Two repos: keys namespaced by root | `taskChanges.base.<rootA>` and `taskChanges.base.<rootB>` are separate keys |

#### Deleted-ref detection and recovery

| # | Description | Expected |
|---|-------------|----------|
| 8 | Delete base branch while extension is active | Validation fails on next refresh; base cleared to HEAD |
| 9 | Auto-recovery succeeds (origin/main detectable) | Info notification (not warning); base updated to `origin/main`; no user action required |
| 10 | Auto-recovery fails (no default detectable) | Warning notification with `Select Base` button; base cleared to HEAD |
| 11 | Orphaned commit SHA (gc'd) | Same validation failure as deleted branch |
| 12 | Deleted tag SHA | Same path; warning shown because tag type shows warning even on successful recovery |

#### Auto-detection on first open

| # | Description | Expected |
|---|-------------|----------|
| 13 | `origin/HEAD` configured | `detectDefaultBranch` returns `origin/main`; base set without user action |
| 14 | `origin/main` exists, `origin/HEAD` absent | Step 3 (`origin/main` fallback) returns correct ref |
| 15 | `origin/master` only | Step 3 returns `origin/master` |
| 16 | No remotes at all, no tracking branch | `detectDefaultBranch` returns `null`; label stays `HEAD · Select a base to begin` |
| 17 | Tracking branch (`HEAD@{upstream}`) as last resort | Step 4 returns upstream value |

#### Auto-detection done flag

| # | Description | Expected |
|---|-------------|----------|
| 18 | User manually selects a base | `autoDetectDone` set to `true`; `detectDefaultBranch` not called on subsequent refreshes |
| 19 | Base deleted and recovered after manual selection | Recovery runs normally; `autoDetectDone` remains `true` (detection not re-triggered) |

### 3.6 Status Bar

**File:** `src/test/integration/statusBar.test.ts`

| # | Description | Expected `statusBarItem.text` |
|---|-------------|------------------------------|
| 1 | No base selected | `'$(git-branch) Select base…'` |
| 2 | Branch base | `'$(git-branch) origin/main'` |
| 3 | Tag base | `'$(tag) v1.0'` |
| 4 | Commit base | `'$(git-commit) <subject>'` |
| 5 | Long label (>30 chars) | Truncated with `…` at 30 chars |
| 6 | PR base-only mode | `'$(github) PR #N'` |
| 7 | Status bar click command | `command.command === 'taskChanges.selectBase'`; `command.arguments[0]` is the SCM instance |
| 8 | Single repo: always visible | `statusBarItem.isVisible === true` regardless of active editor |
| 9 | PR base: `scm.label` matches `PR #N` format | `'$(github) PR #42'` |
| 10 | `scm.label` does not match `PR #N` (e.g. raw branch name) | Raw label shown without PR icon |

#### Multi-repo status bar (single file, two providers)

| # | Description | Expected |
|---|-------------|----------|
| 11 | Active editor belongs to repo A | Repo A status bar visible; repo B status bar hidden |
| 12 | Active editor belongs to repo B | Repo B visible; repo A hidden |
| 13 | No active editor | Both status bars visible |
| 14 | Active editor not in any repo | Both status bars visible |
| 15 | Close all editors | Both status bars visible |

### 3.7 Context Key (Explorer/Editor Menus)

**File:** `src/test/integration/contextKey.test.ts`

The `taskChanges.isChangedFile` context key controls whether `Open Diff Against Base` and
`Copy Changes (Patch)` appear in the Explorer context menu and editor title bar.

| # | Description | Expected context key |
|---|-------------|---------------------|
| 1 | Active editor is an M file | `true` |
| 2 | Active editor is a U file | `true` |
| 3 | Active editor is a file NOT in the GitBase list | `false` |
| 4 | Active editor is a `basegit:` URI (the diff's base side) | `false` (scheme is not `file:`) |
| 5 | No active editor | `false` |
| 6 | Resource states change: file removed from list | Key updates to `false` if it was `true` |
| 7 | Resource states change: file added to list | Key updates to `true` if editor is now a changed file |
| 8 | Multiple repos: file in repo A's list, editor from repo A | `true` — checked across all providers |
| 9 | Multiple repos: file in repo A's list, editor from repo B | `false` |

### 3.8 Multi-Repo

**File:** `src/test/integration/multiRepo.test.ts`

#### Provider isolation

| # | Description | Expected |
|---|-------------|----------|
| 1 | Two workspace folders → two providers | `providers.size === 2` |
| 2 | Each provider has its own SCM instance | Different `scm.rootUri` values |
| 3 | Setting base on repo A does not change repo B | `workspaceState` keys differ by root path |
| 4 | Repo A's resource states independent of repo B | Separate `group.resourceStates` |

#### `resolveProviderForResource`

| # | Description | Expected |
|---|-------------|----------|
| 5 | File in repo A → resolves to repo A provider | Deepest matching root wins |
| 6 | File in repo B → resolves to repo B provider | Correct root |
| 7 | Nested repos: file in inner repo → inner provider | Longer root path wins over shorter |
| 8 | Nested repos: file in outer repo only → outer provider | Not matched by inner |
| 9 | File not in any repo | Returns `undefined` |
| 10 | `copyRelativePath` for file in repo B | Path relative to repo B's root, not repo A's |
| 11 | `openDiff` for file in repo B | Uses repo B's base, not repo A's |

#### Repo picker (command palette path)

| # | Description | Expected |
|---|-------------|----------|
| 12 | `selectBase` with 1 repo | No repo picker shown; goes directly to base picker |
| 13 | `selectBase` with 2 repos | Repo picker shown with both folder names |
| 14 | Repo picker: cancel | Silent no-op (no error, no base picker) |
| 15 | `selectBase` with 0 repos | Silent no-op |
| 16 | Duplicate repo basenames | Picker entries distinguished by `description` showing full path |

#### Repo close and badge cleanup

| # | Description | Expected |
|---|-------------|----------|
| 17 | Remove repo from workspace | Provider disposed; `providers.size` decreases |
| 18 | After dispose, `decoProvider.clear(root)` fires | Explorer badges cleared for that root |
| 19 | Re-adding same repo starts fresh | New provider created; no stale state from previous session |

### 3.9 Git Blame Decorations

**File:** `src/test/integration/blame.test.ts`

| # | Description | Expected |
|---|-------------|----------|
| 1 | Open `basegit:` editor → decorations applied | `editor.getDecorations(decoType).length > 0` |
| 2 | Each line has a decoration | `decorations.length === editor.document.lineCount` (for a fully-blamed file) |
| 3 | Decoration `contentText` format | Starts with 7-char short hash |
| 4 | `authorDate` present → date in annotation | Matches `YYYY-MM-DD` pattern |
| 5 | `authorName` present → name in annotation | Author name appears after date |
| 6 | `subject` present → subject in annotation | Appears after bullet separator `•` |
| 7 | `hoverMessage` populated | Not undefined; contains full hash as `code` span |
| 8 | Switch from `basegit:` to `file:` editor | Previous decorations cleared (length = 0) |
| 9 | Switch back to same `basegit:` editor | Decorations re-applied (from cache) |
| 10 | Cache hit: same URI opened twice | `gitOrNull` called only once (verify via call count if spy available) |
| 11 | Cache miss: different URI | `gitOrNull` called for each unique URI |
| 12 | `git blame` returns null (unblame-able file) | No decorations; no crash |
| 13 | Editor switches mid-await (race guard) | No decorations set on non-active editor — **Note:** difficult to automate reliably; consider a manual check or a spy-based test that stubs `gitOrNull` to be async |
| 14 | `file:` URI editor → no decorations | `editor.getDecorations(decoType).length === 0` |
| 15 | Dispose → decoration type disposed | No VS Code warning about disposed decoration type |

### 3.10 Timeline Provider

**File:** `src/test/integration/timeline.test.ts`

#### `provideTimeline` happy path

| # | Description | Setup | Expected |
|---|-------------|-------|---------|
| 1 | File with 3 commits | Repo with 3 commits touching `file.ts` | Returns 3 `TimelineItem` entries |
| 2 | Item label equals commit subject | Known commit subject | `item.label === subject` |
| 3 | Item description equals author name | Known author | `item.description === authorName` |
| 4 | Item timestamp equals commit date × 1000 | Known unix timestamp | `item.timestamp === authorDate * 1000` |
| 5 | Item `iconPath` is `$(git-commit)` | Any item | `item.iconPath` is `ThemeIcon` with id `'git-commit'` |
| 6 | Item command opens diff | Invoke `item.command` | `vscode.diff` called with two `basegit:` URIs |
| 7 | Oldest commit: left side is `EMPTY_URI` | First commit in repo | `item.command.arguments[0] === EMPTY_URI` |
| 8 | Item tooltip contains hash and subject | Any item | Markdown string contains 7-char hash and subject |

#### Pagination

| # | Description | Expected |
|---|-------------|----------|
| 9 | 51 commits (> 50 limit) | First call returns 50 items; `paging.cursor` is hash of 50th entry |
| 10 | 50 commits (= limit) | Returns 50 items; `paging.cursor` is hash of 50th |
| 11 | 49 commits (< limit) | Returns 49 items; `paging` is `undefined` |
| 12 | Second page from cursor | Items are strictly older than the cursor commit |
| 13 | Cursor is root commit (no parent) | Returns `[]`; pagination ends |
| 14 | Last item on a full page (`hasMore=true`) — left side of diff | Uses `extraHash` (the pruned extra entry) as parent, not `EMPTY_URI` |

#### Edge cases

| # | Description | Expected |
|---|-------------|----------|
| 15 | File not in any repo | Returns `{ items: [] }` |
| 16 | Non-file URI scheme | Returns `{ items: [] }` |
| 17 | File with no commits (new untracked file) | Returns `{ items: [] }`; no crash |
| 18 | File in nested repo (inner root) | `logFile` called with inner repo root; paths relative to inner root |
| 19 | Cancellation token fired mid-await | Returns `{ items: [] }` after token fires |

#### `onDidChange` refresh

| # | Description | Expected |
|---|-------------|----------|
| 20 | `fireChanged()` fires `_onDidChange` with `undefined` | Listener receives `undefined` (full refresh) |
| 21 | Base change on any provider → `onDidChangeBase` fires | `fireChanged()` called; timeline reloads |
| 22 | New provider added → `onDidChangeBase` subscription created in `addRepo` | Base change on new provider also refreshes timeline |

---

## Coverage Summary

| Source file | Unit | Integration |
|-------------|:----:|:-----------:|
| `src/git.ts` — `parseNameStatus` | ✓ §2.1 | via §3.2 |
| `src/git.ts` — `parseBinarySet` | ✓ §2.2 | via §3.2 |
| `src/git.ts` — `isSha` | ✓ §2.3 | — |
| `src/git.ts` — `gitOrNull` error handling | — | via §3.2 |
| `src/git.ts` — `detectDefaultBranch` (4 steps) | — | ✓ §3.5 |
| `src/git.ts` — `detectRefType` | — | via §3.3 |
| `src/git.ts` — `getMergeBase` | — | via §3.2 |
| `src/content.ts` — `makeBaseUri` / `parseBaseUri` | ✓ §2.6 | via §3.4 |
| `src/content.ts` — `BaseGitContentProvider` | — | ✓ §3.4 |
| `src/decorations.ts` — `TaskChangesDecorationProvider` | ✓ §2.7 | ✓ §3.8 |
| `src/provider.ts` — `TaskChangesProvider` | — | ✓ §3.2–3.7 |
| `src/provider.ts` — `provideOriginalResource` | — | ✓ §3.4 |
| `src/provider.ts` — `getResourceState` | — | ✓ §3.3 |
| `src/provider.ts` — `selectBase` / `syncLabel` | — | ✓ §3.5–3.6 |
| `src/provider.ts` — `onDidChangeBase` event | — | ✓ §3.10 |
| `src/extension.ts` — activation | — | ✓ §3.1 |
| `src/extension.ts` — `resolveProvider` | — | ✓ §3.3, §3.8 |
| `src/extension.ts` — `resolveProviderForResource` | — | ✓ §3.8 |
| `src/extension.ts` — `updateActiveEditorContext` | — | ✓ §3.6–3.7 |
| `src/extension.ts` — command handlers | — | ✓ §3.3 |
| `src/picker.ts` — base picker | — | ✓ §3.5 |
| `src/workarounds.ts` — `openWithoutAutoReveal` | — | ✓ §3.3 |
| `src/blame.ts` — `parseGitBlame` | ✓ §2.4 | — |
| `src/blame.ts` — `LRUCache` | ✓ §2.5 | — |
| `src/blame.ts` — `GitBaseBlameController` | — | ✓ §3.9 |
| `src/timelineProvider.ts` — `TaskChangesTimelineProvider` | — | ✓ §3.10 |
| `src/labels.ts` — `diffTitle` / `baseFragment` | ✓ §2.8 | via §3.4 |
| `src/pr.ts` — GitHub PR flows | — | manual (Combined-05) |
