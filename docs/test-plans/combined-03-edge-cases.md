# Combined Test Plan 03 — Edge Cases

## Coverage

| Feature Set | Scenarios Included |
|-------------|-------------------|
| FS-01 · Test Repository Setup | S04 |
| FS-02 · Base Selection | S05b, S14, S15, S16 |
| FS-03 · Diff Display | S12 |

## Scenarios Excluded from This Plan

None — all scenarios in this plan are edge cases that require special setup and could not be merged into Combined-01 or Combined-02.

## Prerequisites

- FS-01 completed: test repo exists with all branches and tags
- VS Code is open on the test repo; GitBase Changes panel shows `Branch · origin/main`
- Extension is built and installed

> **Shell:** All `[Claude]` commands use bash syntax (`$(…)`, `mktemp`, `grep`, etc.). Run them from Claude Code's integrated bash shell, Git Bash, or WSL — not from PowerShell directly.

## Optimisation Rationale

These scenarios are grouped together because they are all isolated: each requires special setup (disabled extensions, a separate scratch repo, 50+ commits, destructive tag operations) that cannot be shared with the normal-operation or persistence plans. Within this plan, scenarios that use the same scratch repo are sequenced together to avoid redundant repo creation.

---

## Section A: git Extension Unavailable (`FS-01 S04`)

**Purpose:** Verify the extension disables itself gracefully when the VS Code built-in git extension is not available.

**Precondition:** GitBase extension is installed. VS Code is open.

### A.1 — Disable built-in git extension, verify graceful failure

[User] Go to the Extensions view → search for `Git` → find the built-in `Git` extension (publisher: Microsoft, ID `vscode.git`) → click Disable → confirm.

[User] Reload the VS Code window (`Developer: Reload Window`).

Expected: An error notification reads: `GitBase: VS Code Git extension not found. Extension disabled.`
Expected: No GitBase Changes panel appears in the SCM view.
Expected: No crash, no unhandled exceptions, no other notifications from GitBase.

Note: `extension.ts:16–19` calls `vscode.extensions.getExtension('vscode.git')`; if the result is falsy, it shows the error and returns early. All further extension functionality (providers, commands, content providers, decorations) is never registered in this path.

[Reset] Re-enable the built-in git extension:

[User] Open the Extensions view → find the built-in Git extension → click Enable.

[User] Reload the VS Code window.

Expected: The GitBase Changes panel reappears with label `Branch · origin/main`.

---

## Section B: Picker Edge Cases

**Purpose:** Verify picker behaviour in unusual states: no detectable default branch, ambiguous name, empty tag list.

**Precondition:** Base is `Branch · origin/main`. Tags `v1.0` and `v1.1` exist. `feature/beta` exists.

### B.1 — `Default branch` absent when no default is detectable (`FS-02 S14`)

[Claude] Remove `origin/HEAD` and unset the current branch's upstream tracking so `detectDefaultBranch` returns `null`:
```
git remote set-head origin --delete
git branch --unset-upstream
```

[User] Open the picker.

Expected: The `Default branch` item is **not** present in the picker — the conditional at `picker.ts:32` skips it when `detectDefaultBranch` returns `null`.
Expected: The picker shows only: `Branch…`, `Tag…`, `Commit…`, `Enter ref…`, `GitHub PR · my work vs target…`, `GitHub PR · PR changes…`.

[User] Press Escape to close the picker.

[Reset] Restore upstream and `origin/HEAD`:
```
git branch --set-upstream-to=origin/main
git remote set-head origin -a
```

### B.2 — Ambiguous name: branch wins over tag, warning shown (`FS-02 S15`)

**Precondition:** Tag `v1.0` exists. We will create a local branch with the same name.

[Claude] Create a local branch named `v1.0`:
```
git branch v1.0 HEAD
```

[User] Open the picker → Enter ref… → type `v1.0` → confirm.

Expected label: `Branch · v1.0` (NOT `Tag · v1.0`).
Expected stored type: `Branch`.
Expected: A warning notification reads: `"v1.0" matches both a branch and a tag. Treating as branch. Use the Tag… picker to select the tag.`

Note: `detectRefType` checks `refs/heads/v1.0` first (`git.ts:84`). When that succeeds, it additionally checks `refs/tags/v1.0` and returns `{ type: 'Branch', shadowed: 'tag' }` when both exist. The caller in `picker.ts` shows the warning but still returns `Branch`. Users who want the tag must use the `Tag…` picker.

[Reset] Remove the ambiguous branch:
```
git branch -D v1.0
```

[User] Open the picker → Default branch.
Expected label: `Branch · origin/main`

### B.3 — Empty Tag picker behaves like cancel (`FS-02 S16`)

**Precondition:** Tags `v1.0` and `v1.1` exist (or were recreated after any previous test that deleted them).

[Claude] Capture the tag SHAs before deleting (they cannot be recovered from the log once the local refs are gone):
```
V1_0_SHA=$(git rev-parse v1.0)
V1_1_SHA=$(git rev-parse v1.1)
echo "v1.0 → $V1_0_SHA"
echo "v1.1 → $V1_1_SHA"
```

[Claude] Delete all tags from the test repo:
```
git tag -d $(git tag -l)
```

[User] Open the picker → Tag….

Expected: An empty quick pick appears with placeholder `Select tag…` and no items listed.

[User] Press Escape (or close the picker).

Expected: No error message, no notification — behaves identically to cancelling the base picker. The `?.label` optional chain at `picker.ts:182` yields `undefined`; `if (!newRef) return undefined` exits silently.

Note: The same silent-cancel behaviour applies to the Branch picker on an unborn repo (no refs yet) and the Commit picker on a repo with no commits. The Tag picker empty case is common: many repos have no tags at all.

[Reset] Restore the tags using the SHAs captured before deletion:
```
git tag v1.0 $V1_0_SHA
git tag v1.1 $V1_1_SHA
git push origin refs/tags/v1.0 refs/tags/v1.1
```

---

## Section C: Commit Picker Depth Limit (`FS-02 S05b`)

**Purpose:** Verify the Commit picker shows at most 50 commits and that the footer label is visible, and that Enter ref… can be used to select older commits.

**Precondition:** A separate scratch repo with more than 50 commits. Claude creates this repo.

### C.1 — Setup: create a 55-commit scratch repo

[Claude] Create a scratch repo with 55 commits:
```
SCRATCH=$(mktemp -d)
cd "$SCRATCH"
git init
git commit --allow-empty -m "commit 1"
for i in $(seq 2 55); do
  git commit --allow-empty -m "commit $i"
done
echo "Scratch repo: $SCRATCH"
echo "Commit at position 51:"
git log --format="%H %s" | sed -n '51p'
```
Note the path (`$SCRATCH`) and the SHA/subject at position 51.

[User] Open this scratch repo in VS Code: File → Open Folder → select the path Claude printed.

Expected: The GitBase Changes panel appears with label `HEAD · Select a base to begin` (no `origin/HEAD`, no tracking branch — auto-detect finds nothing).

### C.2 — Commit picker shows footer and truncates at 50

[User] Open the picker → Commit….

Expected: The commit list shows at most 50 entries (commits 55 down to commit 6 by subject line).
Expected: The target commit (`commit 1`, `commit 2`, …, `commit 5`) does NOT appear in the list — only the 50 most recent are shown.
Expected: A greyed footer item at the bottom of the list reads `Showing 50 most recent — use Enter ref… to set an older commit`.

[User] Press Escape to close the picker without selecting.

### C.3 — Enter ref… can set a commit beyond picker depth

[User] Open the picker → Enter ref… → paste the SHA Claude printed for position 51 → confirm.

Expected label: `Commit · commit 5` (or whichever subject matches position 51 — Enter ref… resolves the SHA to its subject line).

[Check] Verify the stored ref equals the pasted SHA (full 40 characters).

Note: This is the only way to set a base older than position 50. The 50-commit limit (`git log -50` at `picker.ts:185`) is a fixed design choice; there is no pagination or search for older commits.

[Reset] Close the scratch repo in VS Code (File → Close Folder or remove from workspace). Claude removes the scratch directory:
```
rm -rf "$SCRATCH"
```

[User] Re-open the primary test repo in VS Code.
Expected label after re-open: `Branch · origin/main` (restored from workspaceState).

---

## Section D: Unborn Repository (`FS-03 S12`)

**Purpose:** Verify the extension handles a repo with no commits without crashing.

**Precondition:** A separate fresh scratch repo with no commits. Claude creates this.

### D.1 — Setup: create an unborn scratch repo

[Claude] Create a fresh, empty git repo:
```
UNBORN=$(mktemp -d)
cd "$UNBORN"
git init
echo "Unborn repo: $UNBORN"
```

[User] Open this unborn repo in VS Code: File → Open Folder → select the path Claude printed.

Expected: The GitBase Changes panel appears with label `HEAD · Select a base to begin` (auto-detect finds no `origin/HEAD`).
Expected: No crash occurs. The SCM list is empty (`git diff HEAD` fails because there is no HEAD yet; `nsOut === null` in the provider, so the list stays empty silently).

### D.2 — First commit causes graceful refresh

[Claude] Make the first commit:
```
cd "$UNBORN"
echo "hello" > first.txt
git add first.txt
git commit -m "init"
```

[User] Observe the GitBase Changes panel. Wait up to 1 second.

Expected: The provider refreshes without error — `repo.state.onDidChange` fires, scheduling a refresh. The SCM list remains empty (base is still `HEAD`; `git diff HEAD` on a now-valid HEAD produces no output). No error notification appears.

[Check] Confirm no error notifications appeared in VS Code (the notification area is clear of GitBase errors).

[Reset] Close the unborn repo in VS Code. Claude removes the scratch directory:
```
rm -rf "$UNBORN"
```

[User] Re-open the primary test repo in VS Code.
Expected label: `Branch · origin/main`

---

## Teardown

All scratch repos have been removed in their respective Reset steps. The primary test repo should be clean.

[Claude] Verify the primary test repo state:
```
git status
git tag -l
git branch -a
git symbolic-ref refs/remotes/origin/HEAD
```
Expected: Working tree clean, tags `v1.0` and `v1.1` present, branches `main`, `feature/alpha`, `feature/beta`, `old-branch` present, `origin/HEAD` → `origin/main`.

[User] Open the picker → Default branch.
Expected label: `Branch · origin/main`

The repo is now in a clean state for the next combined test plan.
