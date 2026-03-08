# Combined Test Plan 02 — Persistence & Base Recovery

## Coverage

| Feature Set | Scenarios Included |
|-------------|-------------------|
| FS-06 · Persistence & Recovery | S01, S02, S03, S04, S04b, S05, S05b, S05c, S06, S07, S09, S10, S11 |
| FS-05 · SCM Label & Decorations | S05 |

## Scenarios Excluded from This Plan

| Scenario | Reason | Goes to |
|----------|--------|---------|
| FS-06 S08 | Late repo discovery — requires multi-repo workspace setup | Combined-04 |

## Prerequisites

- FS-01 completed: test repo exists with branches `main`, `feature/alpha`, `feature/beta`, `old-branch`, tags `v1.0`, `v1.1`, `origin/HEAD → origin/main`
- VS Code is open on the test repo; GitBase Changes panel shows `Branch · origin/main`
- Extension is active

## Optimisation Rationale

This plan minimises window reloads — the most expensive user action — by batching scenarios that can share a reload. FS-06 S01 and S02 are merged into a single reload. The auto-detect fallback scenarios (S09, S10, S11) each require exactly one reload; they are sequenced to share setup and teardown steps. Deleted-ref recovery scenarios (S03–S05c) do not require reloads — the provider validates the ref on every periodic refresh.

FS-05 S05 ("no base" label) is placed here because it requires the same no-detectable-default-branch state used by FS-06 S04b, eliminating a duplicate setup.

---

## Section A: Persistence Across Reload

### A.1 — Commit label survives reload (`FS-06 S02`)

**Precondition:** Base is currently `Branch · origin/main`.

[Claude] Print a commit SHA to use as the base:
```
git log --oneline -5
```
Note the subject of the second commit in the list (HEAD~1).

[User] Open the picker → Commit… → select that commit by its subject line. Note the exact label shown.
Expected label: `Commit · <subject>`

[User] Reload the VS Code window (`Developer: Reload Window`).

Expected: After reload, the label still shows `Commit · <subject>` — not just the raw SHA, and not `Branch · origin/main`. The stored label is persisted independently of the ref.

### A.2 — Branch base survives reload (`FS-06 S01`)

**Precondition:** Continuing from A.1 (base is a Commit).

[User] Open the picker → Branch… → select `origin/feature/alpha`.
Expected label: `Branch · origin/feature/alpha`

[User] Reload the VS Code window.

Expected: After reload, the label still shows `Branch · origin/feature/alpha` without re-selecting.

[User] Open the picker → Default branch to restore base to `origin/main` before proceeding.
Expected label: `Branch · origin/main`

---

## Section B: Auto-Detect on First Open

### B.1 — Auto-detect `origin/main` when no base is stored (`FS-06 S06`)

[Claude] Clear the workspaceState base key for this repo. The key is `taskChanges.base.<repo-root-path>`. Use the VS Code developer tools (Help → Toggle Developer Tools → Application → Storage → IndexedDB) to delete the key, OR use the extension's built-in clear command if available, OR simulate by directly editing the SQLite workspaceStorage database. If none of these are accessible, skip to B.1 verification after the next step instead: set a non-default base, reload, and verify the auto-detect fires.

Alternatively: set the base to a ref that does not exist so the provider clears it on startup:
```
# This approach works without direct workspaceState access:
# After the reload the provider will find origin/HEAD → origin/main and auto-detect it
```

[User] Reload the VS Code window.

Expected: The label briefly shows `HEAD · Select a base to begin` (while auto-detection is running), then updates to `Branch · origin/main` within a few seconds.

Note: `detectDefaultBranch` step 2 reads `git symbolic-ref refs/remotes/origin/HEAD` → resolves to `origin/main` → sets the base automatically. This fires on every startup when no base is stored and `autoDetectDone` is `false`.

---

## Section C: Deleted Ref Recovery

### C.1 — Deleted branch triggers notification and auto-recovers (`FS-06 S03` + `FS-06 S04`)

**Precondition:** `feature/beta` exists locally and on origin. `origin/HEAD` → `origin/main` is configured (so auto-recovery can find a default).

[User] Open the picker → Branch… → select `feature/beta`.
Expected label: `Branch · feature/beta`

[Claude] Delete `feature/beta` locally and from origin:
```
git branch -D feature/beta
git push origin --delete feature/beta
```

Wait a moment (up to ~2 seconds) for the provider's periodic refresh to fire.

[User] Observe the notification area and the GitBase label.

Expected (FS-06 S03): An info notification (not a warning) reads: `GitBase: base ref "feature/beta" was deleted; auto-recovered to origin/main.` No `Select Base` button appears.
Expected (FS-06 S04): The SCM label has automatically updated to `Branch · origin/main`. No user action was required.

[Check] Verify the stored base key is now `origin/main`.

Note: Auto-recovery runs before the notification fires. If `detectDefaultBranch` succeeds (it finds `origin/HEAD → origin/main`), the extension recovers silently and shows an info notification. If it fails (no default detectable), it shows a warning with a `Select Base` button — that path is tested in C.3.

[Reset] Recreate `feature/beta` for use in later scenarios:
```
git checkout -b feature/beta
git push origin feature/beta
git checkout feature/alpha
```

### C.2 — Deleted tag triggers warning and auto-recovers (`FS-06 S05b`)

[User] Open the picker → Tag… → select `v1.0`.
Expected label: `Tag · v1.0`

[Claude] Delete tag `v1.0` locally and from origin:
```
git tag -d v1.0
git push origin --delete refs/tags/v1.0
```

Wait for the periodic refresh.

[User] Observe the notification area and the GitBase label.

Expected: A notification reads: `GitBase: base ref "v1.0" no longer exists. Select a new base to continue.` OR the auto-recovery info notification if `origin/main` is detectable (same logic as C.1 — auto-recovery fires first, notification wording reflects the outcome).
Expected: SCM label updates to `Branch · origin/main`.

[Check] Verify the stored base key is now `origin/main`.

Note: `provider.ts:106` runs `git rev-parse --verify <ref>` regardless of ref type. A deleted tag is caught by the same validation path as a deleted branch.

[Reset] Recreate `v1.0` pointing to its original commit:
```
git tag v1.0 <original-v1.0-commit-sha>
git push origin refs/tags/v1.0
```
(Get the original SHA from the reflog: `git reflog | grep v1.0` or use `git log --oneline --decorate`.)

### C.3 — Orphaned commit SHA triggers recovery (`FS-06 S05c`)

[Claude] Create a temporary commit on a detached HEAD, capture its SHA, then abandon it:
```
git checkout --detach HEAD
echo "orphan content" > orphan-test.txt
git add orphan-test.txt
git commit -m "orphan commit for FS-06 S05c"
ORPHAN_SHA=$(git rev-parse HEAD)
echo "Orphan SHA: $ORPHAN_SHA"
git checkout feature/alpha
git reflog expire --expire=now --all
git gc --prune=now
```

[Claude] Manually set the workspaceState base key to `$ORPHAN_SHA`. (If direct workspaceState access is not available, use the picker: Enter ref… → paste `$ORPHAN_SHA` before the GC step, then run the GC.)

Wait for the periodic refresh (or trigger one by clicking refresh).

[User] Observe the notification area.

Expected: A notification reads: `GitBase: base ref "<sha>" no longer exists. Select a new base to continue.`
Expected: Extension attempts `detectDefaultBranch` and auto-recovers to `origin/main` if found. SCM label updates to `Branch · origin/main`.

[Check] Verify stored base key is either `origin/main` or `undefined` (cleared).

Note: Orphaned SHAs are pruned by garbage collection. The recovery path is identical to deleted branches — `git rev-parse --verify <sha>` exits non-zero, triggering the same validation failure.

### C.4 — Auto-recovery fails when no default branch is detectable (`FS-06 S04b` + `FS-05 S05`)

**Precondition:** `feature/beta` exists (recreated in C.1 Reset).

[User] Open the picker → Branch… → select `feature/beta`.
Expected label: `Branch · feature/beta`

[Claude] Delete `feature/beta` to make the stored base invalid:
```
git branch -D feature/beta
git push origin --delete feature/beta
```

[Claude] Remove `origin/HEAD` and the current branch's upstream tracking so `detectDefaultBranch` returns `null`:
```
git remote set-head origin --delete
git branch --unset-upstream
```

Wait for the periodic refresh.

[User] Observe the notification area and the label.

Expected (FS-06 S04b): A **warning** notification (not info) reads: `GitBase: base ref "feature/beta" no longer exists. Select a new base to continue.`
Expected: A `Select Base` button appears in the notification (auto-recovery failed — no default was found).
Expected: The SCM label falls back to `HEAD · Select a base to begin` (base cleared to `undefined`).

[Check] Verify the stored base key is `undefined` or absent.

**Now verify FS-05 S05 using this same state:**

[Claude] Clear the workspaceState base key (already cleared by the recovery above).

[User] Reload the VS Code window.

Expected (FS-05 S05): After reload, the SCM label shows `HEAD · Select a base to begin` and stays there — it does NOT snap to `Branch · origin/main` because `detectDefaultBranch` returns `null` (no `origin/HEAD`, no `origin/main`, no `origin/master`, no upstream tracking branch).

Note: In a repo that has `origin/HEAD → origin/main`, clearing workspaceState and reloading will show this label only transiently (~400ms) before auto-detect fires and sets `Branch · origin/main`. To observe the steady-state "no base" label, auto-detection must have nothing to find — which is the state we are in now.

### C.5 — Warning notification `Select Base` button opens picker (`FS-06 S05`)

**Precondition:** The warning notification from C.4 is still visible, or a fresh one can be triggered by the same state.

[User] Click the `Select Base` button in the warning notification.

Expected: The base picker opens.

[User] Press Escape to close the picker without selecting.

[Reset] Restore `origin/HEAD` and upstream tracking before the next section:
```
git remote set-head origin -a
git branch --set-upstream-to=origin/main
```
Recreate `feature/beta`:
```
git checkout -b feature/beta
git push origin feature/beta
git checkout feature/alpha
```

[User] Open the picker → Default branch.
Expected label: `Branch · origin/main`

---

## Section D: Auto-Detect Fallback Chain

**Purpose:** Verify each step of `detectDefaultBranch` (`git.ts`) in order. Steps 2–4 are tested here; step 1 (non-origin remote) is tested in D.4.

Each subsection requires a window reload. They are sequenced so each setup is a small delta from the previous reset.

### D.1 — Fallback to `origin/master` when `origin/HEAD` is absent (`FS-06 S09`)

**Precondition:** `origin/main` exists. We need `origin/master` to exist but `origin/main` to NOT exist, and `origin/HEAD` to be absent.

[Claude] Set up the required state:
```
# Create origin/master pointing to main's current tip
git push origin main:master

# Remove origin/main from the remote
git push origin --delete main

# Remove origin/HEAD symref
git remote set-head origin --delete

# Update local remote-tracking refs
git fetch origin
```

[Claude] Clear the workspaceState base key. Reload will trigger auto-detect.

[User] Reload the VS Code window.

Expected: The extension auto-detects `origin/master` — step 3 of `detectDefaultBranch` tries `origin/main` (fails — does not exist), then `origin/master` (succeeds).
Expected: SCM label updates to `Branch · origin/master`.

[Reset] Restore the original state:
```
git push origin master:main
git push origin --delete master
git remote set-head origin -a
git fetch origin
```

[User] Open the picker → Default branch.
Expected label: `Branch · origin/main`

### D.2 — Fallback to upstream tracking branch (`FS-06 S10`)

**Precondition:** Current branch tracks a remote branch with a non-standard name. We will simulate this by setting a non-standard upstream.

[Claude] Set up:
```
# Create a branch named 'develop' on origin (pointing to the current tip)
git push origin main:develop

# Set the current branch's upstream to origin/develop
git branch --set-upstream-to=origin/develop

# Remove origin/HEAD and common branch names
git remote set-head origin --delete
git push origin --delete main 2>/dev/null || true

# Fetch so origin/develop is in local remote-tracking refs
git fetch origin
```

[Claude] Clear the workspaceState base key.

[User] Reload the VS Code window.

Expected: The extension auto-detects `origin/develop` — step 4 of `detectDefaultBranch` runs `git rev-parse --abbrev-ref HEAD@{upstream}` → gets `origin/develop` → that ref exists → returns it.
Expected: SCM label updates to `Branch · origin/develop`.

[Reset] Restore:
```
git branch --set-upstream-to=origin/main
git push origin main 2>/dev/null || true
git push origin --delete develop
git remote set-head origin -a
git fetch origin
```

[User] Open the picker → Default branch.
Expected label: `Branch · origin/main`

### D.3 — Fallback to non-origin remote's symbolic HEAD (`FS-06 S11`)

**Precondition:** We will add a second remote named `upstream` pointing to the bare origin repo, configure its HEAD, and remove `origin/HEAD` so step 2 does not fire.

[Claude] Get the path of the bare origin repo:
```
git remote get-url origin
```
Note this path (it is the bare repo created in FS-01).

[Claude] Set up:
```
ORIGIN_URL=$(git remote get-url origin)

# Add an 'upstream' remote pointing to the same bare repo
git remote add upstream "$ORIGIN_URL"
git fetch upstream

# Configure upstream/HEAD to point to upstream/main
git remote set-head upstream -a

# Set the current branch to track upstream/main
git branch --set-upstream-to=upstream/main

# Remove origin/HEAD so step 2 does not fire before step 1
git remote set-head origin --delete
```

[Check] Verify upstream HEAD is configured:
```
git symbolic-ref --short refs/remotes/upstream/HEAD
```
Expected output: `upstream/main`

[Claude] Clear the workspaceState base key.

[User] Reload the VS Code window.

Expected: The extension auto-detects `upstream/main` — step 1 of `detectDefaultBranch` reads the current branch's upstream remote (`upstream`), reads `refs/remotes/upstream/HEAD` → resolves to `upstream/main` → that ref exists → step 1 returns immediately without reaching steps 2–4.
Expected: SCM label updates to `Branch · upstream/main`.

Note: Step 1 fires only when there is a tracking branch AND the remote named by that branch has a symbolic HEAD that resolves. This is the highest-priority detection path. Step 2 (`origin/HEAD`) is only reached when either there is no tracking branch, or the tracking remote is `origin` and step 1 already set `triedOriginHead = true`.

[Reset] Remove `upstream` remote and restore original state:
```
git remote remove upstream
git branch --set-upstream-to=origin/main
git remote set-head origin -a
git fetch origin
```

[User] Open the picker → Default branch.
Expected label: `Branch · origin/main`

---

## Section E: Two Windows — Last-Writer-Wins (`FS-06 S07`)

**Purpose:** Verify that two VS Code windows on the same folder share workspaceState storage, and the last writer wins on reload.

**Precondition:** The test repo folder is known. No special git state needed.

[User] Open the same test repo in a **second** VS Code window (File → New Window, then File → Open Folder → select the test repo path).

[User] In **window A** (the original window): open the picker → Branch… → select `origin/feature/alpha`. Confirm label shows `Branch · origin/feature/alpha`.

[User] In **window B** (the new window): open the picker → Tag… → select `v1.0`. Confirm label shows `Tag · v1.0`.

Expected (while both windows remain open): Window A shows `Branch · origin/feature/alpha`; window B shows `Tag · v1.0`. Each window reflects its own last in-memory selection.

[User] Reload **window A** only (`Developer: Reload Window` in window A).

Expected: After reload, window A now shows `Tag · v1.0` — window B's write was the last one persisted to the shared storage key `taskChanges.base.<root>`, so it wins.

Note: Two VS Code windows on the same folder share the same workspaceState storage. The last window to write wins on reload. This is the intended (and only possible) behaviour given the storage architecture. The in-memory label divergence between windows is visible only until the next reload.

[Reset] In window A, open the picker → Default branch.
Expected label: `Branch · origin/main`

Close window B.

---

## Teardown

[Claude] Verify the repo is in a clean state:
```
git status
git remote -v
git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null
git rev-parse --abbrev-ref HEAD@{upstream} 2>/dev/null
```

Expected: Working tree clean, on `feature/alpha`, `origin/HEAD` → `origin/main`, upstream is `origin/main`.

If `feature/beta` was deleted and not restored during this plan, recreate it:
```
git checkout -b feature/beta 2>/dev/null || true
git push origin feature/beta 2>/dev/null || true
git checkout feature/alpha
```

[User] Open the picker → Default branch.
Expected label: `Branch · origin/main`

The repo is now in a clean state for the next combined test plan.
