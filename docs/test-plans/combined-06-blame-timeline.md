# Combined Test Plan 06 — Blame & Timeline

## Coverage

| Feature Set | Scenarios Included |
|-------------|-------------------|
| FS-08 · Git Blame in Diff View | S01, S02, S03, S04 |
| FS-09 · Timeline Provider | S01, S02, S03, S04 |

## Prerequisites

- FS-01 completed: primary test repo exists at a known path (`REPO_A`)
- VS Code is open on `REPO_A`; GitBase Changes panel shows `Branch · origin/main` (or auto-detected default branch)
- At least one modified file (FILE_M) is visible in the GitBase Changes panel

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

Expected: Lines are annotated per-commit — consecutive lines from the same commit share the same annotation text.

### A.2 — Hover shows full blame detail (`FS-08 S02`)

[User] Hover the mouse over a blame annotation (the grey text after the code).

Expected: A hover tooltip appears showing:
- Bold short hash and commit subject on the first line
- Author name
- Full date/time
- Full 40-character commit hash in a code span

### A.3 — Blame is absent on non-basegit editors (`FS-08 S03`)

[User] Click a file in the regular Explorer (a normal `file:` URI) to open it.

Expected: No blame annotations appear in this editor — annotations are scoped to `basegit:` scheme documents only.

[User] Switch back to an open diff (the base-side `basegit:` pane becomes active).

Expected: Blame annotations reappear.

### A.4 — Blame clears when switching away from a diff (`FS-08 S04`)

[User] Open a diff for FILE_M — confirm blame annotations are visible on the base side.

[User] Click on a regular file (non-diff) to make it the active editor.

Expected: When you switch back to the diff's base pane, blame annotations are re-fetched and shown. (Observe that there is no visible flicker of stale data — the previous annotations are cleared before the new editor becomes active.)

Note: Blame is cached per URI for the session — switching back to the same diff re-applies the cached blame without re-running git.

---

## Section B: Timeline Provider (`FS-09`)

*(To be added after Feature 5 is implemented.)*

---

## Teardown

No special teardown required. Blame annotations are in-memory only and do not modify the repository.
