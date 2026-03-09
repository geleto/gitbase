# GitBase Improvement Proposals

Identified by analysing the combined test plans against the extension implementation.
Each item describes the current behaviour, why it is suboptimal, and the most
elegant implementation path.

Priority: **High** → genuine UX harm or data-loss risk. **Medium** → regular
friction with a low-cost fix. **Low** → consistency/polish.

---

## 1. Detached commits on exit: add "Create Branch Here" action

**Priority:** High — potential data loss

### Current behaviour (FS-09 S05–S07, combined-05 B.9)

When the user has made commits in detached HEAD during PR review and then opens
the exit item, the extension shows:

> `You have N unpublished commit(s) in detached HEAD that will become unreachable after exit. Create a branch to keep them.`

with two buttons: **Exit Anyway** and **Cancel**.

The message already tells the user what to do ("Create a branch"), but does not
do it for them. The user must click **Cancel**, manually run `git checkout -b
<name>`, and then exit again. Choosing **Exit Anyway** silently discards the
commits (they enter the reflog but are pruned by GC after ~30–90 days with no
warning).

### Why it matters

This is the only scenario in the extension where user data can be lost without a
recovery path visible in the UI. The commits exist in the working tree; the
extension knows their count and the current HEAD SHA at dialog time.

### Proposed solution

Add a third button: **Create Branch…**

Flow:
1. `vscode.window.showInputBox({ prompt: 'New branch name', value: 'review/pr-N' })`
2. On confirm: `git checkout -b <name>` — the user is now on the new branch, still
   at the same HEAD SHA, commits reachable.
3. Clear `prReviewState` and restore the previous base label (same as normal exit
   — no branch-restore step needed because the user is now on a real branch).

The pre-filled default `review/pr-N` (derived from the stored PR number) removes
friction for the common case. If the input is cancelled, the user stays in review
mode (same as clicking **Cancel** today).

This gives the exit dialog three semantically distinct outcomes:
- **Create Branch…** — save work and exit
- **Exit Anyway** — intentionally discard and exit
- **Cancel** — stay in review

---

## 2. SCM button flicker on every GitBase refresh

**Priority:** High — persistent visual degradation in normal use

### Current behaviour (FS-05 S10, combined-01 F.2)

After every GitBase refresh (triggered by file-system watcher or manual refresh,
up to ~every 400 ms), `assertScmContext()` in `workarounds.ts` re-asserts the VS
Code context keys `scmProvider=taskchanges` and `scmResourceGroup=changes`. This
is Workaround C, introduced to fix stale inline buttons in the GitBase panel.

Side-effect: re-asserting these keys briefly evicts the git panel's own context
keys (`scmProvider=git`, etc.), causing git's inline **Stage** / **Discard**
buttons to disappear from the git panel on the current hover and reappear only on
the next hover. The test verifies this as expected behaviour.

Documented in `docs/bug-vscode-scm-button-cache-contamination.md`.

### Why it matters

Both GitBase and the built-in git panel are visible simultaneously in normal
usage. The flicker is visible on every background refresh — not just on user
actions — making the git panel feel unreliable.

### Proposed solution

Narrow the scope of context assertion so it fires only when a GitBase row is
interacted with (hover, click), not on every periodic refresh:

1. **Remove `assertScmContext()` from the refresh code path.** The workaround
   was introduced to fix a stale-button problem; investigate whether that problem
   still reproduces on current VS Code builds. If it does not, remove the
   workaround entirely.

2. **If the stale-button bug still reproduces**, move `assertScmContext()` to the
   individual command handlers (`taskChanges.openFile`,
   `taskChanges.copyRelativePath`, etc.) rather than calling it after every diff
   computation. The context only needs to be correct when a command is about to
   execute, not at all times.

3. **Add a `WORKAROUND_STALE_SCM_CONTEXT` feature flag** (already exists per the
   note) to the extension settings so users who never see the stale-button problem
   can opt out of the workaround and eliminate the flicker entirely.

---

## 3. Stale base notification lacks a "Fetch Now" action

**Priority:** Medium — daily friction for PR workflow users

### Current behaviour (FS-08 S10, combined-05 A.8)

When the user selects a PR base and `origin/<base-branch>` already exists locally
but the remote has since advanced, the extension shows an info notification:

> `Diff is against your local origin/main (last fetched). Run git fetch to update.`

No fetch is performed. The user must open a terminal and run `git fetch origin`
manually, then the GitBase diff updates automatically.

### Why it matters

This sequence occurs regularly for anyone doing PR review work in an active repo.
The notification correctly identifies the problem and states the fix, but the fix
requires leaving VS Code's UI entirely. The VS Code notification API supports
action buttons at no additional complexity cost.

### Proposed solution

Add a **Fetch Now** button to the existing notification:

```typescript
const action = await vscode.window.showInformationMessage(
  `Diff is against your local ${baseRef} (last fetched). Run git fetch to update.`,
  'Fetch Now'
);
if (action === 'Fetch Now') {
  await git.fetch(repo);       // existing git abstraction
  provider.refresh();           // existing refresh call
}
```

The fetch runs in the background; the notification dismisses on click. If the
fetch fails (network error), show a follow-up error notification. No change to the
default no-fetch behaviour — users who prefer manual control simply ignore the
button.

---

## 4. "Already in PR review" item is selectable but always errors

**Priority:** Medium — wasted interaction in a knowable state

### Current behaviour (FS-09 S12, combined-05 B.14)

When `prReviewState` is set (the user is already in PR review), the
`GitHub PR · PR changes…` picker item shows description text `exit current review
first`. The item remains fully selectable. If clicked, it prompts for a URL, and
only after URL entry does the extension show:

> `Already in GitHub PR Review. Exit the current review first before starting a new one.`

The state (`prReviewState`) is known at picker-open time.

### Why it matters

The current flow is: surface a hint → allow the action → reject the action. This
is the worst pattern: the user reads the hint, decides to try anyway (or misses
the hint), enters a URL, and is then rejected. Two wasted interactions for a
constraint that was known before the picker opened.

### Proposed solution

At picker-construction time, when `prReviewState` is set, replace the
`GitHub PR · PR changes…` item with a visually distinct entry:

```typescript
{
  label: '$(circle-slash) GitHub PR · PR changes…',
  description: 'exit current review first',
  alwaysShow: true,
  // Mark as non-interactive — VS Code QuickPickItem does not have a
  // native disabled state, so use a separator or a no-op onDidAccept guard.
}
```

Since VS Code's QuickPick API does not support truly disabled items, the cleanest
approach is to intercept `onDidAccept`: if the selected item is the blocked entry,
do nothing (no URL prompt, no notification). The existing `← Exit GitHub PR
Review` item at the top of the picker already provides the correct action path.

Optionally, hide the `GitHub PR · PR changes…` item entirely when in review
mode — the exit item makes it clear what the next step is.

---

## 5. Deleted tag shows warning on successful auto-recovery; branch shows info

**Priority:** Low — inconsistency users rarely notice

### Current behaviour (FS-06 S03 + S05b, combined-02 C.1 vs C.2)

Both a deleted tracked branch and a deleted tracked tag trigger the same
validation path (`git rev-parse --verify <ref>` exits non-zero). When
`detectDefaultBranch` succeeds in both cases and the extension auto-recovers:

- Deleted **branch** + successful recovery → **info** notification:
  `GitBase: base ref "feature/beta" was deleted; auto-recovered to origin/main.`
- Deleted **tag** + successful recovery → **warning** notification:
  `GitBase: base ref "v1.0" no longer exists. Select a new base to continue.`

The outcome is identical (extension recovered, user needs to do nothing), but the
notification severity differs by input type. Warning implies action required;
info implies "FYI".

### Why it matters

Minor, but inconsistency in notification level erodes trust in the signal. Users
who learn that warnings require action will be confused when a warning appears
with no required action.

### Proposed solution

Unify notification level based on **outcome**, not **input type**:

| Recovery succeeded | Recovery failed |
|---|---|
| Info: `base ref "<ref>" no longer exists; auto-recovered to <default>.` | Warning + **Select Base** button |

The branch message currently reads differently ("was deleted; auto-recovered")
from the tag message ("no longer exists. Select a new base"). Harmonise both to
use the same template with the outcome embedded:

- **Recovered:** `GitBase: base ref "<ref>" no longer exists; auto-recovered to <default>.` (info, no button)
- **Not recovered:** `GitBase: base ref "<ref>" no longer exists. Select a new base to continue.` (warning, **Select Base** button)

---

## 6. Stash pop conflict leaves user with raw terminal commands

**Priority:** Medium — high severity when it occurs, low frequency

### Current behaviour (FS-09 S18, combined-05 B.20)

When `git stash pop --index` fails on exit from PR review (due to a merge
conflict), the extension shows:

> `Your stashed changes could not be restored automatically — they are still safe in the stash. Run "git stash pop" to apply them; if there are conflicts, resolve them then run "git stash drop".`

with a **Copy command** button that copies `git stash pop` to the clipboard.

Same pattern applies to:
- B.11: Force Exit with stash left behind
- B.8: Exit stash from changes made during review

### Why it matters

This is a data-recovery situation. The user's changes are safe (in the stash), but
restoring them requires running a terminal command that will produce conflict
markers — and then resolving those conflicts in their editor. VS Code has a
built-in merge editor that handles this workflow; GitBase bypasses it entirely.

### Proposed solution

When `git stash pop --index` exits non-zero:

1. Detect whether the failure is a conflict (`git diff --check` or check for
   conflict markers in the output).
2. If conflict: instead of showing the notification with "Copy command", run
   `git stash apply --index` (which leaves the stash entry intact and writes
   conflict markers into the working tree), then call
   `vscode.commands.executeCommand('merge-editor.openIfEnabled', ...)` on the
   conflicting files to open them in VS Code's merge editor.
3. Show an info notification: `Stash applied with conflicts — resolve them in the
   editor, then run "git stash drop" to finish.` with a **Copy drop command**
   button as a fallback.

For the simpler cases (B.8 exit stash, B.11 force-exit stash with no conflict),
where the stash is left intact but no conflict was attempted, the current
notification text is adequate — just replace **Copy command** with the command
shown inline in the notification body so the user does not need to copy-paste:

> `Run: git stash pop` (monospace, selectable)

---

## 7. Two-window last-writer-wins gives no feedback to the "losing" window

**Priority:** Low — niche scenario, surprising but not harmful

### Current behaviour (FS-06 S07, combined-02 E)

Two VS Code windows open on the same folder. Each selects a different base. Both
write immediately to the shared workspaceState key `taskChanges.base.<root>`.
When window A reloads, it reads window B's write and silently displays window B's
base. No notification, no indication that the base changed from what was set
before the reload.

### Why it matters

For users who regularly split their work across two windows of the same repo (e.g.
one window focused on a feature branch, one on main), a silent base change on
reload is confusing. The label changes with no explanation.

### Proposed solution

Before loading from workspaceState on startup, compare the loaded value to the
value that was active at last shutdown (stored as a session-scoped in-memory
value, or as a separate `taskChanges.base.session.<root>` key that is written at
shutdown and not shared between windows):

If the loaded base differs from the session value, show a one-time info
notification:

> `GitBase: base restored from storage: Branch · origin/main (another window may have changed it).`

This requires no change to the storage model — just a startup comparison. The
notification dismisses automatically after a few seconds or on any user
interaction.

A lightweight alternative: display the base source in a tooltip on the SCM label
(`last set by: this window / another window / auto-detect`) rather than a
notification, giving the information without interrupting the workflow.
