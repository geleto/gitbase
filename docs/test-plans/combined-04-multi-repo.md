# Combined Test Plan 04 — Multi-Repo

## Coverage

| Feature Set | Scenarios Included |
|-------------|-------------------|
| FS-07 · Multi-Repo | S01, S02, S03, S03b, S03c, S04, S05, S06, S07, S07b |
| FS-05 · SCM Label & Decorations | S09 |
| FS-06 · Persistence & Recovery | S08 |
| Status Bar | Multi-repo active-editor switching (Section D.3) |
| Context Menus | Explorer Open Diff resolves to correct repo (Section D.1b) |

## Prerequisites

- FS-01 completed: primary test repo exists at a known path (call it `REPO_A`)
- VS Code is open on `REPO_A`; GitBase Changes panel shows `Branch · origin/main`
- Extension is active

> **Shell:** All `[Claude]` commands use bash syntax (`$(…)`, `mktemp`, `grep`, etc.). Run them from Claude Code's integrated bash shell, Git Bash, or WSL — not from PowerShell directly.

## Optimisation Rationale

All multi-repo scenarios share the same workspace setup (two repos open simultaneously). FS-05 S09 (workspaceState namespacing) and FS-06 S08 (late repo discovery) slot naturally into the multi-repo session rather than requiring separate setups. The FS-07 scenarios are sequenced to build on each other's state, minimising intermediate workspace changes.

---

## Section A: Setup — Two Repos in One Workspace

### A.1 — Create second repo and add to workspace (`FS-07 S01`)

[Claude] Create a second git repo as a sibling of `REPO_A`:
```
REPO_A=$(git rev-parse --show-toplevel)
REPO_B=$(dirname "$REPO_A")/gitbase-test-repo-b
mkdir -p "$REPO_B"
cd "$REPO_B"
git init
echo "repo B content" > file-b.txt
git add file-b.txt
git commit -m "initial commit in repo B"
echo "Repo B path: $REPO_B"
```

[User] Add repo B to the workspace: File → Add Folder to Workspace… → select the path Claude printed (`REPO_B`).

Expected: A second **GitBase Changes** panel appears in the SCM view, one for repo A and one for repo B.
Expected: Each panel is independent — repo A's panel still shows `Branch · origin/main`.

### A.2 — Confirm late repo discovery fires via `onDidOpenRepository` (`FS-06 S08`)

The act of adding repo B to the workspace while the extension is already active exercises `api.onDidOpenRepository` (`extension.ts:48`), which fires for each repository the git extension opens after our listener is registered.

Expected (already verified in A.1): The second GitBase Changes panel appeared without restarting VS Code.

Note: The extension's only activation event is `workspaceContains:.git`. It is dormant in a completely empty workspace — adding the very first folder to an empty workspace does not exercise this path because the extension has not yet activated. This test works because the extension was already active on `REPO_A`.

---

## Section B: Picker Targeting and Repo Selection

### B.1 — SCM title bar button targets correct repo (`FS-07 S02`)

[User] Click the `$(git-branch)` icon in **repo A's** GitBase panel title bar (not repo B's).

Expected: The base picker opens. Select `Branch… → origin/feature/alpha` for repo A.
Expected label for repo A: `Branch · origin/feature/alpha`
Expected: Repo B's label is unchanged (whatever it was before).

### B.2 — Command palette shows repo picker with two repos (`FS-07 S03`)

[User] Open the command palette → `Task Changes: Select Base…`.

Expected: A quick pick appears listing both repo folder names (repo A's folder name and repo B's folder name). The user must select a repo before the base picker opens.

[User] Select repo A from the quick pick → then select `Default branch` from the base picker.
Expected label for repo A: `Branch · origin/main`

Note: With exactly one repo open, the command palette skips the repo picker and acts on that repo directly (`providers.size === 1` path in `resolveProvider`). This step verifies the two-repo path.

### B.3 — Cancel repo picker is a silent no-op (`FS-07 S03b`)

[User] Open the command palette → `Task Changes: Select Base…`.

Expected: The repo quick pick appears.

[User] Press Escape when the repo quick pick is visible.

Expected: Nothing happens — no base picker opens, no error, no notification. (`picked?.provider` is `undefined`; `resolveProvider` returns `undefined`; the optional chain `?.selectBase()` short-circuits.)

Note: The same silent no-op applies to `Task Changes: Refresh` when the repo picker is cancelled.

### B.4 — WorkspaceState keys namespaced by repo root (`FS-05 S09`)

[User] In **repo A's** GitBase panel: open the picker → Branch… → select `origin/feature/alpha`.
Expected label for repo A: `Branch · origin/feature/alpha`

[User] In **repo B's** GitBase panel: open the picker → Commit… → select any commit.
Expected label for repo B: `Commit · <subject>`

[Check] Verify the stored key names differ. The key format is `taskChanges.base.<absolute-root-path>`, so different root paths produce different key names by construction:
```bash
REPO_B="$(dirname "$(git rev-parse --show-toplevel)")/gitbase-test-repo-b"
echo "Repo A root: $(git rev-parse --show-toplevel)"
echo "Repo B root: $REPO_B"
```
Expected: The paths differ. The behavioral proof is already established above: repo A's label shows `Branch · origin/feature/alpha` while repo B's shows `Commit · <subject>`, confirming each repo reads and writes its own storage key.

Optional deeper verification — [User] open `Help → Toggle Developer Tools` → Application tab → Storage → IndexedDB → find the workspaceStorage entry for this VS Code window → confirm two separate `taskChanges.base.*` keys exist with different path suffixes, each holding the ref set for its respective repo.

Note: This tests isolation between two *different* repo paths in one window. Two windows open on the *same* folder share the same workspaceState key — last writer wins (tested in Combined-02 Section E).

---

## Section C: Duplicate Basenames (`FS-07 S03c`)

**Purpose:** Verify the repo picker disambiguates repos with identical folder names using the description field.

### C.1 — Setup: create a second repo with the same basename as repo A

[Claude] Create a third repo with the same basename as repo A:
```bash
REPO_A_NAME=$(basename "$(git rev-parse --show-toplevel)")
REPO_BASE=$(mktemp -d)
REPO_C="$REPO_BASE/$REPO_A_NAME"
mkdir -p "$REPO_C"
cd "$REPO_C"
git init
git commit --allow-empty -m "initial"
echo "Duplicate basename repo: $REPO_C"
```

Note: The folder name of `REPO_C` is the same as `REPO_A_NAME`. Record the printed `REPO_C` path — you will need it verbatim in the Reset step below.

[User] Add the duplicate repo to the workspace: File → Add Folder to Workspace… → select `REPO_C`.

[User] Open the command palette → `Task Changes: Select Base…`.

Expected: The repo quick pick shows two entries with the same `label` (the shared folder name). They are distinguished only by the `description` field, which shows the full absolute path for each (`extension.ts:70`).

[User] Select repo A's entry (identified by its full path in the description) from the quick pick.

Expected: The base picker opens showing refs for repo A (e.g. `origin/main` is listed). This confirms selection routes to the correct repo despite the shared label.

[User] Press Escape to close the base picker without selecting.

[User] Open the command palette → `Task Changes: Select Base…` again.

[User] Press Escape when the repo quick pick appears.

[Reset] Remove the duplicate repo from the workspace: File → Remove Folder from Workspace → select `REPO_C`. Claude removes the directory:
```
rm -rf "$REPO_C"
```

---

## Section D: Resource Commands Resolve to Correct Repo

### D.1 — Copy Relative Path uses correct repo root (`FS-07 S04`)

**Precondition:** Repo B has at least one file in its GitBase diff list. If it does not, [Claude] re-derive `REPO_B` and create a modification:
```bash
REPO_B="$(dirname "$(git rev-parse --show-toplevel)")/gitbase-test-repo-b"
echo "change" >> "$REPO_B/file-b.txt"
```

[User] Right-click `file-b.txt` in **repo B's** GitBase SCM list → Copy Relative Path.

Expected: The clipboard contains `file-b.txt` (relative to repo B's root), NOT a path relative to repo A's root.

### D.1b — Open Diff from Explorer resolves to correct repo

**Precondition:** A file from repo B is the active editor (open and focused). That file appears as changed in repo B's GitBase panel.

[User] Right-click the file in the Explorer.

Expected: `Open Diff Against Base` appears in the context menu.

[User] Click `Open Diff Against Base`.

Expected: The diff opens using repo B's base (not repo A's). Verify by checking the left-side tab title shows repo B's base label.

Note: The command resolves the correct provider using `resolveProviderForResource` — the deepest matching repo root wins.

### D.2 — Refresh command prompts for repo selection (`FS-07 S06`)

**Precondition:** Both repos have at least one file in their GitBase diff lists.

[Claude] Modify a file in repo A externally:
```
echo "# refresh test" >> "$(git rev-parse --show-toplevel)/README.md"
```

[User] Open the command palette → `Task Changes: Refresh`.

Expected: The repo quick pick appears listing both repo folder names.

[User] Select repo A.

Expected: Repo A's SCM list updates to include the changed file. Repo B's list is unaffected.

Note: `taskChanges.refresh` calls `resolveProvider(sc)` (`extension.ts:90`). From the command palette (`sc` is absent, `providers.size > 1`), it shows the repo picker. From the SCM title bar `$(refresh)` button, `sc` is passed and the picker is skipped.

---

## Section D.3 — Status bar switches to active editor's repo

**Purpose:** Verify that when multiple repos are open, the status bar item shows the base for the repo that owns the currently active file, hiding the others.

**Precondition:** Both repo A and repo B have a GitBase Changes panel. Each has a different base selected (e.g. repo A: `Branch · origin/main`, repo B: `Commit · <subject>` from Section B.4).

[User] Open a file from repo A in the editor (e.g. click FILE_M from repo A's GitBase panel).

Expected: The status bar shows repo A's base (e.g. `⎇ origin/main`). Repo B's status bar item is hidden.

[User] Open a file from repo B in the editor (e.g. click `file-b.txt` from repo B's GitBase panel).

Expected: The status bar switches to show repo B's base. Repo A's status bar item is hidden.

[User] Close all editors (`View → Close All Editors`).

Expected: Both status bar items become visible (no active editor → no owner → show all).

---

## Section E: Closing a Repo (`FS-07 S05`)

**Purpose:** Verify that removing a repo from the workspace removes its panel and clears its Explorer badges.

**Precondition:** Repo B has at least one file in its GitBase diff list (from Section D).

### E.1 — Close repo B and verify panel disappears

[User] Open the Explorer view. Confirm that repo B's modified files show GitBase letter badges.

[User] Remove repo B from the workspace: File → Remove Folder from Workspace → select repo B.

Expected: Repo B's GitBase Changes panel disappears from the SCM view immediately. Repo A's panel is unaffected.

### E.2 — Verify badge cleanup by re-adding repo B briefly

[User] Re-add repo B to the workspace: File → Add Folder to Workspace → select `REPO_B`.

[User] Open the Explorer and observe repo B's files.

Expected: Repo B's files show NO stale GitBase badges (they are absent or show only git's own badge). The `provider.dispose()` call cleared all decorations when repo B was removed.

Note: `provider.dispose()` calls `decoProvider.clear(root)` which fires `onDidChangeFileDecorations` for all previously decorated URIs, prompting VS Code to re-query (and find no decoration) for each. After re-adding, the provider starts fresh — no stale badges.

[User] Remove repo B from the workspace again.

---

## Section F: Commands with No Repos Open (`FS-07 S07`)

**Purpose:** Verify commands silently no-op when no repos are open.

**Precondition:** Repo B has been removed (from Section E). Now also remove repo A.

[User] Remove repo A from the workspace: File → Remove Folder from Workspace → select repo A.

Expected: Both GitBase Changes panels are now gone. The extension remains active (it does not deactivate when the last repo is removed) but idle.

[User] Open the command palette → `Task Changes: Select Base…`.

Expected: Nothing happens — no picker, no error, no notification. (`resolveProvider` returns `undefined` when `providers.size === 0`; the optional chain `?.selectBase()` short-circuits.)

[User] Open the command palette → `Task Changes: Refresh`.

Expected: Same — silent no-op.

Note: `extension.ts:67` explicitly handles `providers.size === 0` with `return undefined`.

[Reset] Re-add repo A to the workspace: File → Add Folder to Workspace → select `REPO_A`.
Expected: GitBase Changes panel for repo A reappears with label `Branch · origin/main`.

---

## Section G: Nested Repo Layout (`FS-07 S07b`)

**Purpose:** Verify that resource commands resolve against the most-specific (deepest) matching repo when one repo root is a path-prefix of another.

**Note:** VS Code may not allow adding a subfolder of an already-open workspace folder via File → Add Folder to Workspace. If the UI blocks this, open VS Code with a multi-root `.code-workspace` file that lists both paths:
```json
{
  "folders": [
    { "path": "<REPO_A path>" },
    { "path": "<REPO_NESTED path>" }
  ]
}
```
Save the file and open it with `code <filename>.code-workspace`.

### G.1 — Setup: nested repo

[Claude] Create a nested repo inside repo A's directory:
```bash
REPO_A="$(git rev-parse --show-toplevel)"
REPO_NESTED="$REPO_A/packages/lib"
mkdir -p "$REPO_NESTED"
git -C "$REPO_NESTED" init
echo "nested lib content" > "$REPO_NESTED/lib.txt"
git -C "$REPO_NESTED" add lib.txt
git -C "$REPO_NESTED" commit -m "initial"
echo "Repo A: $REPO_A"
echo "Nested repo: $REPO_NESTED"
```

Note: Record both printed paths. Do NOT `cd` into `REPO_NESTED` — the shell must remain in repo A so that subsequent `git rev-parse --show-toplevel` calls in this section resolve correctly.

[User] If VS Code allows it: File → Add Folder to Workspace… → select `REPO_NESTED`. Otherwise create a `.code-workspace` file listing both paths and open it.

[User] Ensure both repos have at least one file in their GitBase diff lists. Modify a file in the nested repo:

[Claude] Create a change in the nested repo:
```bash
echo "change" >> "$(git rev-parse --show-toplevel)/packages/lib/lib.txt"
```

### G.2 — Right-click resolves to most-specific provider

[User] Right-click `lib.txt` in the **nested repo's** GitBase SCM list → Copy Relative Path.

Expected: The clipboard contains `lib.txt` (relative to the nested repo's root), NOT `packages/lib/lib.txt` (which would be relative to repo A's root).

[Check] Verify the copied path does not start with `packages/lib/`:
The clipboard should contain exactly `lib.txt`, not a longer path.

Note: `resolveProviderForResource` in `extension.ts` sorts candidates by root-path length descending before `find()`, so the deepest (most-specific) matching repo always wins, regardless of insertion order. The same correct resolution applies to Copy Changes (Patch).

[Reset] Remove the nested repo from the workspace and delete it:
```
rm -rf "$(git rev-parse --show-toplevel)/packages"
```

---

## Teardown

[Claude] Remove repo B if it still exists (re-derive the path in case the variable was not preserved across sections):
```bash
REPO_B="$(dirname "$(git rev-parse --show-toplevel)")/gitbase-test-repo-b"
rm -rf "$REPO_B" 2>/dev/null || true
```

[Claude] Verify the primary test repo (repo A) is clean:
```
git status
git branch -a
```

[User] Confirm only one GitBase Changes panel is visible (repo A only), showing `Branch · origin/main`.

The workspace and repo are now in a clean state for the next combined test plan.
