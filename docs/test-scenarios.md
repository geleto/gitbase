# GitBase Test Scenarios

## How to Use This Document

This document defines **feature sets** — logical groupings of gitbase functionality. Each feature set is intended to be turned into a standalone **test prompt**: a markdown file in `docs/test-prompts/` that you open in a Claude Code session. Claude will then guide you interactively through every scenario in that feature set.

### Structure of a test prompt

Each generated prompt will contain:

1. **Prerequisites** — what must already exist (test repo, extension built, VS Code open on the repo)
2. **Setup** — git commands Claude runs to put the repo in the required state for this feature set
3. **Scenarios** — ordered list of test cases, each with:
   - **Precondition** — specific state required before this scenario
   - **User steps** — what the user clicks/types in VS Code (Claude cannot do this)
   - **Expected** — what the user should see (labels, messages, UI state)
   - **Claude verifies** — git commands Claude runs to confirm repo state
   - **Reset** — how to return to a clean state for the next scenario
4. **Teardown** — how to leave the repo clean for the next feature set

### Step notation

- `[Claude]` — Claude runs a shell/git command in the terminal
- `[User]` — user performs a VS Code UI action (click, keyboard shortcut, picker selection) and reports what they see
- `[Check]` — Claude runs a verification command and compares output to the expected value
- `[Reset]` — steps to restore baseline state before the next scenario

> **Hard rule: Claude cannot interact with the VS Code UI.**
> Claude has no access to the editor, SCM panel, picker, notifications, Explorer, or any other VS Code interface.
> Every click, menu selection, keyboard shortcut, and visual observation is a `[User]` step.
> Every git command, file system operation, and workspaceState inspection is a `[Claude]` step.
> A `[Claude]` step must never say "open picker", "click", "reload window", "add folder", or any other UI action.

### Dependencies

Some feature sets depend on others having run first. The dependency order is:

```
FS-01 (Setup — includes build verification)
  └─ FS-02 (Base Selection)
  └─ FS-03 (Diff Display)
       └─ FS-04 (File Actions)
  └─ FS-05 (SCM Label & Decorations)
  └─ FS-06 (Persistence & Recovery)
  └─ FS-07 (Multi-Repo)
  └─ FS-08 (PR: Base Only)        ← requires GitHub access
       └─ FS-09 (PR: Full Review) ← requires GitHub access
```

FS-03 S12 (unborn repo) and FS-06 S08 (late repo discovery) use a separate scratch repo, not the main test repo.

### GitHub access requirement

FS-08 and FS-09 require a real GitHub repository with at least one open pull request and valid GitHub authentication in VS Code. All other feature sets work with a local bare repository acting as origin — no internet access required.

### Coverage annotations

Each scenario lists the primary code path it exercises in brackets, e.g. `[picker.ts:pickBase]`.

---

## FS-01 · Test Repository Setup

**Purpose:** Create and configure the canonical test repository used by all other feature sets. Run this once; all other feature sets reference it.

**Output:** A local git repo at a user-chosen path with:
- A local bare repo acting as `origin`
- Branches: `main`, `feature/alpha`, `feature/beta`, `old-branch`
- Tags: `v1.0`, `v1.1`
- Multiple commits with meaningful file changes on each branch
- A known-dirty state recipe (a file edit that can be applied and reverted)

### Scenarios

**S01 · Create repo structure**
- [Claude] initialise bare repo and working repo, wire up origin, create branch/tag/commit structure
- [Claude] verify: `git log --oneline --all --graph` matches expected topology
- [Claude] verify rename detection is enabled (required for FS-03 S05 and FS-04 S10): `git config diff.renames` must print `true`, `1`, or be absent (default). If it prints `false` or `0`, run `git config diff.renames true` in the working repo before continuing.
- [User] open the working repo folder in VS Code
- [User] confirm the GitBase Changes panel appears in the SCM view

**S02 · Verify extension activates**
- [User] report the SCM group label shown under GitBase Changes
- Expected: `HEAD · Select a base to begin` (no base auto-detected yet — at this point neither `origin/HEAD` nor a local upstream tracking branch is configured, so all four steps of `detectDefaultBranch` find nothing)
- [Claude] configure `origin/HEAD`: `git remote set-head origin main` and verify `git symbolic-ref refs/remotes/origin/HEAD` prints `refs/remotes/origin/main`
- [User] reload VS Code window, report the new label
- Expected: `Branch · origin/main`
- Note: auto-detection uses `origin/HEAD` directly (step 2 of `detectDefaultBranch` in `git.ts`) and does not require a local upstream tracking branch on the current branch

**S03 · Build extension from source**
- [Claude] run `npm install && npm run compile` in the extension source directory
- Expected: command exits with code 0, no TypeScript errors printed
- [Claude] verify compiled output directory (`out/` or `dist/`) contains `.js` files
- Note: this step validates the TypeScript type system; all type errors in source would be caught here

**S04 · Git extension unavailable — extension disables itself gracefully**
- Precondition: the VS Code built-in `vscode.git` extension is disabled (go to Extensions view → search "Git" → find the built-in "Git" extension → Disable)
- [User] open VS Code on the test repo with the GitBase extension installed
- Expected: error notification `Task Changes: VS Code Git extension not found. Extension disabled.`
- Expected: no GitBase Changes panel appears in the SCM view
- Expected: no crash, no unhandled exceptions
- [User] re-enable the built-in Git extension (`Extensions: Enable` in the command palette or via the Extensions view)
- [User] reload VS Code window
- Expected: GitBase Changes panel reappears normally
- Note: `extension.ts:16-19` calls `vscode.extensions.getExtension('vscode.git')`; if the result is falsy, it shows the error and returns early. All further extension functionality (providers, commands, content providers, decorations) is never registered in this path.

---

## FS-02 · Base Selection

**Purpose:** Verify every picker item selects the correct base ref, updates the SCM label correctly, and stores the right value in workspaceState.

**Depends on:** FS-01

**Covers:** `picker.ts:pickBase`, `provider.ts:selectBase`, `provider.ts:syncLabel`, `git.ts:detectRefType`

### Scenarios

**S01 · Default branch shortcut**
- Precondition: `origin/HEAD` → `origin/main`, extension shows `Branch · origin/main`
- [User] open picker → select `Default branch`
- Expected label: `Branch · origin/main`
- [Claude] verify workspaceState key contains `origin/main`

**S02 · Select a remote branch**
- [User] open picker → Branch… → select `origin/feature/alpha`
- Expected label: `Branch · origin/feature/alpha`
- [Claude] verify stored ref is `origin/feature/alpha` and type is `Branch`

**S03 · Select a local branch**
- [User] open picker → Branch… → select `feature/beta` (local)
- Expected label: `Branch · feature/beta`
- [Claude] verify merge-base is used: `git diff $(git merge-base HEAD feature/beta) HEAD --name-only` must match the files shown in the SCM list; `git diff feature/beta HEAD --name-only` (tip diff) must differ or be a superset

**S04 · Select a tag**
- [User] open picker → Tag… → select `v1.0`
- Expected label: `Tag · v1.0`
- [Claude] verify stored ref is the tag's full SHA (frozen, not symbolic)

**S05 · Select a commit**
- [User] open picker → Commit… → select a commit by its subject line
- Expected label: `Commit · <subject>`
- [Claude] verify stored ref is the full 40-char SHA
- Note: the Commit picker shows at most the **50 most recent commits** (`git log -50` at `picker.ts:185`). Commits older than position 50 are not listed. To set a base older than 50 commits, the user must use `Enter ref…` and type or paste the SHA directly. See S05b.

**S05b · Select a commit older than the Commit picker depth limit**
- Precondition: a repo with more than 50 commits; identify a commit SHA at position >50 (e.g. `git log --oneline | tail -5` to get the oldest visible commits)
- [Claude] print a SHA at position >50: `git log --format=%H | sed -n '51p'`
- [User] open picker → Commit…
- Expected: the target commit does NOT appear in the list (only the 50 most recent are shown; `picker.ts:185` passes `-50` to `git log`)
- [User] press Escape; then open picker → Enter ref… → paste the SHA
- Expected label: `Commit · <sha>` (detectRefType falls through to `'Commit'` for a SHA)
- [Claude] verify stored ref equals the pasted SHA
- Note: this is the only way to set a base older than the picker depth. The 50-commit limit is a fixed design choice (`picker.ts:185`); there is no pagination or search for older commits.

**S06 · Enter ref — branch name**
- [User] open picker → Enter ref… → type `feature/alpha`
- Expected label: `Branch · feature/alpha` (detectRefType resolves to `Branch`; stored ref is symbolic)
- [Claude] verify stored ref is `feature/alpha` (symbolic, not SHA)

**S07 · Enter ref — SHA**
- [Claude] print a known commit SHA: `git rev-parse HEAD~1`
- [User] open picker → Enter ref… → paste the SHA Claude just printed
- Expected label: `Commit · <sha>` (detectRefType resolves the SHA to `Commit`)
- [Claude] verify stored ref equals the typed SHA

**S07b · Enter ref — tag name (frozen to SHA)**
- Precondition: tag `v1.0` exists in the repo
- [User] open picker → Enter ref… → type `v1.0`
- Expected label: `Tag · v1.0` (`detectRefType` checks `refs/heads/v1.0` first (not found), then `refs/tags/v1.0` (found) → returns `'Tag'`)
- [Claude] verify stored ref is the **resolved SHA**, NOT the symbolic name `v1.0`
- Note: `Enter ref…` and the `Tag…` picker now behave identically for tag names — both freeze the base to the resolved SHA. This means if the tag is later deleted, the SHA remains reachable (as long as the commit is not garbage-collected) and the base stays valid.

**S08 · Enter ref — invalid**
- [User] open picker → Enter ref… → type `nonexistent-ref`
- Expected: error message `Task Changes: "nonexistent-ref" is not a valid Git ref.`
- [Claude] verify stored base unchanged

**S09 · Cancel picker**
- [User] open picker → press Escape
- Expected: no change to label or stored base

**S10 · Upstream/Local grouping in Branch picker**
- [User] open picker → Branch…
- Expected: remote branches appear under `Upstream` separator, local branches under `Local` separator
- Expected: `origin/HEAD` is not listed (excluded by `--exclude=refs/remotes/*/HEAD`)

**S11 · Select an annotated tag**
- [Claude] create an annotated tag: `git tag -a v2.0 -m "release v2.0" HEAD`
- [User] open picker → Tag… → select `v2.0`
- Expected label: `Tag · v2.0`
- [Claude] verify stored ref is the tag-object SHA (`git rev-parse v2.0`), not the commit SHA (`git rev-parse v2.0^{}`)
- Note: `git diff <tag-sha>` dereferences annotated tags automatically; no special handling needed

**S12 · Staged changes appear in diff**
- [Claude] modify a tracked file and stage it: `git add <file>` (do not commit)
- [User] observe SCM list
- Expected: the staged file appears in the GitBase diff list
- Note: `git diff <ref> --` compares the working tree (including staged content) to the ref, so staged changes are visible even when the ref is a branch

**S13 · Enter ref — remote branch name classified as Branch**
- [User] open picker → Enter ref… → type `origin/feature/alpha`
- Expected label: `Branch · origin/feature/alpha`
- [Claude] verify stored ref is `origin/feature/alpha` and stored type is `Branch`
- Expected: merge-base logic applies (same as selecting from the Branch… picker)
- Note: `detectRefType` now checks `refs/remotes/<ref>` after `refs/heads/` and `refs/tags/`, so remote branch names like `origin/feature/alpha` are correctly classified as `'Branch'` rather than falling through to `'Commit'`.

**S14 · Default branch item absent when no default can be detected**
- Precondition: a repo with no `origin/HEAD`, no `origin/main`, no `origin/master`, and no upstream tracking branch (so `detectDefaultBranch` returns `null`)
- [Claude] set up this state: remove `origin/HEAD` (`git remote set-head origin --delete`) and ensure the current branch has no upstream (`git branch --unset-upstream`)
- [User] open picker
- Expected: the `Default branch` item is **not** present in the picker (the conditional at `picker.ts:32` skips it when `detectDefaultBranch` returned `null`)
- Expected: picker shows Branch…, Tag…, Commit…, Enter ref…, and the two GitHub PR items only
- [Reset] restore upstream: `git branch --set-upstream-to=origin/main` and `git remote set-head origin -a`

**S15 · Enter ref — ambiguous name: branch wins over tag when both exist**
- [Claude] create a local branch with the same short name as an existing tag: `git branch v1.0 HEAD` (branch named `v1.0` when tag `v1.0` already exists)
- [User] open picker → Enter ref… → type `v1.0`
- Expected label: `Branch · v1.0` (NOT `Tag · v1.0`)
- Expected stored type: `Branch`
- Note: `detectRefType` checks `refs/heads/v1.0` first (`git.ts:84`). When that succeeds, it returns `'Branch'` immediately without checking `refs/tags/`. This means a branch named `v1.0` silently shadows the tag of the same name. The label says `Branch`, merge-base logic applies (same as selecting a branch), and the diff tracks branch tip movement — none of which is what the user intended if they wanted the tag. The disambiguation precedence (branch before tag) is a fixed code behavior; users who want the tag in an ambiguous repo must use the `Tag…` picker.
- [Reset] `git branch -D v1.0` to remove the ambiguous branch

**S16 · Empty Tag picker behaves like cancel**
- Precondition: a git repo with no tags (e.g. run `git tag -d $(git tag -l)` to delete all tags from the test repo, or use the scratch repo from FS-03 S12 which has none)
- [User] open picker → Tag…
- Expected: an empty quick pick appears with placeholder `Select tag…` and no items
- [User] press Escape (or close the picker)
- Expected: no error message, no notification — behaves identically to cancelling the base picker (the `?.label` optional chain at `picker.ts:182` yields `undefined`; `if (!newRef) return undefined` exits silently)
- Note: the same silent-cancel behavior applies to the Branch picker on an unborn repo (no refs yet) and the Commit picker on a repo with no commits (but those cases are unusual in practice and covered by FS-03 S12). The Tag picker empty case is common: many repos have no tags at all.
- [Reset] restore any deleted tags as needed for subsequent scenarios

---

## FS-03 · Diff Display

**Purpose:** Verify the SCM resource list shows the correct files with correct statuses, and that the merge-base logic is applied correctly for branch-type bases.

**Depends on:** FS-01, FS-02

**Covers:** `provider.ts:run`, `git.ts:parseNameStatus`, `git.ts:parseBinarySet`, `git.ts:getMergeBase`

### Scenarios

**S01 · Modified file appears as M**
- [Claude] edit a tracked file on current branch (no commit)
- [User] observe SCM list
- Expected: file listed with `M` decoration

**S02 · New untracked file appears as U**
- [Claude] create a new file, do not stage it
- Expected: file listed with `U` decoration (untracked)

**S03 · Staged new file appears as A**
- [Claude] create and `git add` a new file
- Expected: file listed with `A` decoration

**S04 · Deleted file appears as D**
- [Claude] `git rm` a tracked file
- Expected: file listed with `D` decoration, strikethrough

**S05 · Renamed file appears as R**
- [Claude] `git mv` a file
- Expected: file listed with `R` decoration showing new name
- Note: git `C` (copy) status is also mapped to `R` by `parseNameStatus`; a copied file produced by similarity detection will likewise appear with `R` decoration
- Note: rename detection in `git diff --name-status` is enabled by default (`diff.renames=true` in modern git). If a user has `diff.renames=false` in their git config, `git mv` would produce `D` + `A` entries instead of `R`. FS-01 S01 verifies this setting before the test suite runs.

**S06 · Binary file shows no diff command**
- [Claude] add a binary file (e.g. a small PNG) and commit it, set base to previous commit
- [User] click the binary file in SCM list
- Expected: info message `Binary file: <name> — diff not available`

**S07 · Merge base correctness**
- Precondition: `feature/alpha` has diverged from `main` with commits on both sides
- [User] set base to `origin/main`
- Expected: only commits from `feature/alpha` side appear, not changes from `main` that diverged after the fork point
- [Claude] verify with `git diff $(git merge-base HEAD origin/main) HEAD --name-only`

**S08 · Tag/commit base shows full diff (no merge base)**
- [User] set base to tag `v1.0`
- Expected: all changes since that exact tag appear, including commits from other branches if HEAD has them
- [Claude] verify diff ref equals the tag SHA, not a merge base

**S09 · Empty diff when HEAD equals base — panel stays visible**
- [Claude] print current HEAD SHA: `git rev-parse HEAD`
- [User] open picker → Enter ref… → paste the SHA Claude just printed
- Expected: SCM list is empty (no changes)
- Expected: the GitBase Changes SCM panel **remains visible** with its label (e.g. `Commit · <sha>`) — it does not collapse, disappear, or show "No source control providers" (`hideWhenEmpty = false` in `provider.ts:41`)
- Note: this behavior is distinct from the list simply being empty; `hideWhenEmpty = false` is the specific provider setting that keeps the panel present. If this setting were ever changed to `true`, an empty diff would make the entire panel vanish.

**S10 · List updates after file save**
- [Claude] modify a file
- Expected: within ~500ms the SCM list updates automatically (no manual refresh needed)

**S11 · Timestamp-only change is suppressed**
- Precondition: all working-tree files match their committed content
- [Claude] open and immediately save a tracked file without changing its content (or use `git add` of an unchanged file)
- Expected: the file does NOT appear in the SCM list
- Note: provider.ts calls `git update-index --refresh -q` before every diff to flush stale stat cache entries, preventing timestamp-only changes from showing as spurious diffs

**S12 · Unborn repository (no commits yet)**
- Precondition: open a freshly initialised git repo (`git init`) with no commits in VS Code
- Expected: SCM label shows `HEAD · Select a base to begin` (auto-detect finds no `origin/HEAD`)
- Expected: no crash occurs; `git diff HEAD` fails silently (`nsOut === null`) so the list stays empty
- [Claude] make the first commit: `echo hello > first.txt && git add first.txt && git commit -m "init"`
- Expected: within ~500ms the SCM list updates (the `repo.state.onDidChange` event fires after the commit, scheduling a refresh)
- [Claude] verify no error notifications appear in VS Code

**S13 · Branch tip cache invalidates when base branch advances**
- Precondition: base set to `origin/main`; diff editor open on a tracked file showing base content on the left side
- [Claude] advance the base branch: `git commit --allow-empty -m "advance base" && git push origin main`
- [Claude] in the test repo: `git fetch origin`
- [User] trigger a refresh (click `$(refresh)` or wait for auto-refresh)
- Expected: the left side of the open diff editor reloads and reflects the new base content (`checkBranchTip` detected the branch tip SHA changed, so `branchCaches` was invalidated and the `basegit:` URI was re-fetched)

---

## FS-04 · File Actions

**Purpose:** Verify the inline and context-menu commands on SCM resource items work correctly.

**Depends on:** FS-03 (requires files in the diff list)

**Covers:** `extension.ts` command registrations, `content.ts:BaseGitContentProvider`

### Scenarios

**S01 · Open diff on modified file**
- Precondition: at least one M file in SCM list
- [User] click the M file in SCM list
- Expected: diff editor opens showing base version on left, working tree on right
- Expected: title is `<filename> (since <base label>)`

**S02 · Open file via inline icon on M file**
- [User] hover M file → click the `$(go-to-file)` inline icon
- Expected: working tree file opens (not diff)
- Note: M files are opened with `vscode.open`, not `openWithoutAutoReveal`; VS Code's normal `scm.autoReveal` behavior applies (the file may be revealed in the git SCM panel if autoReveal is on, but this is harmless for M files since they already appear there)

**S03 · Open untracked/added file**
- Precondition: `scm.autoReveal` is `true` in VS Code global settings (the default; absent means `true`)
- [Claude] locate and read the VS Code global user settings file (`code --locate-user-data-dir` then `User/settings.json`); note the current value of `scm.autoReveal`
- [User] click a U or A file in SCM list
- Expected: working tree file opens directly (no diff)
- Expected: the **git SCM panel does NOT expand** to reveal the file and does NOT steal focus away from GitBase (this is what `scm.autoReveal` controls — it prevents VS Code from searching all SCM providers and revealing the file in the first panel that owns it)
- [Claude] re-read the VS Code user settings file and verify `scm.autoReveal` is restored to its original value; confirm the `finally` block in `openWithoutAutoReveal` did not leave the setting permanently overridden to `false`
- Note: `openWithoutAutoReveal` in `workarounds.ts` temporarily sets `scm.autoReveal = false` globally to prevent VS Code from expanding the native git panel when an A/U file is opened (those files live in git's Changes/Untracked group). The setting is restored in a `finally` block.

**S03b · Open A/U file via inline icon — exercises fragment-stripping code path**
- Precondition: an A or U file in the SCM list
- [User] hover the A or U file → click the `$(go-to-file)` inline icon
- Expected: working tree file opens directly (no diff)
- Expected: the git SCM panel does NOT expand (same autoReveal suppression as row-click)
- Note: the inline/context menu invokes `taskChanges.openFile(resource)` (`extension.ts:93`), NOT `taskChanges.openUntracked`. The key difference: `resource.resourceUri` carries a `#gitbase` fragment (from WORKAROUND_URI_FRAGMENT), and `extension.ts:98` strips it with `.with({ fragment: '' })` before opening. The row-click path (`taskChanges.openUntracked`) receives a plain `workUri` with no fragment from `makeState`. Both paths call `openWithoutAutoReveal` for A/U, but only the inline/context path exercises the fragment-stripping logic.

**S03c · Open untracked/added file when `scm.autoReveal` is already `false`**
- Precondition: `scm.autoReveal` is explicitly set to `false` in VS Code global settings
- [Claude] confirm the setting: read the VS Code user settings file and verify `"scm.autoReveal": false` is present
- [User] click a U or A file in SCM list
- Expected: working tree file opens directly (no diff)
- [Claude] re-read the VS Code user settings file and verify `scm.autoReveal` is still `false` and was not rewritten (the `if (prev !== false)` guard in `openWithoutAutoReveal` skips both the `false` write and the restore write when the original value is already `false`, so `settings.json` is not touched at all)
- [Reset] remove the explicit `scm.autoReveal` setting from VS Code global settings to restore the default (`true`)

**S04 · Open deleted file**
- [User] click a D file in SCM list
- Expected: base-version read-only document opens (the deleted file's content at base)

**S05 · Copy Path**
- [User] right-click a file → Copy Path
- Expected: clipboard contains the full absolute path of the file

**S06 · Copy Relative Path**
- [User] right-click a file → Copy Relative Path
- Expected: clipboard contains the path relative to repo root

**S07 · Copy Changes (Patch)**
- Precondition: base is set to a branch (e.g. `origin/main`)
- [User] right-click an M file → Copy Changes (Patch)
- Expected: notification `Patch copied for <filename>`
- [Claude] verify clipboard content is a valid unified diff for that file
- [Claude] verify the patch is computed against the merge-base, not the branch tip: `git diff $(git merge-base HEAD origin/main) -- <file>` should match the clipboard; `git diff origin/main -- <file>` (tip diff) may differ
- Note: `taskChanges.copyPatch` uses `provider.lastDiffRef`, which holds the merge-base SHA when `baseType` is `Branch` or `PR`, keeping the patch consistent with the SCM list display

**S08 · Copy Patch unavailable for untracked**
- [User] right-click a U file
- Expected: `Copy Changes (Patch)` is absent from the context menu (when=clause excludes U)

**S09 · Open File icon absent for D files**
- [User] hover a D file
- Expected: no `$(go-to-file)` inline icon appears

**S10 · Click renamed (R) file opens correct diff**
- Precondition: an R entry in the SCM list (e.g. from `git mv old.txt new.txt`); requires `diff.renames` not set to `false` (verified in FS-01 S01)
- [User] click the R file in the SCM list
- Expected: diff editor opens with the old filename content on the left (base) and the new filename on the right (working tree)
- Expected: diff title is `new.txt (since <base label>)`
- Note: base URI uses `c.oldPath` (the source name) so the correct historical content is shown on the left

**S11 · Copy Changes (Patch) on deleted file**
- Precondition: a D file in the SCM list
- [User] right-click the D file → Copy Changes (Patch)
- Expected: notification `Patch copied for <filename>`
- [Claude] verify clipboard contains a valid unified diff with all lines prefixed with `-` (deletion patch)

**S12 · Copy Changes (Patch) on added (staged) file**
- Precondition: an A file in the SCM list (create and `git add` a new file)
- [User] right-click the A file → Copy Changes (Patch)
- Expected: `Copy Changes (Patch)` is **present** in the context menu (the `when=` clause is `scmResourceState != U`; A files are not excluded)
- Expected: notification `Patch copied for <filename>`
- [Claude] verify clipboard contains a valid unified diff with all lines prefixed with `+` (addition patch, no `-` lines except the `--- /dev/null` header)
- Note: unlike U (untracked), staged new files (A) are tracked in the index and do produce a diff against the base ref

**S13 · Copy Changes (Patch) when file has no net change**
- Precondition: a file appears as M in the SCM list; revert it to match the base without triggering a refresh: `git checkout <base-ref> -- <file>` (the SCM list has not yet updated)
- [User] right-click the still-listed M file → Copy Changes (Patch) (before the auto-refresh removes it)
- Expected: notification `No changes to copy for <filename>` (the patch is empty; `gitOrNull` returned an empty string for that file)
- Note: this is a transient race-window edge case; the list self-corrects on the next ~400ms refresh

**S14 · Content provider returns empty document when `git show` fails**
- Precondition: base is set to a branch; a file exists in the working tree that does NOT exist at the base ref (e.g. set base to a commit that predates the file's creation, so the file is shown as A in the SCM list but also appears as M because it has been modified since it was added)
- Alternative setup: manually open a `basegit:` URI via the diff editor for a path that never existed at the base ref
- [User] click an M file in the SCM list to open the diff editor
- Expected: left side of diff editor is blank (empty document) — `content.ts` runs `git show <ref>:<path>`, which fails because the path did not exist at that ref; `gitOrNull` returns `null`; the `?? ''` fallback yields an empty string; no error is thrown or shown
- Expected: right side shows the current working-tree content normally
- [Claude] confirm by running `git show <base-ref>:<filepath>` and verifying it exits non-zero
- Note: this is the silent-empty fallback at `content.ts:49` and `content.ts:60`; if this behavior is ever changed to show an error instead, this scenario must be updated

**S15 · Open File via inline icon on a binary A or M file**
- Precondition: a binary file (e.g. a small PNG) appears as M or A in the SCM list (from FS-03 S06 setup or similar)
- [User] hover the binary M or A file → click the `$(go-to-file)` inline icon
- Expected: the working tree file opens normally in VS Code (as a binary viewer or hex editor depending on VS Code's capabilities)
- Expected: the binary notice (`Binary file: <name> — diff not available.`) is NOT shown — the inline icon invokes `taskChanges.openFile` which has no binary awareness; it opens the file based on contextValue alone
- Note: the binary flag only affects the row-click command (`taskChanges.binaryNotice` in `makeState`). The `scm/resourceState/inline` and `scm/resourceState/context` menu entries use `taskChanges.openFile` with a `when` clause of `scmResourceState != D` only — binary files are not excluded. For contextValue M, `taskChanges.openFile` calls `vscode.commands.executeCommand('vscode.open', uri)`; for contextValue A, it calls `openWithoutAutoReveal(uri)`. Neither shows the binary notice.

**Note: Editor tab title label formatter**
The `labels.ts` module registers a `ResourceLabelFormatter` for the `basegit:` URI scheme that would append `(since <base>)` in editor tab titles. This formatter is currently **disabled** (`LABEL_FORMATTER_ENABLED = false`) because it requires a proposed VS Code API (`resolvers`). Tab titles therefore rely on the title string passed directly to `vscode.diff`. No test scenario is needed until the API is stabilised.

---

## FS-05 · SCM Label & Decorations

**Purpose:** Verify the SCM group label formats correctly for each base type, and that file badges appear correctly in the Explorer.

**Depends on:** FS-01

**Covers:** `provider.ts:syncLabel`, `decorations.ts:TaskChangesDecorationProvider`

### Scenarios

**S01 · Branch label format**
- [User] set base to a branch
- Expected SCM label: `Branch · <branch-name>`

**S02 · Tag label format**
- [User] set base to a tag
- Expected SCM label: `Tag · <tag-name>`

**S03 · Commit label format**
- [User] set base to a commit (by subject)
- Expected SCM label: `Commit · <subject>`

**S04 · PR label format (no type prefix)**
- Precondition: FS-08 completed; a PR base is set
- Expected SCM label: just the PR label with no type prefix (e.g. `GitHub PR #123 · owner/repo · my work vs target`)

**S05 · No base label**
- Precondition: a repo where `detectDefaultBranch` returns `null` — no `origin/HEAD` symref, no `origin/main`, no `origin/master`, no upstream tracking branch on the current branch (e.g. the scratch repo from FS-03 S12, or the test repo after `git remote set-head origin --delete` and `git branch --unset-upstream`)
- [Claude] clear the workspaceState base keys for this repo
- [User] reload VS Code window (`Developer: Reload Window`)
- Expected SCM label: `HEAD · Select a base to begin` (label persists — no auto-detect fires because `detectDefaultBranch` returned `null`)
- Note: in a normal test repo that has `origin/HEAD → origin/main`, clearing workspaceState and reloading will show this label only transiently (~400ms) before `detectDefaultBranch` succeeds and the label snaps to `Branch · origin/main`. To observe the steady-state "no base" label, auto-detection must have nothing to find.

**S06 · File badges in Explorer**
- Precondition: modified, added, and deleted files in diff list
- [User] open Explorer
- Expected: modified files show a coloured letter badge matching their SCM status
- Expected: files that are also dirty in git's own SCM view show only git's badge, not a duplicate from gitbase
- Known limitation — **`git rm --cached` produces a double badge:** `git rm --cached <file>` removes the file from the index while leaving the working tree unchanged. The working tree still matches HEAD, so `git diff HEAD -- <file>` exits 0 — the file is absent from `dirtyPaths`. But the file still appears in GitBase's diff list (index differs from base). Both the git extension and GitBase register decorations under the same plain `file:` URI, resulting in a double badge in the Explorer.
- Known limitation — **stage then revert working tree produces a double badge:** staging a change (`git add`) and then reverting the working tree file to match HEAD (`git checkout HEAD -- <file>`) leaves the index ≠ HEAD but the working tree = HEAD. `git diff HEAD` exits 0, so the file is again absent from `dirtyPaths`, causing the same double-badge outcome as above.
- Note: both edge cases are documented in `docs/bug-vscode-file-decoration-badge-stacking.md`. They are not fixable without a VS Code API for clearing a specific provider's decoration, which does not exist. Set `WORKAROUND_DOUBLE_BADGE = false` to reproduce the base behavior (always registers plain-URI decoration).

**S07 · Refresh command**
- [Claude] modify a file externally (outside VS Code)
- [User] click the `$(refresh)` button in the SCM title bar
- Expected: SCM list updates to include the new change

**S08 · GitBase inline buttons are not contaminated by git panel buttons (unstaged file)**
- Precondition: a file is both modified in the working tree (visible in git's Changes group) and tracked in the GitBase diff list
- [User] hover that file in the GitBase SCM panel
- Expected: only the GitBase `$(go-to-file)` inline icon appears; git's Stage/Discard buttons do NOT bleed into the GitBase row
- Note: WORKAROUND_URI_FRAGMENT=true gives GitBase resource states a `#gitbase` URI fragment, producing a distinct cache key that prevents the git extension from contaminating GitBase's inline button set

**S08b · GitBase inline buttons are not contaminated by Staged Changes group (staged file)**
- Precondition: a file is staged in the git index (`git add <file>`), so it appears in git's Staged Changes group (with an Unstage button) AND in the GitBase diff list
- [User] hover that file in the GitBase SCM panel
- Expected: only the GitBase `$(go-to-file)` inline icon appears; the git Unstage button does NOT bleed into the GitBase row
- Note: staged files appear in git's Staged Changes group under a different resource group, but git's button cache is keyed by URI regardless of group. Without the `#gitbase` fragment workaround, the Unstage button from the Staged Changes group would contaminate GitBase's row. This is the more common contamination case documented in `docs/bug-vscode-scm-button-cache-contamination.md`.

**S09 · workspaceState keys are namespaced by repo root path (multi-folder workspace)**
- Precondition: two different git repos are open as separate folders in the same VS Code window (from FS-07 S01)
- [User] set base to `origin/feature/alpha` in repo A's GitBase panel
- [User] set base to `v1.0` in repo B's GitBase panel
- Expected: repo A's SCM label shows `Branch · origin/feature/alpha`; repo B's shows `Tag · v1.0`
- [Claude] verify the keys differ: `taskChanges.base.<rootA>` ≠ `taskChanges.base.<rootB>` — the root path suffix keeps their state separate within a single workspace
- Note: this scenario tests isolation between two *different* repo paths in one window. Two windows open on the *same* folder share the same workspaceState storage key — last writer wins; see FS-06 S07.

**S10 · Workaround C side-effect — git panel buttons flicker after GitBase refresh**
- Precondition: both the native git SCM panel and the GitBase Changes panel are visible; a file is staged in the git panel (Stage button visible on hover)
- [Claude] trigger a GitBase refresh by modifying a file externally
- [User] immediately hover a file in the git SCM panel
- Expected: git's inline Stage/Discard buttons may disappear briefly from the git panel row immediately after the refresh, then reappear on the next hover
- Expected: no permanent loss of git panel functionality; the buttons return without reloading VS Code
- Note: `assertScmContext()` re-asserts `scmProvider=taskchanges` and `scmResourceGroup=changes` after every GitBase refresh (Workaround C in `workarounds.ts`). This temporarily evicts VS Code's context keys for the git panel. The known side-effect is documented in `docs/bug-vscode-scm-button-cache-contamination.md`. Set `WORKAROUND_STALE_SCM_CONTEXT = false` to reproduce without the secondary mitigation.

---

## FS-06 · Persistence & Base Recovery

**Purpose:** Verify the selected base survives VS Code restarts, and that the extension handles a missing or deleted base ref gracefully.

**Depends on:** FS-01

**Covers:** `provider.ts` constructor workspaceState restore, `provider.ts:run` validation, `git.ts:detectDefaultBranch`

### Scenarios

**S01 · Base survives reload**
- [User] set base to `origin/feature/alpha`
- [User] reload VS Code window (`Developer: Reload Window`)
- Expected: label still shows `Branch · origin/feature/alpha` after reload without re-selecting

**S02 · Label survives reload**
- [User] set base to a commit (note the label shown)
- [User] reload VS Code window
- Expected: same commit label shown (not just the SHA)

**S03 · Deleted branch triggers warning**
- [Claude] `git branch -D feature/beta` and `git push origin --delete feature/beta`
- Precondition: stored base is `feature/beta`
- Expected: warning notification `GitBase: base ref "feature/beta" no longer exists. Select a new base to continue.`
- Expected: `Select Base` button in the notification
- Note: the warning notification and the auto-recovery (S04) are triggered in the same `run()` call without awaiting one another — they execute concurrently. Both effects are observable from a single extension refresh; S04 does not require a separate user action.

**S04 · Auto-recovery after deleted base**
- Precondition: S03 completed (warning already shown; auto-recovery runs concurrently with it)
- Expected: extension auto-recovers to `origin/main` (default branch) without user action
- Expected: SCM label updates to `Branch · origin/main`
- [Claude] verify stored base key updated to `origin/main`

**S04b · Auto-recovery fails when no default branch can be detected**
- Precondition: stored base is a branch that has been deleted (as in S03); additionally, no default branch is detectable — no `origin/HEAD` symref, no `origin/main`, no `origin/master`, no upstream tracking branch (`detectDefaultBranch` returns `null`)
- [Claude] ensure this state: `git remote set-head origin --delete && git branch --unset-upstream`
- Expected: warning notification `GitBase: base ref "<ref>" no longer exists. Select a new base to continue.`
- Expected: label falls back to `HEAD · Select a base to begin` (base cleared to `undefined`; `autoDetectDone` reset to `false` so auto-detect will retry on next refresh but will again return `null`)
- Expected: `← Exit GitHub PR Review` is NOT shown (PR review state unchanged, only the base ref was affected)
- [Claude] verify stored base key is `undefined` (cleared)
- [Reset] `git remote set-head origin -a && git branch --set-upstream-to=origin/main` to restore the default branch

**S05 · Warning notification action**
- [Claude] re-create the deleted base scenario
- [User] click `Select Base` in the warning notification
- Expected: picker opens

**S05b · Deleted tag triggers same warning and recovery**
- [Claude] set base to tag `v1.0`: open picker → Tag… → `v1.0` (or use Enter ref…)
- [Claude] delete the tag locally and from remote: `git tag -d v1.0 && git push origin --delete refs/tags/v1.0`
- Expected: warning notification `GitBase: base ref "v1.0" no longer exists. Select a new base to continue.`
- Expected: extension auto-recovers to `origin/main`; SCM label updates to `Branch · origin/main`
- [Claude] verify stored base key updated to `origin/main`
- Note: the validation at `provider.ts:106` runs `git rev-parse --verify <ref>` regardless of ref type; a deleted tag is caught by the same path as a deleted branch

**S05c · Orphaned commit SHA triggers same warning (no auto-recovery)**
- [Claude] set base to a commit SHA that will become unreachable: create a temporary commit on a detached HEAD, note its SHA, then `git reset --hard` away from it so it is only in the reflog
- [Claude] wait for the reflog to expire or force-expire: `git reflog expire --expire=now --all && git gc --prune=now`
- Expected: warning notification `GitBase: base ref "<sha>" no longer exists. Select a new base to continue.`
- Expected: extension attempts `detectDefaultBranch` and auto-recovers to `origin/main` if found; SCM label updates
- [Claude] verify stored base key is either updated to `origin/main` or cleared to `undefined`
- Note: orphaned SHAs are pruned by garbage collection; the recovery path is identical to deleted branches

**S06 · Auto-detect default branch on first open**
- [Claude] clear the workspaceState base keys for this repo
- [User] reload VS Code window (`Developer: Reload Window`)
- Expected: extension auto-detects `origin/main` within a few seconds
- Expected: SCM label updates from `HEAD · Select a base to begin` to `Branch · origin/main`

**S07 · Same repo in two windows — last-writer-wins on reload**
- [User] open the same test repo in two separate VS Code windows (window A and window B)
- [User] set base to `origin/feature/alpha` in window A; confirm label shows `Branch · origin/feature/alpha`
- [User] set base to `v1.0` in window B; confirm label shows `Tag · v1.0`
- Expected (while both windows remain open): each window's in-memory state reflects its own last selection — window A shows `Branch · origin/feature/alpha`, window B shows `Tag · v1.0`
- [User] reload window A (`Developer: Reload Window`)
- Expected: window A now shows `Tag · v1.0` (window B's write was the last one persisted to the shared storage key `taskChanges.base.<root>`)
- Note: two VS Code windows on the same folder share the same workspaceState storage. The last window to write wins on reload. This is the intended (and only possible) behaviour given the storage architecture; the in-memory label divergence is visible only until the next reload.

**S08 · Late repo discovery — second repo added while extension is active**
- Precondition: the extension is already active (the primary test repo is open); a second git repo exists on disk (initialised in FS-07 S01 or equivalent)
- [Claude] print the path of the second repo
- [User] add the second repo folder via `File → Add Folder to Workspace`
- Expected: a second GitBase Changes panel appears without restarting VS Code
- Note: exercises `api.onDidOpenRepository` (`extension.ts:48`), which fires for each repository the git extension opens after our listener is registered. The extension's only activation event is `workspaceContains:.git`, so it is dormant in a completely empty workspace — adding the very first folder to an empty workspace does not exercise this path because the extension has not yet activated. The correct precondition is an already-active session. The `api.onDidChangeState` path (`extension.ts:52-54`) is a separate activation-ordering concern and is not exercised here.

**S09 · Auto-detect falls back to common branch name when origin/HEAD is absent**
- Precondition: a repo where `origin/HEAD` symref has not been set (e.g. `git remote set-head origin --delete`); `origin/master` exists but `origin/main` does not
- [Claude] remove origin/HEAD: `git remote set-head origin --delete`
- [Claude] clear the workspaceState base keys for this repo
- [User] reload VS Code window (`Developer: Reload Window`)
- Expected: extension auto-detects `origin/master` (step 3 of `detectDefaultBranch` in `git.ts` tries `origin/main` then `origin/master` by name)
- Expected: SCM label updates to `Branch · origin/master`
- [Reset] `git remote set-head origin -a` to restore origin/HEAD

**S10 · Auto-detect falls back to upstream tracking branch (no origin/HEAD, no common names)**
- Precondition: a repo whose current branch tracks a remote branch with a non-standard name (e.g. `origin/develop`); no `origin/HEAD` symref; neither `origin/main` nor `origin/master` exist
- [Claude] clear the workspaceState base keys for this repo
- [User] reload VS Code window (`Developer: Reload Window`)
- Expected: extension auto-detects the upstream tracking branch (step 4 of `detectDefaultBranch` — `git rev-parse --abbrev-ref HEAD@{upstream}`)
- Expected: SCM label updates to `Branch · origin/develop` (or whichever tracking branch is configured)

**S11 · Auto-detect uses non-origin remote's symbolic HEAD (step 1 of detectDefaultBranch)**
- Precondition: a repo where the current branch tracks a remote named something other than `origin` (e.g. `upstream`) and that remote has a symbolic HEAD configured; `origin` is either absent or lacks a usable HEAD
- [Claude] set up this state:
  ```
  git remote add upstream <some-bare-repo-url>
  git fetch upstream
  git remote set-head upstream -a          # configure upstream/HEAD → upstream/main
  git branch --set-upstream-to=upstream/main
  git remote set-head origin --delete       # ensure origin/HEAD is absent so step 2 does not fire
  ```
- [Claude] verify: `git symbolic-ref --short refs/remotes/upstream/HEAD` prints `upstream/main`
- [Claude] clear the workspaceState base keys for this repo
- [User] reload VS Code window (`Developer: Reload Window`)
- Expected: extension auto-detects `upstream/main` (step 1 of `detectDefaultBranch` — the current branch's upstream remote is `upstream`; `refs/remotes/upstream/HEAD` symref resolves to `upstream/main`; that ref exists; step 1 returns immediately without reaching steps 2-4)
- Expected: SCM label updates to `Branch · upstream/main`
- [Reset] remove the `upstream` remote and restore origin/HEAD: `git remote remove upstream && git branch --set-upstream-to=origin/main && git remote set-head origin -a`
- Note: step 1 fires only when there is a tracking branch AND the remote named by that branch has a symbolic HEAD that resolves. This is the highest-priority detection path. Step 2 (origin/HEAD directly) is only reached when either there is no tracking branch, or the tracking remote is named `origin` and step 1 already set `triedOriginHead = true` (in which case step 2 is skipped to avoid a duplicate check).

---

## FS-07 · Multi-Repo

**Purpose:** Verify the extension correctly handles multiple repositories open in the same VS Code workspace.

**Depends on:** FS-01

**Covers:** `extension.ts` provider map, `resolveProvider`, `resolveProviderForResource`

### Scenarios

**S01 · Both repos appear in SCM view**
- [Claude] initialise a second test git repo at a separate path outside the primary repo (e.g. a sibling directory); create a file, stage it, and make an initial commit
- [Claude] print the path of the second repo so the user can add it
- [User] add the second repo via `File → Add Folder to Workspace…` and select the path Claude printed
- Expected: two separate GitBase Changes panels appear in the SCM view, one per repo

**S02 · Select Base from SCM title bar targets correct repo**
- [User] click `$(git-branch)` on repo A's panel
- Expected: picker opens and changes only repo A's base; repo B's base unchanged

**S03 · Command palette prompts for repo selection when multiple repos are open**
- Precondition: exactly two repos in the workspace (from S01)
- [User] open command palette → `Task Changes: Select Base…`
- Expected: a quick pick appears listing both repo folder names; user must pick one before the base picker opens
- Note: with exactly one repo open, the command palette skips the repo picker and acts on that repo directly (`providers.size === 1` path in `resolveProvider`)

**S03b · Cancel the repo picker — silent no-op**
- Precondition: two repos in the workspace (repo picker is shown)
- [User] open command palette → `Task Changes: Select Base…`
- [User] press Escape when the repo quick pick appears
- Expected: nothing happens — no base picker opens, no error, no notification (`picked?.provider` is `undefined`; `resolveProvider` returns `undefined`; the optional chain `?.selectBase()` short-circuits)
- Note: cancelling the repo picker has identical user-visible behavior to cancelling the base picker itself (FS-02 S09). The same silent no-op applies to `Task Changes: Refresh` when the repo picker is cancelled.

**S03c · Duplicate repo basenames — description disambiguates in picker**
- Precondition: two repos whose folder names are identical (e.g. both are named `app`) — e.g. `~/client/app` and `~/server/app`
- [Claude] initialise a second repo at a path with the same basename as the primary repo; print the path
- [User] add it via `File → Add Folder to Workspace…`
- [User] open command palette → `Task Changes: Select Base…`
- Expected: both repos appear in the quick pick with the same `label` (`app`); they are distinguished only by the `description` field which shows the full absolute path (`extension.ts:70`)
- Expected: selecting either entry opens the correct base picker for that specific repo
- Note: VS Code renders `description` in a lighter color next to the label. When basenames collide, users must read the full path in the description to choose the correct repo. This is a display-only limitation — selection accuracy is unaffected.

**S04 · Copy Relative Path uses correct repo root**
- [User] right-click a file in repo B's SCM list → Copy Relative Path
- Expected: path is relative to repo B's root, not repo A's

**S05 · Closing a repo removes its panel and clears its badges**
- Precondition: repo B has at least one file in its GitBase diff list so that Explorer badges are visible
- [User] open Explorer and confirm repo B's modified files show GitBase letter badges
- [User] remove repo B from the workspace (`File → Remove Folder from Workspace`)
- Expected: repo B's GitBase Changes panel disappears; repo A's is unaffected
- To verify badge cleanup: immediately re-add repo B to the workspace (`File → Add Folder to Workspace`), then open Explorer and observe that repo B's files have no stale GitBase badges (they are absent or show only git's own badge)
- [User] remove repo B again after verification
- Note: `provider.dispose()` calls `decoProvider.clear(root)` which fires `onDidChangeFileDecorations` for all previously decorated URIs, prompting VS Code to re-query (and find no decoration) for each one. After the folder is removed, those files are no longer visible in Explorer, so the only way to directly observe the cleanup is the brief re-add described above.

**S06 · Refresh command prompts for repo selection when multiple repos are open**
- Precondition: two repos in the workspace (from S01); each has at least one file in its GitBase diff list
- [Claude] modify a file in repo A externally (outside VS Code): `echo change >> <repo-a-path>/tracked-file.txt`
- [User] open command palette → `Task Changes: Refresh`
- Expected: a quick pick appears listing both repo folder names (same repo picker as `Task Changes: Select Base…`)
- [User] select repo A in the picker
- Expected: repo A's SCM list updates to include the changed file; repo B's list is unaffected
- Note: `taskChanges.refresh` calls `resolveProvider(sc)` (`extension.ts:90`). When invoked from the command palette (no `sc` argument), and `providers.size > 1`, it shows the same picker used by `taskChanges.selectBase`. When invoked via the SCM title bar `$(refresh)` button, `sc` is passed and the picker is skipped.

**S07b · Nested repo layout — resource commands resolve against most-specific provider**
- Precondition: two git repos open where one root is a path-prefix of the other — e.g. repo A at `/project` and repo B at `/project/packages/lib`. Both have at least one file in their GitBase diff lists.
- Note: VS Code may not allow adding a subfolder of an already-open workspace folder via File → Add Folder to Workspace. This scenario may require opening VS Code with a multi-root `.code-workspace` file that lists both paths explicitly.
- [User] right-click a file from repo B's GitBase SCM list → Copy Relative Path
- Expected: path is computed relative to **repo B's** root (the most-specific provider wins regardless of insertion order)
- [Claude] verify: the copied path does not start with `packages/lib/` prefix that would indicate resolution against repo A
- Note: `resolveProviderForResource` (`extension.ts`) sorts candidates by root-path length descending before `find()`, so the deepest (most-specific) matching repo always wins. The same correct resolution applies to `Copy Changes (Patch)`. Commands invoked via the SCM title bar (`sc` argument passed) bypass this path entirely since they resolve by SCM object identity.

**S07 · Commands silently no-op when no repos are open**
- Precondition: the extension is active (was activated with at least one repo) but all repos have been removed from the workspace (so `providers.size === 0`); this state is reached after performing FS-07 S05 and S06 and removing repo A as well
- [User] open command palette → `Task Changes: Select Base…`
- Expected: nothing happens — no picker, no error, no notification (the command handler calls `(await resolveProvider())?.selectBase()`; `resolveProvider` returns `undefined` when `providers.size === 0`; the optional chain short-circuits)
- [User] open command palette → `Task Changes: Refresh`
- Expected: same — silent no-op
- Note: `extension.ts:67` explicitly handles `providers.size === 0` with `return undefined`. Both commands use optional chaining on the result, so a missing provider is a deliberate silent no-op, not an error. This state is reachable because the extension does not deactivate when its last repo is removed — it stays active but idle.

---

## FS-08 · GitHub PR: Base Only

**Purpose:** Verify the "my work vs target" PR mode sets the diff base to the PR's target branch without checking out anything.

**Depends on:** FS-01
**Requires:** GitHub access, a real open PR on a GitHub repo, VS Code GitHub authentication

**Covers:** `pr.ts:resolvePr` (pr-base path), `pr.ts:resolvePrMeta`, `pr.ts:fetchPrMeta`

### Scenarios

**S01 · Happy path — public repo, no auth**
- Precondition: a public GitHub repo with an open PR; user not signed in to GitHub in VS Code
- [User] open picker → `GitHub PR · my work vs target…` → enter PR URL
- Expected: progress notification `GitHub PR #N…`
- Expected: no GitHub sign-in prompt appears (public repo)
- Expected: SCM label: `GitHub PR #N · owner/repo · my work vs target`
- Expected: info notification mentioning `"GitHub PR · PR changes…"` as the alternative
- [Claude] verify HEAD is unchanged (no checkout)
- [Claude] verify `origin/<base-branch>` exists locally after fetch
- [User] open picker again and confirm `← Exit GitHub PR Review` is **not** listed (pr-base mode does not set `prReviewState`; the exit item only appears after a `pr-review` entry)
- [Claude] verify workspaceState key `taskChanges.prReview.<root>` is absent

**S02 · Private repo triggers auth prompt**
- Precondition: a private GitHub repo with an open PR; user not signed in
- [User] enter PR URL for the private repo
- Expected: GitHub sign-in prompt appears
- [User] sign in
- Expected: PR resolves successfully after auth

**S03 · Invalid URL rejected at input**
- [User] open picker → `GitHub PR · my work vs target…` → type `not-a-url`
- Expected: input box shows validation error `Expected: https://github.com/owner/repo/pull/123`
- Expected: cannot submit until URL is valid

**S04 · Valid URL format, non-existent PR**
- [User] enter a well-formed URL with a PR number that does not exist
- Expected: error message `Could not fetch PR #N from GitHub. Check the URL and your network connection.` is shown immediately, with no sign-in prompt, regardless of auth state
- [Claude] verify stored base unchanged
- Note: HTTP 404 now resolves `'not-found'` (distinct from `'auth-required'`). `resolvePrMeta` treats `'not-found'` as an immediate hard stop — no auth retry is attempted. HTTP 401 still triggers the `createIfNone: true` auth-retry path. Network errors (`req.on('error')`) resolve `undefined` directly.

**S05 · Base branch not yet fetched locally**
- [Claude] `git remote prune origin` to remove any cached remote refs
- [User] enter a valid PR URL
- Expected: extension fetches the base branch; label updates correctly
- [Claude] verify `origin/<base>` now exists locally

**S06 · Diff is against current branch, not PR head**
- [Claude] make a local edit (do not stage or commit): `echo "review note" >> README.md`
- Expected: the edit appears in the SCM diff list
- [Claude] confirm HEAD is still on the original branch, not the PR head SHA

**S07 · Diff uses merge base, not base branch tip**
- Precondition: a PR where `origin/<base-branch>` has advanced since the PR was branched
- [User] set base using `GitHub PR · my work vs target…`
- Expected: only the current branch's own commits are shown in the diff, not the base branch's newer commits
- [Claude] verify: `git diff $(git merge-base HEAD origin/<base-branch>) HEAD --name-only` matches the GitBase SCM list
- Note: `baseType === 'PR'` triggers the merge-base path in `provider.ts`, same as `baseType === 'Branch'`

**S08 · Staged-only changes trigger "(will stash)" label**
- [Claude] stage a file change: `git add <file>` (no unstaged modifications)
- [User] open picker
- Expected: the `GitHub PR · PR changes…` item label shows `GitHub PR · PR changes… (will stash)`
- Note: `gitOrNull` returns `null` when the git command exits non-zero. Therefore `unstaged === null` means `git diff --quiet` reported changes (there ARE unstaged changes); `staged === null` means `git diff --cached --quiet` reported changes (there ARE staged changes). `isDirty = unstaged === null || staged === null` — either condition alone is sufficient. Staged-only changes (no working-tree modification on top) still satisfy `staged === null`, so `isDirty = true` and the `(will stash)` label appears even when the working tree itself is clean.

**S09 · Untracked-only dirty state appears "clean" to picker — no stash label**
- [Claude] restore the working tree to a clean tracked state: `git checkout .` and `git clean -fd`
- [Claude] create an untracked file only (do not stage): `echo untracked > new-untracked.txt`
- [User] open picker
- Expected: `GitHub PR · PR changes…` label does NOT show `(will stash)` — untracked files are invisible to `isDirty` because `git diff --quiet` and `git diff --cached --quiet` both exit 0 for untracked-only state
- Note: `isDirty = unstaged === null || staged === null` (`picker.ts:18`). Both commands exit 0 (reporting "clean") when only untracked files exist. Therefore `isDirty = false` regardless of untracked content. See FS-09 for the downstream behavior (untracked files are not stashed).

**S10 · Stale local base branch is used without re-fetching**
- Precondition: `origin/<baseRef>` already exists in the local repo (from a previous fetch); the remote base branch has since advanced (new commits pushed to it)
- [Claude] advance the remote base branch: `git commit --allow-empty -m "remote advance" && git push origin main` (or equivalent on the remote); do NOT run `git fetch` in the working repo
- [Claude] record the current stale local SHA: `git rev-parse origin/main`
- [Claude] record the up-to-date remote SHA: `git ls-remote origin refs/heads/main` (second column)
- [User] enter a PR URL using `GitHub PR · my work vs target…`
- Expected: extension accepts the selection without fetching (the `if (!await gitOrNull(root, 'rev-parse', '--verify', localBase))` guard at `pr.ts:104` evaluates to false because `origin/main` already exists; the fetch block is skipped entirely)
- [Claude] verify: `git rev-parse origin/main` still equals the stale SHA recorded above (no automatic fetch occurred)
- Expected: the SCM diff is computed against the **stale** local `origin/main`, not the current remote tip — changes on the remote base branch since the last fetch are invisible to the diff
- [User] run `git fetch origin` in the terminal, then observe the SCM list update
- Expected: after the fetch, the diff now reflects the current remote base branch; the SCM list may shrink (if base-branch commits merged features also in your branch) or expand
- Note: this is intentional behavior — the extension avoids fetching on every base selection to stay fast and offline-friendly. Users who need the latest base must fetch manually (or wait for their normal fetch cycle).

**S11 · Base-branch fetch failure produces an immediate error**
- Precondition: GitHub API returns valid PR metadata (baseRef, headSha) but `origin/<baseRef>` does not exist locally and the fetch will fail (e.g. simulate by temporarily removing `origin` remote after the metadata call, or by pointing `origin` at a repo that is reachable for HTTPS but lacks the branch; alternatively reproduce by manually deleting the remote ref and blocking network access)
- [User] enter a valid PR URL using `GitHub PR · my work vs target…`
- Expected: the picker does NOT close with a success label. Instead, an error notification `Could not fetch base branch from origin. Check your network connection.` appears immediately
- Expected: stored base is unchanged (no label update, no deferred missing-base warning)
- [Claude] verify: `git rev-parse --verify origin/<baseRef>` exits non-zero confirming the ref was never populated
- Note: `resolvePr` now checks the return value of the fetch. A failed fetch returns the `'fetch-failed'` sentinel, which `picker.ts` handles immediately with an error message and `return undefined`.

---

## FS-09 · GitHub PR: Full Review

**Purpose:** Verify the "PR changes" mode — entering (stash, detached HEAD checkout), reviewing, and exiting (restore branch, restore stash) — including all edge cases.

**Depends on:** FS-01
**Requires:** GitHub access, a real open PR, VS Code GitHub authentication

**Covers:** `pr.ts:resolvePr` (pr-review path), `pr.ts:exitPr`, `pr.ts:popStashBySha`, `pr.ts:countDetachedCommits`, `picker.ts` exit handling

### Scenarios

**S01 · Happy path — clean working tree**
- Precondition: working tree clean, on `feature/alpha`
- [User] open picker → `GitHub PR · PR changes…` → enter PR URL
- Expected: progress spinner, no stash prompt
- Expected: SCM label: `GitHub PR #N · owner/repo · PR changes`
- Expected: exit item appears at top of picker: `← Exit GitHub PR Review  return to feature/alpha`
- [Claude] verify HEAD is detached at the PR's head SHA
- [Claude] verify `git stash list` is empty (nothing stashed)

**S02 · Happy path — dirty working tree (with stash)**
- Precondition: one modified file (not staged), on `feature/alpha`
- [User] open picker → `GitHub PR · PR changes… (will stash)` → enter PR URL
- Expected: file modification disappears from working tree
- [Claude] verify `git stash list` has one entry with message `gitbase: PR review`
- [Claude] capture and note the stash SHA (`git rev-parse stash@{0}`)
- Expected: exit item description shows `return to feature/alpha · pop stash`

**S02b · Untracked-only dirty state — not stashed, persists through checkout**
- Precondition: working tree clean of tracked changes; one untracked file present (`echo untracked > orphan.txt`), on `feature/alpha`
- [User] open picker — note the item label is `GitHub PR · PR changes…` (no `(will stash)` — confirmed by FS-08 S09)
- [User] select `GitHub PR · PR changes…` → enter PR URL
- Expected: progress spinner, HEAD detaches at PR head SHA
- [Claude] verify `git stash list` is empty (untracked files are not stashed — `pr.ts:113` uses `git stash push` without `-u`)
- [Claude] verify `orphan.txt` still exists in the working tree after checkout (untracked files survive `git checkout --detach`)
- [User] open picker → `← Exit GitHub PR Review`
- [Claude] verify HEAD is back on `feature/alpha`; `git stash list` is still empty; `orphan.txt` still exists
- [Claude] remove the untracked file: `rm orphan.txt`
- Note: `isDirty = false` for untracked-only state, so no stash is created and the exit item description shows `return to feature/alpha` (no `· pop stash`). Untracked files are neither stashed nor cleaned — they persist transparently across the checkout.

**S02c · Staged-only dirty state — stashed and restored as staged**
- Precondition: one file staged but working tree otherwise matches HEAD (e.g. `echo staged-change >> README.md && git add README.md`), on `feature/alpha`
- [User] open picker — item label shows `GitHub PR · PR changes… (will stash)` (staged changes satisfy `isDirty`)
- [User] select `GitHub PR · PR changes… (will stash)` → enter PR URL
- [Claude] verify `git stash list` has one entry with message `gitbase: PR review`
- [Claude] verify `git status` shows the working tree is clean (staged change is stashed)
- [User] open picker → `← Exit GitHub PR Review`
- [Claude] verify HEAD is back on `feature/alpha`; `git stash list` is empty
- [Claude] run `git status` and confirm the previously-staged change is in the **index** (staged), not the working tree only
- Note: `popStashBySha` calls `git stash pop --index`, which restores staged content back to the index, preserving the original staged/unstaged distinction.

**S03 · Exit — restore stash to working tree**
- Precondition: S02 completed (in PR review, stash present)
- [User] open picker → `← Exit GitHub PR Review`
- Expected: progress spinner `Exiting GitHub PR Review…`
- Expected: no error or warning messages
- [Claude] verify HEAD is back on `feature/alpha`
- [Claude] verify `git stash list` is empty (stash was popped)
- [Claude] verify the modified file from S02 is restored in working tree
- Expected: SCM label reverts to `Branch · origin/main` (or whatever prevBase was)
- Expected: `← Exit GitHub PR Review` no longer appears in picker

**S04 · Exit blocked by dirty working tree**
- Precondition: in PR review mode (from S01 or S02)
- [Claude] create a dirty working tree while in detached HEAD: `echo "review edit" >> README.md`
- [User] open picker → `← Exit GitHub PR Review`
- Expected: warning `Stash or discard your changes before exiting GitHub PR Review`
- Expected: still in PR review mode (exit item still present)
- [Claude] verify HEAD is still detached at PR SHA

**S05 · Detached commits warning on exit**
- Precondition: in PR review mode; user has committed a change in detached HEAD
- [Claude] make a commit in detached HEAD: `echo test > test-detached.txt && git add test-detached.txt && git commit -m "detached commit"`
- [User] open picker → `← Exit GitHub PR Review`
- Expected: warning `You have 1 unpublished commit in detached HEAD that will become unreachable after exit. Create a branch to keep them.`
- Expected: two buttons: `Exit Anyway` and `Cancel`

**S06 · Cancel detached-commits warning**
- Precondition: S05 state
- [User] click `Cancel`
- Expected: still in PR review mode, no git changes
- [Reset] state is preserved; the detached commit from S05 is still present — proceed directly to S07 without any cleanup

**S07 · Confirm exit despite detached commits**
- Precondition: S05 state (detached commit present)
- [User] click `Exit Anyway`
- Expected: exits cleanly to previous branch
- [Claude] verify the detached commit is no longer reachable from any branch (it is in reflog but not a branch head)
- [Reset] `git stash drop` if a stash was created in an earlier scenario; confirm `git stash list` is empty before proceeding to S08

**S08 · Force Exit when prevBranch deleted**
- Precondition: in PR review mode; `feature/alpha` (prevBranch) has been deleted
- [Claude] `git branch -D feature/alpha`
- [User] open picker → `← Exit GitHub PR Review`
- Expected: error `Failed to restore previous branch. Run "git checkout feature/alpha" manually.`
- Expected: `Force Exit` button in the error message
- [User] click `Force Exit`
- Expected: `← Exit GitHub PR Review` disappears from picker (prReviewState cleared)
- Expected: label reverts to prevBase
- [Claude] verify still on current branch (wherever they were), no crash

**S09 · Stash popped by SHA, not by position**
- Precondition: in PR review mode with stash (S02)
- [Claude] push an unrelated stash on top: `git stash push -m "unrelated"`
- [User] open picker → `← Exit GitHub PR Review`
- Expected: exits cleanly; the `gitbase: PR review` stash is popped
- Expected: the `unrelated` stash is still present in `git stash list`
- [Claude] verify `git stash list` has exactly one entry (the unrelated one)

**S10 · Stash already manually popped before exit**
- Precondition: in PR review mode with stash (S02)
- [Claude] manually pop the stash: `git stash pop`
- [User] open picker → `← Exit GitHub PR Review`
- Expected: exits cleanly with no error (stash pop gracefully skipped — already gone)
- [Claude] verify `git stash list` is empty

**S11 · Persistence across VS Code restart**
- Precondition: S01 or S02 completed (in PR review mode)
- [User] reload VS Code window
- Expected: `← Exit GitHub PR Review` still appears at top of picker after reload
- Expected: exit description still shows correct `prevBranch` and stash indicator

**S12 · Attempt to enter PR review while already in PR review (blocked)**
- Precondition: in PR review mode for PR #A (HEAD is detached at PR A's SHA)
- [User] open picker → `GitHub PR · PR changes…` → (do not enter a URL yet)
- Expected: warning notification `Already in GitHub PR Review. Exit the current review first before starting a new one.`
- Expected: HEAD is unchanged (still detached at PR A's SHA)
- Expected: `prReviewState` is unchanged; `← Exit GitHub PR Review` still appears at the top of the picker
- Note: the guard at `picker.ts` fires immediately when `typeItem.key === 'pr-review' && prReviewState` is truthy, before any URL input box is shown. Users must exit the current PR review before entering a new one.

**S13 · Re-enter same PR**
- Precondition: exited PR review normally (S03)
- [User] open picker → `GitHub PR · PR changes…` → enter the same PR URL again
- Expected: enters cleanly again; new stash if dirty

**S14 · Base-only then full review on same PR**
- [User] set base using `GitHub PR · my work vs target…` for PR #N
- [User] then set using `GitHub PR · PR changes…` for the same PR #N
- Expected: second selection correctly detaches HEAD; label changes from `my work vs target` to `PR changes`
- [Claude] verify HEAD is now detached at the PR's head SHA
- [User] open picker → select `← Exit GitHub PR Review`
- Expected: label reverts to `GitHub PR #N · owner/repo · my work vs target` with no type prefix (e.g. not `Branch · …`)
- Note: `provider.ts` stores `prevBaseType = undefined` when the previous base was type `'PR'`; on exit, `syncLabel` emits the raw `prevBaseLabel` without a `Branch · ` / `Tag · ` prefix, which is correct since PR labels are already fully descriptive

**S15 · Auth prompt cancelled during PR entry**
- Precondition: private GitHub repo, user not signed in to GitHub in VS Code
- [User] open picker → `GitHub PR · PR changes…` → enter a PR URL from the private repo
- Expected: GitHub sign-in dialog appears
- [User] dismiss or cancel the sign-in dialog
- Expected: error notification `Could not fetch PR #N from GitHub. Check the URL and your network connection.`
- Expected: HEAD unchanged, no stash created (stash/checkout steps occur after `resolvePrMeta` succeeds, which it did not)
- [Claude] verify `git stash list` is empty
- Note: cancelling `getSession({ createIfNone: true })` causes it to throw; the `catch` in `resolvePrMeta` returns `undefined`; `resolvePr` returns `undefined`; the picker surfaces the standard fetch-error message. The cancellation is not distinguishable from a network failure at the UI level.

**S16 · PR entry checkout failure — clean working tree**
- Precondition: clean working tree, on `feature/alpha`; simulate a checkout failure after fetch (e.g. use a shallow clone where the PR head SHA is not present locally and the fetch is blocked)
- [User] open picker → `GitHub PR · PR changes…` → enter a valid PR URL
- Expected: error `Failed to switch to PR #N. Ensure origin points to GitHub.`
- Expected: no second warning (clean working tree means no stash was created)
- Expected: HEAD unchanged, still on `feature/alpha`
- [Claude] verify `git stash list` is empty

**S17 · PR entry checkout failure after stash was created**
- Precondition: dirty working tree (one modified file), on `feature/alpha`; checkout is made to fail after the stash step
- [User] open picker → `GitHub PR · PR changes… (will stash)` → enter a valid PR URL
- Expected: error `Failed to switch to PR #N. Ensure origin points to GitHub.`
- Expected: a second warning immediately after: `Your stashed changes could not be restored automatically — they are still safe in the stash. Run "git stash pop" to apply them; if there are conflicts, resolve them then run "git stash drop".` with a `Copy command` button
- Expected: clicking `Copy command` copies `git stash pop` to clipboard
- [Claude] verify `git stash list` still has the stash entry (the extension could not pop it back because `popStashBySha` failed)
- [Claude] verify HEAD is still on `feature/alpha`
- [Reset] `git stash pop` manually to restore the working tree

**S18 · Exit with stash pop conflict**
- Precondition: in PR review mode with stash (from S02); while in detached HEAD, edit and commit the same file that was stashed, creating a merge conflict on pop
- [Claude] edit the stashed file in detached HEAD and commit: `echo conflict-content > <stashed-file> && git add <stashed-file> && git commit -m "conflict setup"`
- [User] open picker → `← Exit GitHub PR Review`
- Expected: exits back to `feature/alpha` (branch is restored successfully)
- Expected: warning `Your stashed changes could not be restored automatically — they are still safe in the stash. Run "git stash pop" to apply them; if there are conflicts, resolve them then run "git stash drop".` with `Copy command` button
- Expected: clicking `Copy command` copies `git stash pop` to clipboard
- [Claude] verify `git stash list` still has the `gitbase: PR review` stash entry (pop failed due to conflict)
- [Claude] verify HEAD is on `feature/alpha`
- [Reset] `git stash drop stash@{0}` to discard the conflicted stash and restore a clean state
