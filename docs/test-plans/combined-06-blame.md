# Combined Test Plan 06 — Blame

## Coverage

| Feature Set | Scenarios Included |
|-------------|-------------------|
| FS-08 · Git Blame in Diff View | S01, S02, S03, S04, S05 |

## Prerequisites

- FS-01 completed: primary test repo exists at a known path (`REPO_A`)
- VS Code is open on `REPO_A`; GitBase Changes panel shows `Branch · origin/main` (or auto-detected default branch)
- At least one modified file (FILE_M) is visible in the GitBase Changes panel
- FILE_M must have been touched by at least two different commits with different authors or subjects, so that different lines in the base version show different blame entries. In the Combined-01 repo, `file-a.txt` qualifies: it has the "Initial commit" line and the "Alpha: update file-a" commit, each from a separate commit.

---

## Section A: Git Blame in Diff View (`FS-08`)

**Purpose:** Verify that opening a diff in the GitBase panel shows per-line blame annotations on the base-side (left pane) using `git blame --root --incremental`.

### A.1 — Blame decorations appear on base side (`FS-08 S01`)

[User] In the GitBase Changes panel, click a modified file (FILE_M) to open its diff.

Expected: The diff opens with the base side on the left (a `basegit:` URI). After a brief moment (git blame runs), each line on the **left pane** shows a grey inline annotation to the right of the code with the format:

```
<short-hash> <YYYY-MM-DD> <Author Name> • <commit subject>
```

Example: `a1b2c3d 2024-01-15 Jane Smith • refactor: extract helper`

Expected: Lines are annotated per-commit — consecutive lines from the same commit show identical annotation text.

Note: The annotation format is built in `buildDecorations` in `blame.ts`. Every line receives its own `DecorationOptions` entry; consecutive lines in the same blame hunk happen to have the same `contentText`.

### A.2 — Hover shows full blame detail (`FS-08 S02`)

[User] Hover the mouse over a blame annotation (the grey text after the code).

Expected: A hover tooltip appears showing:
- Bold short hash and commit subject on the first line
- Author name (e.g. `*Author:* Jane Smith`)
- Full date/time as a locale string (e.g. `*Date:* 1/15/2024, 3:22:00 PM`)
- Full 40-character commit hash in a code span

### A.3 — Blame is absent on non-basegit editors (`FS-08 S03`)

[User] Click a file in the regular Explorer (a normal `file:` URI) to open it.

Expected: No blame annotations appear in this editor — annotations are scoped to `basegit:` scheme documents only.

[User] Switch back to an open diff (the base-side `basegit:` pane becomes active).

Expected: Blame annotations reappear.

### A.4 — Blame absent on Added-file diff base side (`FS-08 S05`)

**Precondition:** `staged-test.txt` appears as `A` (added/staged) in the GitBase panel.

[User] Click `staged-test.txt` in the GitBase Changes panel.

Expected: The working-tree file opens directly (not a diff) — added files have no base version, so the row opens the file rather than a `basegit:` diff editor. Therefore no blame annotations appear.

Note: `provideOriginalResource` returns `undefined` for A-status files, so no `basegit:` document is opened and the blame controller never fires.

### A.5 — Blame clears when switching away from a diff (`FS-08 S04`)

[User] Open a diff for FILE_M — confirm blame annotations are visible on the base side.

[User] Click on a regular file (non-diff) to make it the active editor.

Expected: When you switch back to the diff's base pane, blame annotations are re-applied and shown. Observe that there is no visible flicker of stale data — the previous annotations are cleared synchronously when the new editor becomes active (before the async blame lookup for the returning editor completes).

Note: Blame is cached per URI for the session — switching back to the same diff re-applies the cached blame without re-running git. The `--root` flag in `git blame --root --incremental` ensures even the initial commit's lines are blamed rather than shown as unblamed.

---

## Teardown

No special teardown required. Blame annotations are in-memory only and do not modify the repository.
