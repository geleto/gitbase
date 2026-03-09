# Combined Test Plan 05 — GitHub PR

## Coverage

| Feature Set | Scenarios Included |
|-------------|-------------------|
| FS-08 · GitHub PR: Base Only | S01, S02, S03, S04, S05, S06, S07, S08, S09, S10, S11 |
| FS-09 · GitHub PR: Full Review | S01, S02, S02b, S02c, S03, S04, S05, S06, S07, S08, S08b, S09, S10, S11, S12, S13, S14, S15, S16, S17, S18 |
| FS-05 · SCM Label & Decorations | S04 |

## Prerequisites

- FS-01 completed: primary test repo exists, VS Code is open on it
- A real GitHub repository with at least one open pull request
- Valid GitHub authentication in VS Code (or the ability to sign in during the test)
- Internet access
- Working branch: `feature/alpha`

> **Shell:** All `[Claude]` commands use bash syntax (`$(…)`, `mktemp`, `grep`, etc.). Run them from Claude Code's integrated bash shell, Git Bash, or WSL — not from PowerShell directly.

## Optimisation Rationale

FS-08 and FS-09 are already the most efficient structure for PR testing — they depend on a live GitHub connection and real PR state that cannot be parallelised. Within this plan, FS-08 S08 and S09 (dirty-state picker label) are combined into one picker-open observation. FS-09 S05, S06, S07 flow naturally as one sequence (commit in detached HEAD → cancel → confirm). FS-05 S04 (PR label format) is verified inline during FS-08 S01 rather than separately.

---

## Section A: PR Base-Only Mode (`FS-08`)

### A.1 — Happy path: public repo, no auth; verify PR label format (`FS-08 S01` + `FS-05 S04`)

**Precondition:** A public GitHub repo with an open PR. User is NOT signed in to GitHub in VS Code.

[User] Open the picker → `GitHub PR · my work vs target…` → enter the PR URL.

Expected: A progress notification reads `GitHub PR #N…` while the metadata is fetched.
Expected: No GitHub sign-in prompt appears (public repo does not require auth).
Expected: SCM label: `GitHub PR #N · owner/repo · my work vs target` (FS-05 S04 — PR labels have no type prefix like `Branch ·` or `Tag ·`).
Expected: No additional info notification appears when the base is fresh — the label change is the only feedback.

[Check] Verify HEAD is unchanged (no checkout occurred):
```
git rev-parse HEAD
git rev-parse --abbrev-ref HEAD
```
Expected: Still on `feature/alpha`, SHA unchanged.

[Check] Verify the base branch was fetched locally:
```
git rev-parse --verify origin/<base-branch>
```
Expected: exits 0 (the ref exists locally after the fetch).

[User] Open the picker again and observe the items.

Expected: `← Exit GitHub PR Review` is **not** listed. PR base-only mode does not set `prReviewState`; the exit item only appears after entering pr-review mode.

[Check] Verify workspaceState key `taskChanges.prReview.<root>` is absent (the base-only mode does not write to this key).

### A.2 — Invalid URL rejected at input (`FS-08 S03`)

[User] Open the picker → `GitHub PR · my work vs target…` → type `not-a-url` in the input box.

Expected: The input box shows a validation error: `Expected: https://github.com/owner/repo/pull/123`.
Expected: The input box cannot be submitted while the URL is invalid (the submit button or Enter key is disabled/ignored).

[User] Press Escape to close the input box.

### A.3 — Valid URL format, non-existent PR (`FS-08 S04`)

[User] Open the picker → `GitHub PR · my work vs target…` → enter a well-formed URL with a PR number that does not exist (e.g. `https://github.com/<owner>/<repo>/pull/999999`).

Expected: An error message reads: `PR #999999 was not found on GitHub. Check the PR number in the URL.`
Expected: No sign-in prompt appears (HTTP 404 is distinct from 401 — no auth retry is attempted).

[Check] Verify the stored base is unchanged from the value before this step.

Note: `resolvePrMeta` returns `'not-found'` for HTTP 404, which `picker.ts` handles with a targeted error message without triggering the auth retry path. HTTP 401 still triggers `createIfNone: true`.

### A.4 — Base branch not yet fetched locally (`FS-08 S05`)

[User] Find the PR's target base branch name from the GitHub PR page (shown next to "into" in the PR header). Call it `<base-branch>`.

[Claude] Delete the local remote-tracking ref for that branch to simulate it never having been fetched:
```
git branch -dr origin/<base-branch>
```

[Check] Verify the ref is gone before proceeding:
```
git rev-parse --verify origin/<base-branch> 2>/dev/null && echo "still exists" || echo "deleted OK"
```
Expected: `deleted OK`.

[User] Enter the same PR URL via `GitHub PR · my work vs target…`.

Expected: The extension fetches the base branch and the label updates correctly.

[Check] Verify the base branch now exists locally:
```
git rev-parse --verify origin/<base-branch>
```
Expected: exits 0.

### A.5 — Diff is against current branch, not PR head (`FS-08 S06`)

**Precondition:** PR base is currently set (from A.4 or A.1).

[Claude] Make a local edit without staging or committing:
```
echo "# review note" >> README.md
```

[User] Observe the GitBase SCM list.

Expected: The edit appears in the diff list (README.md shown as M).

[Check] Confirm HEAD is still on `feature/alpha`, not the PR head SHA:
```
git rev-parse --abbrev-ref HEAD
```
Expected: `feature/alpha`

[Claude] Revert the test edit:
```
git checkout -- README.md
```

### A.6 — Diff uses merge-base, not base branch tip (`FS-08 S07`)

**Precondition:** A PR where `origin/<base-branch>` has advanced since the PR was branched (the base branch has commits not in `feature/alpha`).

[User] Set base using `GitHub PR · my work vs target…` for the PR.

Expected: Only `feature/alpha`'s own commits are shown in the diff — not the base branch's newer commits.

[Check] Verify merge-base is used:
```
git diff $(git merge-base HEAD origin/<base-branch>) HEAD --name-only
```
Expected: The listed files match the GitBase SCM list.

Note: `baseType === 'PR'` triggers the merge-base path in `provider.ts`, same as `baseType === 'Branch'`.

### A.7 — Stash label: staged-only and untracked-only states (`FS-08 S08` + `FS-08 S09`)

**Both observations happen in a single picker open per state.**

**State 1 — staged-only dirty:**

[Claude] Stage a file change:
```
echo "staged change" >> README.md
git add README.md
```

[User] Open the picker and observe the `GitHub PR · PR changes…` item label.

Expected (FS-08 S08): The item label shows `GitHub PR · PR changes… (will stash)`.

Note: `isDirty = unstaged === null || staged === null`. `git diff --cached --quiet` exits non-zero when there are staged changes → `staged === null` → `isDirty = true` → `(will stash)` label appears even when the working tree itself is clean.

[User] Press Escape to close the picker.

[Claude] Unstage the change:
```
git restore --staged README.md
git checkout -- README.md
```

**State 2 — untracked-only (appears clean to picker):**

[Claude] Create only an untracked file:
```
echo "untracked" > new-untracked.txt
```

[User] Open the picker and observe the `GitHub PR · PR changes…` item label.

Expected (FS-08 S09): The item label does NOT show `(will stash)` — untracked-only state looks clean to `isDirty` because both `git diff --quiet` and `git diff --cached --quiet` exit 0.

[User] Press Escape.

[Claude] Remove the untracked file:
```
rm new-untracked.txt
```

### A.8 — Stale local base branch used without re-fetching (`FS-08 S10`)

**Precondition:** `origin/<baseRef>` exists locally (from a previous fetch). The remote base branch has since advanced.

[Claude] Advance `origin/main` by committing on `main`. We are on `feature/alpha`, so switch branches first:
```bash
git checkout main
git commit --allow-empty -m "remote advance for stale test"
git push origin main
git checkout feature/alpha
```
Do NOT run `git fetch` in the working repo.

[Claude] Record the current stale local SHA:
```
git rev-parse origin/main
```
Note this SHA.

[Claude] Record the current remote SHA:
```
git ls-remote origin refs/heads/main | cut -f1
```
Note that this SHA differs from the stale local one.

[User] Enter a PR URL via `GitHub PR · my work vs target…`.

Expected: The extension accepts the selection without re-fetching (the `origin/main` ref already exists locally; the fetch guard at `pr.ts:104` is skipped).
Expected: One info notification: `Diff is against your local origin/main (last fetched). Run git fetch to update.` with a `Fetch Now` button.

[Check] Verify no automatic fetch occurred yet:
```
git rev-parse origin/main
```
Expected: Still equals the stale SHA recorded above.

[User] Click `Fetch Now` in the notification.

Expected: `git fetch origin` runs and the SCM list updates automatically.

[Check] Verify the fetch occurred:
```
git rev-parse origin/main
```
Expected: Now equals the remote SHA recorded above (not the stale one).

Note: If the fetch fails (network error), an error notification `GitBase: git fetch failed. Check your network connection and remote configuration.` appears and the SCM list is not refreshed.

Note: The extension avoids fetching on every base selection to stay fast and offline-friendly. The `Fetch Now` button lets the user update on demand without leaving VS Code.

### A.9 — Private repo triggers auth prompt (`FS-08 S02`)

**Precondition:** A private GitHub repo with an open PR. User is NOT signed in to GitHub in VS Code.

[User] Open the picker → `GitHub PR · my work vs target…` → enter the private repo's PR URL.

Expected: A GitHub sign-in prompt appears.

[User] Sign in.

Expected: After authentication, the PR resolves successfully and the label updates.

### A.10 — Base-branch fetch failure produces an immediate error (`FS-08 S11`)

**Precondition:** GitHub API returns valid PR metadata, but `origin/<baseRef>` does not exist locally AND the fetch will fail.

[User] Identify `<baseRef>` from the GitHub PR page (the branch name shown next to "into").

[Claude] Delete the local remote-tracking ref so it does not exist locally, then corrupt the origin URL so the fetch fails:
```
git branch -dr origin/<baseRef>
```
Verify it is gone:
```
git rev-parse --verify origin/<baseRef> 2>/dev/null && echo "still exists" || echo "deleted OK"
```
Expected: `deleted OK`.

Then temporarily change origin to an unreachable URL:
```
git remote set-url origin file:///nonexistent-path
```

[User] Enter a valid PR URL via `GitHub PR · my work vs target…`.

Expected: The picker does NOT close with a success label. An error notification reads: `Could not fetch base branch from origin. Check your network connection.`
Expected: The stored base is unchanged.

[Check] Verify the base ref was never populated:
```
git rev-parse --verify origin/<baseRef>
```
Expected: exits non-zero.

[Reset] Restore the origin URL:
```
git remote set-url origin <original-bare-repo-path>
```

---

## Section B: PR Full Review Mode (`FS-09`)

### B.1 — Happy path: clean working tree (`FS-09 S01`)

**Precondition:** Working tree is clean. On `feature/alpha`.

[User] Open the picker → `GitHub PR · PR changes…` → enter a valid PR URL.

Expected: A progress spinner appears. No stash prompt (working tree is clean).
Expected: SCM label: `GitHub PR #N · owner/repo · PR changes`
Expected: Opening the picker again shows `← Exit GitHub PR Review  return to feature/alpha` at the top.

[Check] Verify HEAD is detached at the PR's head SHA:
```
git rev-parse HEAD
git rev-parse --abbrev-ref HEAD
```
Expected: Second command outputs `HEAD` (detached state). First command matches the PR head SHA.

[Check] Verify nothing was stashed:
```
git stash list
```
Expected: Empty.

### B.2 — Exit restores branch and stash (`FS-09 S03`)

**Precondition:** Continuing from B.1 (in PR review, no stash).

[User] Open the picker → `← Exit GitHub PR Review`.

Expected: A progress spinner reads `Exiting GitHub PR Review…`.
Expected: No error or warning messages.
Expected: SCM label reverts to the previous base (e.g. `Branch · origin/main`).
Expected: `← Exit GitHub PR Review` no longer appears in the picker.

[Check] Verify HEAD is back on `feature/alpha`:
```
git rev-parse --abbrev-ref HEAD
```
Expected: `feature/alpha`

[Check] Verify stash list is empty:
```
git stash list
```

### B.3 — Persist PR review across VS Code restart (`FS-09 S11`)

[User] Open the picker → `GitHub PR · PR changes…` → enter the PR URL again (re-enter review mode).

Expected: SCM label: `GitHub PR #N · owner/repo · PR changes`

[User] Reload the VS Code window (`Developer: Reload Window`).

Expected: After reload, `← Exit GitHub PR Review` still appears at the top of the picker.
Expected: The exit description still shows the correct `prevBranch` (`return to feature/alpha`).

### B.4 — Happy path: dirty working tree with stash (`FS-09 S02`)

**Precondition:** Exit PR review first (if still in it from B.3):

[User] Open the picker → `← Exit GitHub PR Review` (if visible).

[Claude] Modify a tracked file without staging:
```
echo "# dirty for stash test" >> README.md
```

[User] Open the picker → `GitHub PR · PR changes… (will stash)` → enter the PR URL.

Expected: The modification disappears from the working tree (it is stashed).

[Check] Verify the stash:
```
git stash list
```
Expected: One entry with message `gitbase: PR review`.

[Claude] Capture the stash SHA for later verification:
```
git rev-parse stash@{0}
```
Note this SHA.

Expected: The exit item description shows `return to feature/alpha · pop stash`.

[Check] Verify persistence of the stash indicator across a VS Code reload (`FS-09 S11` — stash variant):

[User] Reload the VS Code window (`Developer: Reload Window`).

Expected: `← Exit GitHub PR Review` still appears at the top of the picker after reload.
Expected: The exit description shows `return to feature/alpha · pop stash` — both the `prevBranch` and the stash indicator are preserved.

Note: `prReviewState` is persisted to workspaceState on every write; the stash indicator (`hasPendingStash: true`) is stored alongside `prevBranch`, so both survive a reload.

### B.5 — Exit restores working tree from stash (`FS-09 S03` via stash path)

**Precondition:** In PR review with stash from B.4.

[User] Open the picker → `← Exit GitHub PR Review`.

Expected: Progress spinner `Exiting GitHub PR Review…`.
Expected: No errors or warnings.

[Check] Verify HEAD is back on `feature/alpha`:
```
git rev-parse --abbrev-ref HEAD
```

[Check] Verify stash was popped:
```
git stash list
```
Expected: Empty.

[Check] Verify README.md has the modification restored:
```
git diff HEAD -- README.md
```
Expected: Shows the `# dirty for stash test` line.

[Claude] Revert the test modification:
```
git checkout -- README.md
```

### B.6 — Untracked-only state: not stashed, persists through checkout (`FS-09 S02b`)

[Claude] Create an untracked file:
```
echo "untracked" > orphan.txt
```

[User] Open the picker. Note the item label — it reads `GitHub PR · PR changes…` with NO `(will stash)` suffix.

[User] Select `GitHub PR · PR changes…` → enter the PR URL.

Expected: HEAD detaches at the PR head SHA.

[Check] Verify nothing was stashed:
```
git stash list
```
Expected: Empty.

[Check] Verify `orphan.txt` still exists (untracked files survive `git checkout --detach`):
```
ls orphan.txt
```

[User] Open the picker → `← Exit GitHub PR Review`.

[Check] Verify HEAD is back on `feature/alpha`; stash list is still empty; `orphan.txt` still exists.

[Claude] Remove the untracked file:
```
rm orphan.txt
```

Note: `pr.ts:113` uses `git stash push` without `-u`, so untracked files are never stashed. The exit description shows `return to feature/alpha` (no `· pop stash`).

### B.7 — Staged-only dirty state: stashed and restored as staged (`FS-09 S02c`)

[Claude] Stage a change:
```
echo "staged-change" >> README.md
git add README.md
```

[User] Open the picker → `GitHub PR · PR changes… (will stash)` → enter the PR URL.

[Check] Verify stash has one entry:
```
git stash list
```
Expected: One entry with message `gitbase: PR review`.

[Check] Verify working tree is clean (staged change is stashed):
```
git status
```

[User] Open the picker → `← Exit GitHub PR Review`.

[Check] Verify HEAD is back on `feature/alpha` and stash list is empty.

[Check] Verify the previously-staged change is back in the **index** (staged), not just the working tree:
```
git diff --cached -- README.md
```
Expected: Shows the `staged-change` line as a staged addition.

Note: `popStashBySha` calls `git stash pop --index`, which restores staged content back to the index, preserving the original staged/unstaged distinction.

[Claude] Unstage and discard the test change:
```
git restore --staged README.md
git checkout -- README.md
```

### B.8 — Exit with dirty working tree: Stash and Exit / Cancel (`FS-09 S04`)

[User] Open the picker → `GitHub PR · PR changes…` → enter the PR URL (re-enter review mode, clean working tree).

[Claude] Create a dirty working tree while in detached HEAD:
```
echo "review edit" >> README.md
```

[User] Open the picker → `← Exit GitHub PR Review`.

Expected: A warning dialog reads `You have uncommitted changes. Stash them and exit PR review?` with buttons `Stash and Exit` and `Cancel`.

**Test Cancel path:**

[User] Click `Cancel`.

Expected: Still in PR review mode (exit item still present); HEAD still detached.

**Test Stash and Exit path:**

[User] Open the picker → `← Exit GitHub PR Review` again → click `Stash and Exit`.

[Check] Verify HEAD is back on `feature/alpha`:
```
git rev-parse --abbrev-ref HEAD
```

[Check] Verify stash contains the exit stash:
```
git stash list
```
Expected: One entry (the `gitbase: exit stash` or similar message).

[Claude] Pop and discard the exit stash:
```
git stash pop
git checkout -- README.md
```

### B.9 — Detached commits warning: Cancel and Exit Anyway (`FS-09 S05` + `FS-09 S06` + `FS-09 S07`)

[User] Open the picker → `GitHub PR · PR changes…` → enter the PR URL.

[Claude] Make a commit in detached HEAD and capture its SHA:
```bash
echo "detached content" > test-detached.txt
git add test-detached.txt
git commit -m "detached commit"
DETACHED_SHA=$(git rev-parse HEAD)
echo "Detached commit SHA: $DETACHED_SHA"
```
Note the printed SHA — it is needed in the check below.

[User] Open the picker → `← Exit GitHub PR Review`.

Expected: A warning reads: `You have 1 unpublished commit in detached HEAD that will become unreachable after exit. Create a branch to keep them.`
Expected: Three buttons: `Create Branch…`, `Exit Anyway`, and `Cancel`.

**Test Cancel (FS-09 S06):**

[User] Click `Cancel`.

Expected: Still in PR review mode; no git changes; the detached commit is still reachable.

**Test Exit Anyway (FS-09 S07):**

[User] Open the picker → `← Exit GitHub PR Review` → click `Exit Anyway`.

Expected: Exits cleanly to `feature/alpha`.

[Claude] Verify the detached commit is no longer reachable from any branch (use the SHA noted above):
```bash
git branch --contains $DETACHED_SHA 2>/dev/null || echo "not reachable"
```
Expected: Output is `not reachable` — the commit is in the reflog but not on any branch.

[Claude] Clean up any stash created during this section:
```
git stash drop 2>/dev/null || true
```

### B.9a — Detached commits: Create Branch saves work and exits (`FS-09 S05a`)

[User] Open the picker → `GitHub PR · PR changes…` → enter the PR URL.

[Claude] Make a commit in detached HEAD:
```bash
echo "branch-save content" > test-branch-save.txt
git add test-branch-save.txt
git commit -m "commit to save via branch"
SAVE_SHA=$(git rev-parse HEAD)
echo "Commit SHA: $SAVE_SHA"
```

[User] Open the picker → `← Exit GitHub PR Review`.

Expected: Three-button warning as above.

[User] Click `Create Branch…`.

Expected: An input box appears with pre-filled value `review/pr-<N>` where `<N>` is the PR number extracted from the current base label, or `review/pr-changes` if no number is found.

[User] Accept the default or enter a custom name, then confirm.

Expected: The extension creates the branch at the current detached HEAD, exits cleanly to `feature/alpha`, and `← Exit GitHub PR Review` disappears.

[Check] Verify the branch was created containing the saved commit:
```bash
BRANCH_NAME="review/pr-changes"   # substitute actual name if different
git log "$BRANCH_NAME" --oneline -1
```
Expected: Shows the `commit to save via branch` subject.

[Check] Verify HEAD is back on `feature/alpha`:
```bash
git rev-parse --abbrev-ref HEAD
```

[Claude] Clean up:
```bash
BRANCH_NAME="review/pr-changes"
git branch -D "$BRANCH_NAME"
git stash drop 2>/dev/null || true
```

### B.10 — Force Exit when prevBranch is deleted (`FS-09 S08`)

[User] Open the picker → `GitHub PR · PR changes…` → enter the PR URL.

[Claude] Delete the previous branch while in PR review mode:
```
git branch -D feature/alpha
```

[User] Open the picker → `← Exit GitHub PR Review`.

Expected: An error reads: `Failed to restore previous branch. Run "git checkout feature/alpha" manually.`
Expected: A `Force Exit` button appears.

[User] Click `Force Exit`.

Expected: `← Exit GitHub PR Review` disappears from the picker.
Expected: The SCM label reverts to the previous base.

[Check] Verify no crash and the extension continues to function.

[Claude] Recreate `feature/alpha` at its original remote tip and switch to it:
```
git checkout -b feature/alpha origin/feature/alpha
git push origin feature/alpha 2>/dev/null || true
```

### B.11 — Force Exit after stash-and-exit failure discloses exit stash (`FS-09 S08b`)

[User] Open the picker → `GitHub PR · PR changes…` → enter the PR URL.

[Claude] Make a working-tree edit while in detached HEAD:
```
echo "review edit" >> README.md
```

[Claude] Delete the previous branch:
```
git branch -D feature/alpha
```

[User] Open the picker → `← Exit GitHub PR Review`.

Expected: Warning `You have uncommitted changes. Stash them and exit PR review?` → click `Stash and Exit`.

[Check] Verify stash was created:
```
git stash list
```
Expected: One entry with message `gitbase: exit stash`.

Expected: A second error: `Failed to restore previous branch. Run "git checkout feature/alpha" manually.`

[User] Click `Force Exit`.

Expected: An additional warning: `Your stashed changes are saved as "gitbase: exit stash". Run "git stash pop" to recover them.` with a `Copy command` button.

[Check] Verify the exit stash is still in the stash list.

[Claude] Clean up: drop the stash and recreate `feature/alpha` at its original remote tip:
```
git stash drop
git checkout -b feature/alpha origin/feature/alpha
git push origin feature/alpha 2>/dev/null || true
```

### B.12 — Stash popped by SHA not by position (`FS-09 S09`)

[Claude] Modify README.md to create a dirty state:
```
echo "dirty for stash sha test" >> README.md
```

[User] Open the picker → `GitHub PR · PR changes… (will stash)` → enter the PR URL.

[Claude] Capture and note the gitbase stash SHA (used to confirm it is the one that gets popped):
```
git rev-parse stash@{0}
```

[Claude] Push an unrelated stash on top:
```
git stash push -m "unrelated"
```

Now the stack is: `stash@{0}` = unrelated, `stash@{1}` = gitbase PR review.

[User] Open the picker → `← Exit GitHub PR Review`.

Expected: Exits cleanly. The `gitbase: PR review` stash was popped (by SHA, not by position).
Expected: The `unrelated` stash is still present.

[Check] Verify:
```
git stash list
```
Expected: Exactly one entry — the `unrelated` stash.

[Claude] Clean up:
```
git stash drop
git checkout -- README.md
```

### B.13 — Stash already manually popped before exit (`FS-09 S10`)

[Claude] Create dirty state:
```
echo "dirty for manual pop test" >> README.md
```

[User] Open the picker → `GitHub PR · PR changes… (will stash)` → enter the PR URL.

[Claude] Manually pop the stash before exiting:
```
git stash pop
```

[User] Open the picker → `← Exit GitHub PR Review`.

Expected: Exits cleanly with no error. The missing stash is handled gracefully (stash pop is skipped — already gone).

[Check] Verify stash list is empty:
```
git stash list
```

[Claude] Clean up:
```
git checkout -- README.md 2>/dev/null || true
```

### B.14 — PR review entry item is hidden while already in review (`FS-09 S12`)

[User] Open the picker → `GitHub PR · PR changes…` → enter a PR URL (enter review mode).

[User] Open the picker again and scan the full list.

Expected: `GitHub PR · PR changes…` is **absent** — it is hidden when `prReviewState` is set.
Expected: `← Exit GitHub PR Review` is visible at the top of the picker.
Expected: No warning notification is needed — the picker itself communicates the state.

[User] Open the picker → `← Exit GitHub PR Review` to exit before proceeding.

### B.15 — Re-enter same PR after exiting (`FS-09 S13`)

**Precondition:** Just exited PR review (from B.14).

[User] Open the picker → `GitHub PR · PR changes…` → enter the same PR URL.

Expected: Enters cleanly (no error about "already in review"). If the working tree is dirty, a stash is created as normal.

[User] Open the picker → `← Exit GitHub PR Review` to exit.

### B.16 — Base-only then full review on same PR (`FS-09 S14`)

[User] Open the picker → `GitHub PR · my work vs target…` → enter PR #N URL.
Expected label: `GitHub PR #N · owner/repo · my work vs target`

[User] Open the picker → `GitHub PR · PR changes…` → enter the same PR #N URL.
Expected: HEAD detaches at the PR's head SHA.
Expected label changes to: `GitHub PR #N · owner/repo · PR changes`

[Check] Verify HEAD is detached:
```
git rev-parse --abbrev-ref HEAD
```
Expected: `HEAD`

[User] Open the picker → `← Exit GitHub PR Review`.

Expected label after exit: `GitHub PR #N · owner/repo · my work vs target` (NOT `Branch · …` or `Tag · …`) — PR labels are already fully descriptive and the type prefix is omitted.

Note: `provider.ts` stores `prevBaseType = undefined` when the previous base was type `'PR'`; on exit, `syncLabel` emits the raw `prevBaseLabel` without a prefix.

### B.17 — Auth prompt cancelled during PR entry (`FS-09 S15`)

**Precondition:** Private GitHub repo. A.9 signed the user in; sign out first.

[User] Open the Accounts menu (bottom-left of the VS Code window) → click the GitHub account entry → `Sign out`.

[User] Open the picker → `GitHub PR · PR changes…` → enter a PR URL from the private repo.

Expected: GitHub sign-in dialog appears.

[User] Dismiss or cancel the sign-in dialog.

Expected: Nothing happens — no error notification, silent no-op.
Expected: HEAD unchanged, no stash created.

[Check] Verify stash list is empty:
```
git stash list
```

Note: Cancelling `getSession({ createIfNone: true })` causes it to throw; the `catch` in `resolvePrMeta` returns `'auth-cancelled'`; `picker.ts` silently returns `undefined`. Auth cancellation is distinguishable from a network failure and treated as a deliberate user cancel.

### B.18 — PR entry checkout failure: clean working tree (`FS-09 S16`)

**Precondition:** Clean working tree.

[Claude] Install a git alias that makes `git checkout` always fail, to simulate a checkout error:
```
git config alias.checkout '!echo "simulated checkout failure" >&2 && exit 1'
```

[User] Open the picker → `GitHub PR · PR changes…` → enter a valid PR URL.

Expected: Error: `Failed to switch to PR #N. Ensure origin points to GitHub.`
Expected: No second warning (clean working tree means no stash was created).
Expected: HEAD unchanged, still on `feature/alpha`.

[Check] Verify stash list is empty:
```
git stash list
```

[Claude] Remove the alias:
```
git config --unset alias.checkout
```

### B.19 — PR entry checkout failure after stash was created (`FS-09 S17`)

**Precondition:** Dirty working tree (one modified file).

[Claude] Modify README.md and install the checkout-failure alias:
```
echo "dirty for checkout fail test" >> README.md
git config alias.checkout '!echo "simulated checkout failure" >&2 && exit 1'
```

Note: `git stash push` uses `git reset --hard` internally, not `git checkout`, so the alias does not block the stash step — only the subsequent detach-HEAD checkout fails.

[User] Open the picker → `GitHub PR · PR changes… (will stash)` → enter a valid PR URL.

Expected: Error: `Failed to switch to PR #N. Ensure origin points to GitHub.`
Expected: A second warning immediately after: `Your stashed changes could not be restored automatically — they are still safe in the stash. Run "git stash pop" to apply them; if there are conflicts, resolve them then run "git stash drop".` with a `Copy command` button.
Expected: Clicking `Copy command` copies `git stash pop` to clipboard.

[Check] Verify the stash entry is still present:
```
git stash list
```

[Check] Verify HEAD is still on `feature/alpha`.

[Claude] Remove the alias before restoring the stash (the alias must be gone before `git stash pop` runs):
```
git config --unset alias.checkout
```

[Reset] Restore the working tree:
```
git stash pop
git checkout -- README.md
```

### B.20 — Exit with stash pop conflict (`FS-09 S18`)

**Precondition:** Clean working tree on `feature/alpha`.

[Claude] Dirty README.md and enter PR review:
```bash
echo "stash conflict content" >> README.md
```

[User] Open the picker → `GitHub PR · PR changes… (will stash)` → enter the PR URL.

Now in detached HEAD. The stash records: parent = feature/alpha's current README.md; delta = append `stash conflict content`.

[Claude] While in detached HEAD, advance feature/alpha to a commit where README.md has been completely replaced (so the stash delta no longer applies cleanly). Use a linked worktree to commit onto feature/alpha without leaving detached HEAD:
```bash
CONFLICT_WT=$(mktemp -d)
git worktree add "$CONFLICT_WT" feature/alpha
echo "overwritten-for-conflict" > "$CONFLICT_WT/README.md"
git -C "$CONFLICT_WT" add README.md
git -C "$CONFLICT_WT" commit -m "advance feature/alpha for conflict test"
git worktree remove "$CONFLICT_WT"
```

[User] Open the picker → `← Exit GitHub PR Review`.

The exit sequence: `git checkout feature/alpha` → README.md = `overwritten-for-conflict\n`. Then `git stash pop --index` tries to apply the stash's delta (which expects the original README.md as its base) — the base mismatch causes a merge conflict, so the pop fails.

Expected: Exits back to `feature/alpha` (branch checkout succeeds).
Expected: Warning: `Your stashed changes could not be restored automatically — they are still safe in the stash. Run "git stash pop" to apply them; if there are conflicts, resolve them then run "git stash drop".` with `Copy command` button.
Expected: Clicking `Copy command` copies `git stash pop` to clipboard.

[Check] Verify the stash is still present (pop failed):
```
git stash list
```
Expected: One entry.

[Check] Verify HEAD is on `feature/alpha`:
```
git rev-parse --abbrev-ref HEAD
```

[Reset] Undo the advance commit and drop the stash:
```bash
git reset --hard HEAD~1
git stash drop stash@{0}
```

---

## Teardown

[Claude] Ensure working tree is clean and HEAD is on `feature/alpha`:
```
git status
git rev-parse --abbrev-ref HEAD
git stash list
```

If any stash entries remain, drop them:
```
git stash clear
```

If any uncommitted changes remain:
```
git checkout .
git clean -fd
```

[User] Open the picker → Default branch.
Expected label: `Branch · origin/main`

The repo is now in a clean state. GitHub PR testing complete.
