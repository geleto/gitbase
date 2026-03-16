# Optional Test Plan 01 — Timeline Provider

> **Optional feature.** The Timeline Provider enhances the VS Code Timeline panel with
> per-file commit history. It can be disabled without affecting the primary GitBase Changes
> SCM panel. Run this plan when the timeline feature is being modified or when performing
> a full release sign-off.

## Coverage

| Feature Set | Scenarios Included |
|-------------|-------------------|
| FS-09 · Timeline Provider | S01, S02, S03, S04, S05, S06 |

## Prerequisites

- FS-01 completed: primary test repo exists at a known path (`REPO_A`)
- VS Code is open on `REPO_A`; at least one modified file (FILE_M) is visible in the GitBase Changes panel
- **For Section B.6 (pagination):** a file in the repo must have more than 50 commits in its history. If no such file exists in `REPO_A`, use a scratch repo with 50+ commits (as in Combined-03 Section C) and open that repo instead.

---

## Section B: Timeline Provider (`FS-09`)

**Purpose:** Verify that the VS Code Timeline panel shows per-file commit history for files inside GitBase repos, with diffs that open correctly, pagination, and refresh when the base changes.

### B.1 — Timeline shows commit history for a tracked file (`FS-09 S01`)

[User] Open the Explorer and click a file that appears in the GitBase Changes panel (FILE_M) to open it in the editor.

[User] Open the **Timeline** panel (View → Open View… → Timeline, or click the clock icon at the bottom of the Explorer).

Expected: A **GitBase History** section appears in the Timeline panel for FILE_M, listing all commits that touched that file in reverse-chronological order (full history, not limited to the task range). Each entry shows:
- The commit subject as the title
- The author name as the description
- A `$(git-commit)` icon

### B.2 — Clicking a timeline entry opens a diff (`FS-09 S02`)

[User] Click any commit entry in the GitBase History section of the Timeline.

Expected: A diff opens comparing that commit's version of the file (right side) against its parent commit's version (left side). Both sides use the `basegit:` scheme. The tab title shows the filename and short hash.

[User] Click the oldest visible entry (the one closest to the initial commit of the repo).

Expected: The diff opens correctly. If the entry **is** the initial commit of the repo (no parent at all), the left side is empty — `EMPTY_URI` is used when `prevHash` is `undefined` because there is no `entries[i+1]` for the last item AND no `extraHash` (this is not a paginated page boundary, it is genuinely the root commit).

Note: This `EMPTY_URI` behaviour for the root commit is distinct from the pagination fix — see B.6 for the paginated case.

### B.3 — Hover shows commit details (`FS-09 S03`)

[User] Hover over a timeline entry in the GitBase History section.

Expected: A tooltip appears showing:
- Bold short hash and commit subject on the first line
- Author name (e.g. `*Author:* Jane Smith`)
- Full 40-character commit hash in a code span

### B.4 — Timeline refreshes when base changes (`FS-09 S04`)

**Purpose:** Verify the Timeline panel reloads when the GitBase base is changed.

[User] Note the current GitBase History entries for FILE_M.

[User] Open the GitBase Changes panel → click the `$(git-branch)` icon → select a different base (e.g. switch from `Branch · origin/main` to a specific commit).

Expected: The GitBase History section in the Timeline panel refreshes (VS Code shows a loading indicator briefly). The commit list is re-queried.

Note: The timeline shows the full file history regardless of the selected GitBase base. The refresh is triggered by `fireChanged()` in the timeline provider, which fires whenever any provider's `onDidChangeBase` event fires — ensuring VS Code re-queries the provider promptly after a base change.

### B.5 — Timeline shows full history (not scoped to task range) (`FS-09 S05`)

**Precondition:** FILE_M has commits that predate the current base (i.e., some entries in the timeline are older than the `origin/main` merge-base).

[User] Scroll the timeline to the bottom of all visible entries (without pagination).

Expected: Entries older than the GitBase base appear — the timeline is NOT filtered to only the task's commits. `git log --follow -N -- <file>` returns all commits touching the file, and no base-range filtering is applied.

### B.6 — Pagination and last-page diff correctness (`FS-09 S06`)

**Prerequisite:** The file has more than 50 commits in its history (see Prerequisites above).

[User] Scroll to the bottom of the GitBase History section in the Timeline.

Expected: A **Load more** entry appears (VS Code renders this automatically when `paging.cursor` is returned).

[User] Before clicking **Load more**, click the **last visible entry** (the 50th entry, immediately above "Load more").

Expected: A diff opens comparing that commit's version of the file (right side) against its **parent commit's** version (left side). The left side is **not empty** — it shows the parent commit's actual file content.

Note: This is a regression check for the pagination bug fix. Before the fix, the 50th entry always received `EMPTY_URI` on the left side because the extra entry used to determine the parent hash was spliced from the array before the `prevHash` lookup could read it. After the fix, `extraHash` captures that extra entry's hash before the splice, giving the last visible item a correct parent reference.

[User] Click **Load more**.

Expected: Additional, older commits appear below the existing entries.

---

## Teardown

No special teardown required. Timeline data is in-memory only and does not modify the repository.
