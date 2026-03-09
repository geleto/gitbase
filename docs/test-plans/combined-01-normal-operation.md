# Combined Test Plan 01 — Normal Operation

## Coverage

| Feature Set | Scenarios Included |
|-------------|-------------------|
| FS-01 · Test Repository Setup | S01, S02, S03 |
| FS-02 · Base Selection | S01, S02, S03, S04, S05, S06, S07, S07b, S08, S09, S10, S11, S12, S13 |
| FS-03 · Diff Display | S01, S02, S03, S04, S05, S06, S07, S08, S09, S10, S11, S13 |
| FS-04 · File Actions | S01, S02, S03, S03b, S03c, S04, S05, S06, S07, S08, S09, S10, S11, S12, S13, S14, S15 |
| FS-05 · SCM Label & Decorations | S01, S02, S03, S06, S07, S08, S08b, S10 |

## Scenarios Excluded from This Plan

| Scenario | Reason | Goes to |
|----------|--------|---------|
| FS-02 S05b | Requires a repo with 50+ commits — special setup | Combined-03 |
| FS-02 S14 | Requires removing origin/HEAD and upstream tracking | Combined-03 |
| FS-02 S15 | Requires creating a branch that shadows a tag name | Combined-03 |
| FS-02 S16 | Requires deleting all tags from the repo | Combined-03 |
| FS-03 S12 | Requires a separate unborn (zero-commit) scratch repo | Combined-03 |
| FS-05 S04 | Requires GitHub PR base set — covered after FS-08 | Combined-05 |
| FS-05 S05 | Requires reload with no detectable default branch | Combined-02 |
| FS-05 S09 | Multi-repo specific | Combined-04 |

## Prerequisites

- A parent directory is available for the test repo and bare origin (Section 0 creates them from scratch).
- The GitBase extension source is available and Node.js / npm are installed (for the build step in Section 0.3).
- VS Code is installed with the GitBase extension installed or loadable from source.

> **If the test repo already exists and the extension is already built**, skip Section 0 and confirm: GitBase Changes panel shows `Branch · origin/main`; working branch is `feature/alpha`.

> **Shell:** All `[Claude]` commands use bash syntax (`$(…)`, `mktemp`, `grep`, etc.). Run them from Claude Code's integrated bash shell, Git Bash, or WSL — not from PowerShell directly.

## Optimisation Rationale

Section 0 folds the FS-01 repository setup and extension build verification into the start of this plan, so the test environment is validated before any feature testing begins. The original FS-03 S01–S05 scenarios set up one file state at a time and then test actions on each type separately (FS-04). This plan sets up all file states simultaneously in a single Claude setup pass, then has the user observe all types, act on each type, and verify labels — all in one session. FS-05 label verification is embedded into each picker selection rather than repeated as a separate feature set.

---

## Section 0: Repository Setup and Extension Verification

> **Run once.** If the test repository already exists and the extension is built, skip to Section A and confirm the label shows `Branch · origin/main` with working branch `feature/alpha`.

**Purpose:** Create the canonical test repository (`FS-01 S01`), verify the extension activates and auto-detects the default branch (`FS-01 S02`), and confirm the extension builds without errors (`FS-01 S03`).

### 0.1 — Create repo structure (`FS-01 S01`)

[Claude] Choose a parent directory (adjust `$BASE` to suit your system), then create the bare origin and working repo:
```bash
BASE="$HOME/gitbase-tests"
mkdir -p "$BASE"

# Bare origin
git init --bare "$BASE/origin.git"

# Working repo
git init "$BASE/testrepo"
cd "$BASE/testrepo"
git remote add origin "$BASE/origin.git"

# Initial commits on main
echo "# GitBase test repo" > README.md
echo "line 1" > file-a.txt
echo "line 2" > file-b.txt
echo "line 3" > file-c.txt
git add .
git commit -m "Initial commit"
git tag v1.0

echo "main update" >> README.md
git add README.md
git commit -m "Main: second commit"
git tag v1.1

git push origin HEAD:main
git branch -u origin/main main

# feature/alpha — branches from the first commit so it diverges from main
git checkout -b feature/alpha HEAD~1
echo "alpha change 1" >> file-a.txt
git add file-a.txt
git commit -m "Alpha: update file-a"
echo "alpha change 2" >> file-b.txt
git add file-b.txt
git commit -m "Alpha: update file-b"
git push origin feature/alpha
git branch -u origin/feature/alpha feature/alpha

# feature/beta
git checkout -b feature/beta main
echo "beta change" >> file-c.txt
git add file-c.txt
git commit -m "Beta: update file-c"
git push origin feature/beta
git branch -u origin/feature/beta feature/beta

# old-branch
git checkout -b old-branch main
echo "old content" > old-file.txt
git add old-file.txt
git commit -m "Old: add old-file"
git push origin old-branch

# Push tags
git push origin refs/tags/v1.0 refs/tags/v1.1

# Return to feature/alpha as the working branch
git checkout feature/alpha
```

[Check] Verify the topology:
```bash
git log --oneline --all --graph
```
Expected: branches `main`, `feature/alpha`, `feature/beta`, `old-branch` all visible with commits; tags `v1.0` and `v1.1` on `main`; `feature/alpha` diverges from `main` at the first commit.

[Check] Verify rename detection is enabled (required for S05 and FS-04 S10):
```bash
git config diff.renames
```
Expected: prints `true`, `1`, or nothing (default — enabled). If it prints `false` or `0`, fix it:
```bash
git config diff.renames true
```

[User] Open the working repo folder in VS Code (`File → Open Folder` → select `$BASE/testrepo`).
Expected: The GitBase Changes panel appears in the SCM view.

### 0.2 — Verify extension activates (`FS-01 S02`)

[User] Report the SCM group label shown under GitBase Changes.
Expected: `HEAD · Select a base to begin` — `origin/HEAD` is not yet configured, so `detectDefaultBranch` finds nothing at all four detection steps.

[Claude] Configure `origin/HEAD` and verify:
```bash
git remote set-head origin main
git symbolic-ref refs/remotes/origin/HEAD
```
Expected output of the second command: `refs/remotes/origin/main`

[User] Reload the VS Code window (`Developer: Reload Window`). Report the new label.
Expected: `Branch · origin/main`

Note: Auto-detection uses `origin/HEAD` directly (step 2 of `detectDefaultBranch` in `git.ts`) and does not require a local upstream tracking branch on the current branch.

### 0.3 — Build extension from source (`FS-01 S03`)

[Claude] Run the build in the extension source directory (adjust path to where the GitBase source lives):
```bash
cd /path/to/gitbase-extension
npm install && npm run compile
```
Expected: exits with code 0, no TypeScript errors printed.

[Check] Verify compiled output exists:
```bash
ls out/*.js 2>/dev/null || ls dist/*.js 2>/dev/null
```
Expected: at least one `.js` file listed.

Note: This step validates the TypeScript type system. Any type errors in source would be caught here before runtime testing begins.

---

## Section A: All-at-Once File State Setup

**Purpose:** Establish M, U, A (text), A (binary), D, and R entries in the SCM list with a single setup pass. Subsequent sections test display (FS-03), actions (FS-04), and decorations (FS-05) against this shared state.

**Precondition:** Working branch is `feature/alpha`, base is `Branch · origin/main`. Working tree is clean.

### A.1 — Set base to origin/main

[Claude] Verify current branch:
```
git rev-parse --abbrev-ref HEAD
```
Expected output: `feature/alpha`

[Claude] Verify base is stored correctly (read workspaceState via extension debug output or verify label matches after this step):
```
git symbolic-ref refs/remotes/origin/HEAD
```
Expected output: `refs/remotes/origin/main`

[User] If the label does not already show `Branch · origin/main`, open the picker → Default branch.
Expected label: `Branch · origin/main`

### A.2 — Create all file states simultaneously (`FS-03 S01, S02, S03, S04, S05, S06`)

[Claude] Identify specific tracked files to use for D and R operations (use files that exist on feature/alpha):
```
git ls-files | head -10
```
Note three filenames: one to modify (FILE_M), one to delete (FILE_D), one to rename (FILE_R). Use simple files in the repo root if available.

[Claude] Apply all working-tree changes at once:
```
# M: modify a tracked file
echo "# test modification" >> FILE_M

# U: create an untracked file
echo "untracked content" > untracked-test.txt

# A (text): create and stage a new text file
echo "staged content" > staged-test.txt
git add staged-test.txt

# D: remove a tracked file
git rm FILE_D

# R: rename a tracked file
git mv FILE_R renamed-test.txt

# A (binary): create a minimal PNG header and stage it
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82' > test-binary.png
git add test-binary.png
```

[User] Observe the GitBase Changes panel in the SCM view. Wait up to 1 second for auto-refresh.

Expected (FS-03 S01): FILE_M appears with `M` decoration.
Expected (FS-03 S02): `untracked-test.txt` appears with `U` decoration.
Expected (FS-03 S03): `staged-test.txt` appears with `A` decoration.
Expected (FS-03 S04): FILE_D appears with `D` decoration and strikethrough styling.
Expected (FS-03 S05): `renamed-test.txt` appears with `R` decoration showing the new name.
Expected (FS-02 S12): `staged-test.txt` (staged) and `test-binary.png` (staged) both appear — staged changes are visible in the diff.

Note (FS-03 S02): Untracked files appear in the GitBase list even though `git diff <ref>` does not report them — GitBase discovers them via a separate mechanism (e.g. `git ls-files --others`). This is distinct from git's own SCM panel which tracks only the index.

Note (FS-03 S05): Rename detection requires `diff.renames` not set to `false` (verified in FS-01 S01). If FILE_D and FILE_A appear instead of an R entry, `diff.renames` is disabled — stop and fix before continuing.

Note (FS-02 S12): `git diff <ref> --` compares the working tree (including staged content) to the ref, so staged changes are visible even when the ref is a branch.

---

## Section B: Explorer Badges and Inline Button Checks

### B.1 — File badges in Explorer (`FS-05 S06`)

**Precondition:** M, U, A, D, R entries are visible in the GitBase SCM list.

[User] Switch to the Explorer view in VS Code. Observe the file tree.

Expected: FILES in the diff list show coloured letter badges (M, A, D) matching their SCM status.
Expected: Files that are also modified in git's native SCM view show only git's badge, NOT a duplicate GitBase badge. (The `WORKAROUND_DOUBLE_BADGE` feature prevents stacking under normal conditions.)

Known limitation: `git rm --cached <file>` or staging then reverting to HEAD can produce double badges. These are documented in `docs/bug-vscode-file-decoration-badge-stacking.md` and are not tested here.

### B.2 — Inline button isolation: unstaged file (`FS-05 S08`)

**Precondition:** FILE_M is modified in the working tree (visible in git's Changes group) and appears in the GitBase diff list.

[User] Hover over FILE_M's row in the **GitBase Changes** panel (not the git SCM panel).

Expected: Only the GitBase `$(go-to-file)` inline icon appears. Git's Stage and Discard buttons do NOT appear in the GitBase row.

Note: `WORKAROUND_URI_FRAGMENT=true` gives each GitBase resource state a `#gitbase` URI fragment, producing a distinct cache key that prevents the git extension from injecting its own buttons into GitBase rows.

### B.3 — Inline button isolation: staged file (`FS-05 S08b`)

**Precondition:** `staged-test.txt` is staged (visible in git's Staged Changes group with an Unstage button) and also appears in the GitBase diff list.

[User] Hover over `staged-test.txt`'s row in the **GitBase Changes** panel.

Expected: Only the GitBase `$(go-to-file)` inline icon appears. The git Unstage button does NOT bleed into the GitBase row.

Note: Without the `#gitbase` fragment workaround, the Unstage button from the Staged Changes group would contaminate GitBase's row because git's button cache is keyed by URI regardless of which SCM group owns the resource.

---

## Section C: File Action Tests

**Precondition:** All file states from Section A are present. Base is `Branch · origin/main`.

### C.1 — Click M file: diff editor opens (`FS-04 S01`)

[User] Click FILE_M in the GitBase Changes panel.

Expected: A diff editor opens with the base version of FILE_M on the left side and the working-tree version on the right.
Expected: The editor tab title reads `FILE_M (since Branch · origin/main)`.

### C.2 — Inline icon on M file: working file opens (`FS-04 S02`)

[User] Hover FILE_M in the GitBase panel → click the `$(go-to-file)` inline icon.

Expected: The working-tree file opens (not a diff editor).

Note: M files use `vscode.open` directly; `scm.autoReveal` behaviour applies but is harmless for M files since they already appear in git's SCM panel.

### C.3 — Click U file: working file opens without git panel expansion (`FS-04 S03`)

[Claude] Locate and read the VS Code global user settings file to record the current value of `scm.autoReveal`:
```
code --locate-user-data-dir
```
Then read `<data-dir>/User/settings.json`. Note whether `scm.autoReveal` is absent, `true`, or `false`.

[User] Click `untracked-test.txt` in the GitBase Changes panel.

Expected: The file `untracked-test.txt` opens directly (no diff).
Expected: The git SCM panel does NOT expand to reveal the file and does NOT steal focus from the GitBase panel.

[Check] Re-read `<data-dir>/User/settings.json`.

- **If `scm.autoReveal` was absent before the test:** Expected: the key is still absent. `openWithoutAutoReveal` uses `inspect()` to detect no explicit value and removes the key rather than writing `true`, so no spurious entry appears.
- **If `scm.autoReveal` was explicitly `true` before the test:** Expected: `"scm.autoReveal": true` is still present. The `finally` block restores it by calling `update(true)`, not by deleting the key.

Note: `openWithoutAutoReveal` in `workarounds.ts` temporarily sets `scm.autoReveal = false` globally, then restores the original value in a `finally` block using `inspect()` to distinguish "absent" from "explicitly true".

### C.4 — Inline icon on U/A file: fragment-stripping path (`FS-04 S03b`)

[User] Hover `untracked-test.txt` in the GitBase panel → click the `$(go-to-file)` inline icon.

Expected: The file opens directly (no diff).
Expected: The git SCM panel does NOT expand.

Note: The inline/context menu path invokes `taskChanges.openFile(resource)` where `resource.resourceUri` carries a `#gitbase` fragment. `extension.ts:98` strips the fragment with `.with({ fragment: '' })` before opening. The row-click path (`taskChanges.openUntracked`) receives a plain `workUri` with no fragment. Both paths call `openWithoutAutoReveal` for A/U files, but only the inline path exercises the fragment-stripping code.

### C.5 — A/U file open when `scm.autoReveal` is already `false` (`FS-04 S03c`)

[Claude] Set `scm.autoReveal` to `false` in the VS Code global user settings file:
Read `<data-dir>/User/settings.json`, add `"scm.autoReveal": false`, write back.

[Check] Confirm the setting is present:
Read `<data-dir>/User/settings.json`.
Expected: `"scm.autoReveal": false` is present.

[User] Click `staged-test.txt` (an A file) in the GitBase Changes panel.

Expected: The file opens directly (no diff). Git SCM panel does not expand.

[Check] Re-read `<data-dir>/User/settings.json`.
Expected: `scm.autoReveal` is still `false` and the file was NOT rewritten — the `if (prev !== false)` guard in `openWithoutAutoReveal` skips both the write and the restore when the original value is already `false`.

[Reset] Remove the explicit `scm.autoReveal` setting: edit `<data-dir>/User/settings.json` and remove the `scm.autoReveal` key.

### C.6 — Click binary A file: binary notice (`FS-03 S06`)

[User] Click `test-binary.png` in the GitBase Changes panel.

Expected: An info notification reads `Binary file: test-binary.png — diff not available`.

Note: Binary detection (`parseBinarySet` in `git.ts`) flags the file; `makeState` assigns contextValue `B` (binary), which routes the row-click to `taskChanges.binaryNotice` rather than opening a diff.

### C.7 — Inline icon on binary file: opens normally (`FS-04 S15`)

[User] Hover `test-binary.png` → click the `$(go-to-file)` inline icon.

Expected: The file opens in VS Code's binary viewer (or hex editor). The binary notice is NOT shown.

Note: The inline icon uses `taskChanges.openFile`, which has no binary awareness — it opens the file based on contextValue `A` (since `test-binary.png` is staged), not `B`. The binary notice only affects the row-click path.

### C.8 — Click D file: base-version opens (`FS-04 S04`)

[User] Click FILE_D in the GitBase Changes panel.

Expected: A read-only document opens showing FILE_D's content as it existed at the base ref (`origin/main`). No diff editor — just the historical content.

### C.9 — No inline icon on D file (`FS-04 S09`)

[User] Hover FILE_D in the GitBase Changes panel.

Expected: No `$(go-to-file)` inline icon appears. The `when=` clause on the inline button excludes D files.

### C.10 — Click R file: diff editor with correct old/new paths (`FS-04 S10`)

**Precondition:** `renamed-test.txt` (formerly FILE_R) appears with R decoration. `diff.renames` is not `false` (verified in FS-01 S01).

[User] Click `renamed-test.txt` in the GitBase Changes panel.

Expected: A diff editor opens with FILE_R's content at the base ref on the left and `renamed-test.txt`'s content on the right.
Expected: The tab title reads `renamed-test.txt (since Branch · origin/main)`.

Note: The content provider uses `c.oldPath` (the original name) as the base URI so the correct historical content is shown on the left side.

### C.11 — Copy Path (`FS-04 S05`)

[User] Right-click any file in the GitBase Changes panel → Copy Path.

Expected: The clipboard contains the full absolute path of the file.

### C.12 — Copy Relative Path (`FS-04 S06`)

[User] Right-click any file → Copy Relative Path.

Expected: The clipboard contains the path relative to the repo root.

### C.13 — Copy Changes (Patch) on M file — uses merge-base (`FS-04 S07`)

**Precondition:** Base is `Branch · origin/main`.

[User] Right-click FILE_M → Copy Changes (Patch).

Expected: A notification reads `Patch copied for FILE_M`.

[Check] Verify the patch uses the merge-base, not the branch tip:
```
git diff $(git merge-base HEAD origin/main) -- FILE_M
```
Expected: The output matches the clipboard content. The tip diff (`git diff origin/main -- FILE_M`) may differ or be a superset.

Note: `taskChanges.copyPatch` uses `provider.lastDiffRef`, which holds the merge-base SHA when `baseType` is `Branch`, keeping the patch consistent with the SCM list display.

### C.14 — Copy Patch absent for U file (`FS-04 S08`)

[User] Right-click `untracked-test.txt` in the GitBase panel.

Expected: `Copy Changes (Patch)` is absent from the context menu. The `when=` clause `scmResourceState != U` excludes untracked files.

### C.15 — Copy Patch on D file (`FS-04 S11`)

[User] Right-click FILE_D → Copy Changes (Patch).

Expected: A notification reads `Patch copied for FILE_D`.

[Check] Verify the clipboard contains a valid unified diff with all lines prefixed with `-` (a deletion patch — the file existed at base but not in the working tree).

### C.16 — Copy Patch on A file (`FS-04 S12`)

[User] Right-click `staged-test.txt` → Copy Changes (Patch).

Expected: `Copy Changes (Patch)` is present in the context menu (the `when=` clause is `scmResourceState != U`; staged files are not excluded).
Expected: A notification reads `Patch copied for staged-test.txt`.

[Check] Verify the clipboard contains a valid unified diff with all lines prefixed with `+` (an addition patch — the file did not exist at base). The only `-` line should be the `--- /dev/null` header.

Note: Unlike U (untracked), staged new files (A) are tracked in the index and produce a diff against the base ref.

### C.17 — Copy Patch race-window: no-change result (`FS-04 S13`)

**Precondition:** FILE_M appears as M in the SCM list. Base is `Branch · origin/main`.

[Claude] Revert FILE_M to match the base ref WITHOUT triggering an immediate GitBase refresh (the auto-refresh fires after ~400ms):
```
git checkout origin/main -- FILE_M
```
Act quickly — the next user step must happen before the GitBase panel refreshes.

[User] Immediately right-click FILE_M (still listed as M) → Copy Changes (Patch).

Expected: A notification reads `No changes to copy for FILE_M` (the patch is empty because the file now matches the base).

Note: This is a transient race-window edge case. The GitBase list will self-correct on the next ~400ms auto-refresh, removing FILE_M. The test verifies that the extension handles an empty patch gracefully.

[Reset] Re-apply the modification to FILE_M so it appears as M again:
```
echo "# test modification" >> FILE_M
```

### C.18 — Content provider fallback when base file is deleted (`FS-04 S14`)

**Precondition:** Base is `Branch · origin/main`. At least one M file is present. (We will use a specific tracked file for this destructive operation.)

[Claude] Identify the file to use — it must be tracked on both HEAD and origin/main:
```bash
git diff $(git merge-base HEAD origin/main) HEAD --name-only | head -1
```
Call this FILE_FALLBACK. Delete it from `origin/main` by switching branches, committing, and pushing:
```bash
git checkout main
git rm FILE_FALLBACK
git commit -m "delete FILE_FALLBACK from base for FS-04 S14 test"
git push origin main
git checkout feature/alpha
```
Then fetch in the test repo:
```bash
git fetch origin
```

Note: FILE_FALLBACK still exists on `feature/alpha` with its modified content, so the diff (computed against the merge-base, which predates the deletion on `main`) still shows it as M. The content provider, however, fetches left-side content via `git show origin/main:<file>`, which now exits non-zero because `origin/main` deleted the file — triggering the fallback placeholder on the left side of the diff editor.

[User] Click FILE_FALLBACK in the GitBase Changes panel.

Expected: The diff editor opens. The **left side** shows the text `(file did not exist at origin/main)` — `git show origin/main:FILE_FALLBACK` exits non-zero; the content provider substitutes the fallback string.
Expected: The **right side** shows the current working-tree content of FILE_FALLBACK normally.

[Check] Confirm `git show` exits non-zero:
```
git show origin/main:FILE_FALLBACK
```
Expected: exit code non-zero, output is an error message.

Note: For SHA-based refs (e.g. a merge-base SHA), the fallback reads `(file did not exist at <8-char-sha>)`; for named refs it shows the full ref name.

[Reset] Restore FILE_FALLBACK on origin/main:
```
git checkout main
git revert HEAD --no-edit
git push origin main
git checkout feature/alpha
git fetch origin
```

---

## Section D: Picker Selection and Label Verification

**Purpose:** Verify every picker item selects the correct base ref, updates the SCM label correctly, and stores the right value in workspaceState. Label format verification (FS-05 S01–S03) is embedded into each selection rather than repeated separately.

**Precondition:** Base is `Branch · origin/main`. Working tree has FILE_M modified (M) so there is something visible in the SCM list to confirm the diff is updating.

### D.1 — Default branch shortcut (`FS-02 S01` + `FS-05 S01`)

[User] Open the picker → select `Default branch`.

Expected label: `Branch · origin/main`

[Check] Verify workspaceState (read from the extension's stored key via VS Code developer tools or extension output, or simply accept the label as confirmation for this check):
The stored ref should be `origin/main`.

### D.2 — Select remote branch; verify Branch picker grouping (`FS-02 S02` + `FS-02 S10` + `FS-05 S01`)

[User] Open the picker → select `Branch…`. Before selecting any branch, observe the list layout.

Expected (FS-02 S10): Remote branches appear under an `Upstream` separator. Local branches appear under a `Local` separator. `origin/HEAD` is NOT listed in the branch picker (excluded by `--exclude=refs/remotes/*/HEAD`).

[User] Select `origin/feature/alpha` from the Upstream group.

Expected label: `Branch · origin/feature/alpha`

[Check] Verify the stored ref is `origin/feature/alpha` and type is `Branch`.

### D.3 — Select local branch; verify merge-base usage (`FS-02 S03`)

[User] Open the picker → Branch… → select `feature/beta` (under the Local separator).

Expected label: `Branch · feature/beta`

[Check] Verify merge-base is applied:
```
git diff $(git merge-base HEAD feature/beta) HEAD --name-only
```
Expected: The files listed match the files shown in the GitBase SCM list.

[Check] Verify the tip diff is a superset of the merge-base diff — confirming the test is meaningful:
```
git diff feature/beta HEAD --name-only
```
Expected: The output contains additional files not in the merge-base diff above (at minimum `file-c.txt` and `README.md`, which are in `feature/beta` but not in `feature/alpha`). If the two diffs produce identical output, the topology is wrong and the merge-base distinction cannot be observed.

Note: Branch-type bases always use the merge-base (`getMergeBase` in `git.ts`), not the branch tip. This is what makes GitBase show "your work since the fork point" rather than "everything different from the tip".

### D.4 — Select tag; verify SHA freeze (`FS-02 S04` + `FS-05 S02`)

[User] Open the picker → Tag… → select `v1.0`.

Expected label: `Tag · v1.0`

[Check] Verify the stored ref is the tag's full commit SHA (frozen, not the symbolic name `v1.0`):
```
git rev-parse v1.0
```
The stored value should equal this SHA.

### D.5 — Tag base shows full diff, not merge-base (`FS-03 S08`)

**Precondition:** Base is now `Tag · v1.0` from D.4.

[User] Observe the SCM list.

Expected: All changes since the exact tag `v1.0` appear — including commits from other branches if HEAD has them merged. This is the full diff, not a merge-base diff.

[Check] Verify the diff ref equals the tag SHA, not a merge-base SHA:
```
git rev-parse v1.0
git merge-base HEAD v1.0
```
The two SHAs will typically differ (unless HEAD is directly descended from v1.0 with no divergence). The GitBase diff should use the tag SHA directly.

### D.6 — Select commit from picker; verify footer text (`FS-02 S05` + `FS-05 S03`)

[User] Open the picker → Commit….

Expected: A greyed footer item at the bottom of the commit list reads `Showing 50 most recent — use Enter ref… to set an older commit`.

[User] Select any commit from the list by its subject line.

Expected label: `Commit · <subject of the selected commit>`

[Check] Verify the stored ref is the full 40-character SHA of the selected commit.

### D.7 — Enter ref: branch name (`FS-02 S06`)

[User] Open the picker → Enter ref… → type `feature/alpha` → confirm.

Expected label: `Branch · feature/alpha`

[Check] Verify the stored ref is the symbolic name `feature/alpha` (not a SHA). `detectRefType` resolves `refs/heads/feature/alpha` → `Branch`; symbolic refs are stored as-is.

### D.8 — Enter ref: SHA (`FS-02 S07`)

[Claude] Print the SHA one commit before HEAD:
```
git rev-parse HEAD~1
```
Note this SHA.

[User] Open the picker → Enter ref… → paste the SHA Claude just printed → confirm.

Expected label: `Commit · <subject of HEAD~1>` — Enter ref… resolves the commit subject when given a SHA, matching the behaviour of the Commit picker.

[Check] Verify the stored ref equals the pasted SHA (full 40 characters).

### D.9 — Enter ref: tag name frozen to SHA (`FS-02 S07b`)

**Precondition:** Tag `v1.0` exists.

[User] Open the picker → Enter ref… → type `v1.0` → confirm.

Expected label: `Tag · v1.0`

[Check] Verify the stored ref is the **resolved SHA**, NOT the symbolic name `v1.0`:
```
git rev-parse v1.0
```
The stored value should equal this SHA. This matches the behaviour of the Tag… picker — both freeze the base to the resolved SHA.

Note: If the tag is later deleted, the SHA remains reachable (as long as the commit is not garbage-collected), keeping the base valid.

### D.10 — Enter ref: invalid name (`FS-02 S08`)

[User] Open the picker → Enter ref… → type `nonexistent-ref` → confirm.

Expected: An error notification reads `GitBase: "nonexistent-ref" is not a valid Git ref.`

[Check] Verify the stored base is unchanged from the previous value.

### D.11 — Cancel picker (`FS-02 S09`)

[User] Open the picker → press Escape.

Expected: No change to the label or stored base. No notification.

### D.12 — Select annotated tag (`FS-02 S11`)

[Claude] Create an annotated tag:
```
git tag -a v2.0 -m "release v2.0" HEAD
```

[User] Open the picker → Tag… → select `v2.0`.

Expected label: `Tag · v2.0`

[Check] Verify the stored ref is the **tag-object SHA** (`git rev-parse v2.0`), NOT the commit SHA (`git rev-parse v2.0^{}`):
```
git rev-parse v2.0
git rev-parse v2.0^{}
```
The two SHAs will differ for an annotated tag. The stored value should equal the first (tag-object SHA).

Note: `git diff <tag-object-sha>` dereferences annotated tags automatically, so no special handling is needed in the diff logic.

### D.13 — Enter ref: remote branch classified as Branch (`FS-02 S13`)

[User] Open the picker → Enter ref… → type `origin/feature/alpha` → confirm.

Expected label: `Branch · origin/feature/alpha`

[Check] Verify the stored ref is `origin/feature/alpha` and the stored type is `Branch`.

[Check] Verify merge-base logic applies — the SCM list must match the merge-base diff, not a direct diff to the branch tip:
```bash
git merge-base HEAD origin/feature/alpha
git diff $(git merge-base HEAD origin/feature/alpha) --name-only
```
Expected: The file list from the command matches the files shown in the GitBase SCM list, confirming the Branch path (merge-base diff) is taken rather than the Commit path (direct SHA diff).

Note: `detectRefType` checks `refs/remotes/<ref>` after `refs/heads/` and `refs/tags/`, so remote branch names are correctly classified as `Branch` rather than falling through to `Commit`.

---

## Section E: Diff Correctness

### E.1 — Merge-base correctness (`FS-03 S07`)

**Precondition:** Working branch is `feature/alpha`, which has diverged from `main` with commits on both sides.

[User] Open the picker → Branch… → select `origin/main`.

Expected: The SCM list shows only files changed by commits on `feature/alpha` since the fork point — not changes from `main` that diverged after the fork.

[Check] Verify the diff is against the merge-base, not the branch tip:
```
git diff $(git merge-base HEAD origin/main) HEAD --name-only
```
Expected: The listed files match the GitBase SCM list.

### E.2 — Empty diff with panel staying visible (`FS-03 S09`)

[Claude] Print the current HEAD SHA:
```
git rev-parse HEAD
```
Note this SHA.

[User] Open the picker → Enter ref… → paste the SHA Claude just printed → confirm.

Expected: The SCM list is empty (no files listed — HEAD equals the base, so there are no changes).
Expected: The GitBase Changes SCM panel **remains visible** with its label (e.g. `Commit · <sha>`) — it does NOT collapse, disappear, or show "No source control providers".

Note: `hideWhenEmpty = false` in `provider.ts` keeps the panel present even when the diff is empty. If this were ever changed to `true`, an empty diff would make the panel vanish entirely.

[User] Open the picker → select `Default branch` to restore base to `origin/main`.

### E.3 — Auto-refresh after file change (`FS-03 S10`)

**Precondition:** Base is `Branch · origin/main`. Working tree is clean (or has few files in the list).

[Claude] Modify a tracked file from outside VS Code (simulating an external change):
```
echo "# external edit" >> FILE_M
```

[User] Observe the GitBase SCM list without doing anything in VS Code.

Expected: Within approximately 500ms, FILE_M appears in (or updates in) the SCM list automatically. No manual refresh is needed.

[Claude] Revert the external edit to restore a clean working tree for the next step:
```
git checkout -- FILE_M
```

### E.4 — Timestamp-only change is suppressed (`FS-03 S11`)

**Precondition:** All working-tree files match their committed content (established by the cleanup above).

[Claude] Touch a tracked file to update its mtime without changing its content:
```
git update-index --refresh -q
touch FILE_M
```

[User] Observe the GitBase SCM list.

Expected: FILE_M does NOT appear in the list. Timestamp-only changes are suppressed by `git update-index --refresh -q`, which runs before every diff in `provider.ts`.

### E.5 — Branch tip cache invalidates when base branch advances (`FS-03 S13`)

**Precondition:** Base is `Branch · origin/main`. A diff editor is open on a tracked M file showing base content on the left side.

[User] Open a diff for FILE_M by clicking it in the GitBase panel (if not already open). Observe the left side — it shows the `origin/main` version of FILE_M.

[Claude] Advance `origin/main` by committing on `main` and pushing. We are on `feature/alpha`, so switch branches first:
```bash
git checkout main
git commit --allow-empty -m "advance base for cache invalidation test"
git push origin main
git checkout feature/alpha
```
Then fetch in the test repo so the new commit is visible:
```bash
git fetch origin
```

[User] Trigger a refresh: click the `$(refresh)` button in the GitBase SCM panel title bar, or wait for the auto-refresh to fire.

Expected: The left side of the already-open diff editor reloads and reflects the new `origin/main` content. The `checkBranchTip` function detected that the branch tip SHA changed, invalidated the `branchCaches` entry, and the `basegit:` URI was re-fetched.

---

## Section F: Refresh and Workaround Side Effects

### F.1 — Refresh command from SCM title bar (`FS-05 S07`)

[Claude] Modify FILE_M externally (outside VS Code):
```
echo "# refresh test" >> FILE_M
```

[User] Click the `$(refresh)` button in the GitBase SCM panel title bar.

Expected: The SCM list updates to show FILE_M with M decoration (or updates its position if it was already there).

### F.2 — Git panel button flicker after GitBase refresh (`FS-05 S10`)

**Precondition:** Both the native git SCM panel and the GitBase Changes panel are visible. At least one file is staged in the git panel (git's Stage button is visible on hover).

[Claude] Trigger a GitBase refresh by modifying a file externally:
```
echo "# flicker test" >> FILE_M
```

[User] Immediately hover a file in the **git SCM panel** (not the GitBase panel) and observe the inline buttons.

Expected: Git's inline Stage/Discard buttons may disappear briefly from the git panel row immediately after the refresh, then reappear on the next hover.
Expected: No permanent loss of git panel functionality — the buttons return without requiring a VS Code reload.

Note: `assertScmContext()` in `workarounds.ts` re-asserts `scmProvider=taskchanges` and `scmResourceGroup=changes` after every GitBase refresh (Workaround C). This temporarily evicts VS Code's context keys for the git panel, causing the transient button disappearance. The behaviour is documented in `docs/bug-vscode-scm-button-cache-contamination.md`. Setting `WORKAROUND_STALE_SCM_CONTEXT = false` reproduces the baseline without this mitigation.

---

## Teardown

[Claude] Clean up all working-tree changes created during this plan:
```
git checkout -- FILE_M
git checkout -- renamed-test.txt 2>/dev/null || true
rm -f untracked-test.txt staged-test.txt test-binary.png
git restore --staged staged-test.txt test-binary.png 2>/dev/null || true
git restore FILE_D 2>/dev/null || true
git restore FILE_R 2>/dev/null || true
git mv renamed-test.txt FILE_R 2>/dev/null || true
git restore --staged . 2>/dev/null || true
git checkout .
git clean -fd
```

[Claude] Remove the temporary annotated tag:
```
git tag -d v2.0 2>/dev/null || true
```

[Claude] Restore base to `origin/main`:
Set workspaceState base key to `origin/main`. (In practice, open picker → Default branch.)

[User] Open the picker → Default branch.
Expected label: `Branch · origin/main`

The repo is now in a clean state for the next combined test plan.
