# VS Code bug: FileDecoration badges stack visibly when multiple providers decorate the same URI

**Status:** Worked around in GitBase (`WORKAROUND_DOUBLE_BADGE = true`)
**Affects:** VS Code Explorer file tree, multiple `FileDecorationProvider` registrations
**Workaround:** Skip registering a plain-URI decoration for files already decorated by the git extension

---

## Summary

When two extensions both register a `FileDecoration` for the same `file:` URI
via `vscode.window.registerFileDecorationProvider`, VS Code renders both
badge letters simultaneously, producing a doubled label such as `M, M` or
`A, A` in the Explorer file tree.  There is no built-in priority or
deduplication mechanism.

---

## Environment

- VS Code version: **1.96.x** (confirmed with the `0870c2a0c7` app bundle)
- OS: Windows 11
- Extensions: `vscode.git` (built-in), GitBase (this extension)

---

## Steps to reproduce

> **Prerequisite:** in `src/extension.ts` set `WORKAROUND_DOUBLE_BADGE = false`
> and recompile, so the workaround does not mask the bug.

1. Open a git repository with at least one file that is **modified in the
   working tree** (so `vscode.git` will badge it `M` in the Explorer).
2. In GitBase, select a base commit that predates the modification so the same
   file also appears in the GitBase panel (differing from the base).
3. Open the Explorer view and locate the file.

**Expected:** A single `M` badge in the file Explorer, contributed by either
the git extension or GitBase, but not both.

**Actual:** The badge reads `M, M` — two `M` letters rendered side by side —
because both the `vscode.git` built-in extension and GitBase have registered a
`FileDecoration` for the same `file:` URI.

The same doubling occurs for other statuses: `A, A` for added files, etc.

---

## Root cause

VS Code's `FileDecorationProvider` API allows any number of extensions to
register decorations for the same URI.  When multiple providers return a
`FileDecoration` for a given URI, VS Code concatenates the badge letters from
all active decorations and displays them together.  There is no API for an
extension to declare that its decoration should replace or suppress another
provider's decoration for the same URI.

The built-in `vscode.git` extension registers `FileDecoration` entries (badge
letter + foreground colour) for every file it tracks.  GitBase independently
registers `FileDecoration` entries for every file that differs from the
selected base.  For files that appear in both panels the same `file:` URI
receives two decorations, one from each provider, and VS Code renders them
both.

---

## Impact

- Files that are modified both relative to HEAD *and* relative to the GitBase
  base show doubled badge letters (`M, M`) in the Explorer, which looks like
  a rendering glitch and is visually confusing.
- The colouring also comes from both providers, though in practice both use
  `gitDecoration.modifiedResourceForeground` so the colour conflict is not
  visible.

---

## Workaround applied in GitBase

During each refresh, GitBase runs an additional git command to identify which
files are dirty relative to HEAD:

```typescript
gitOrNull(root, 'diff', 'HEAD', '--name-only', '-z', '--')
```

This produces a set of paths (`dirtyPaths`) that the `vscode.git` extension
will already decorate.  GitBase skips registering a plain-URI
`FileDecoration` for those files:

```typescript
if (!WORKAROUND_DOUBLE_BADGE || !dirtyPaths.has(c.path)) {
  // register plain file:// URI decoration for Explorer
}
```

The SCM-panel badge is unaffected by this skip because the SCM panel resource
uses a `#gitbase`-fragment URI (see the companion bug report for the button
cache contamination issue), which is a distinct URI that the `vscode.git`
extension never touches.  GitBase therefore always registers a fragment-URI
decoration for the SCM panel badge regardless of the dirty-path check.

The result: for a dirty file the Explorer shows only the git extension's badge
(single letter), while the GitBase SCM panel shows its own badge via the
fragment URI.

---

## Coverage of staged changes

`git diff HEAD --name-only` compares the **working tree to HEAD**, not the
index to HEAD.  For the common staged-change scenarios this is sufficient:

- **Staged edit** (`git add file.ts`): working tree = modified, so `git diff
  HEAD` includes the file → covered, no double badge.
- **Staged new file**: the file exists in working tree and index but not HEAD
  → `git diff HEAD` includes it → covered.
- **Staged deletion** (`git rm file.ts`): file is gone from both working tree
  and index → `git diff HEAD` includes it → covered.

## Limitations of the workaround

Two edge cases are not covered and will produce a double badge:

1. **Index-only removal** (`git rm --cached file.ts`): removes the file from
   the index while leaving the working tree intact.  The working tree still
   matches HEAD, so `git diff HEAD` does not list it and it is absent from
   `dirtyPaths`.  The git extension badges it in Staged Changes; GitBase may
   also badge it if it differs from the base → double badge.

2. **Stage then revert working tree**: `git add file.ts` followed by manually
   restoring the file to its HEAD content in the working tree (e.g. using
   an editor's "revert" action without unstaging).  Index ≠ HEAD but working
   tree = HEAD → not in `dirtyPaths` → double badge possible.

Both cases require deliberate and unusual git operations.  In normal
development workflows they do not arise.

---

## Suggested VS Code fix

`FileDecorationProvider` should support a priority or exclusivity flag so that
a provider can declare "if any other provider has already decorated this URI,
omit mine".  Alternatively, VS Code could expose an event or query API that
lets a provider inspect what other providers have registered for a given URI
before deciding whether to register its own decoration.
