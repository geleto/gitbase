# GitBase Fix Plan 3

Each fix is self-contained. Work through them in order: implement the code change, run the
affected test scenario manually, then update `docs/test-scenarios.md` to reflect the new
behaviour before moving to the next fix.

---

## FIX-08 · Standardise notification prefixes

**Problem:** User-facing messages use three different prefixes with no consistency:
- `"Task Changes: …"` — `extension.ts` (git ext not found), `picker.ts` (invalid ref)
- `"GitBase: …"` — `provider.ts` (refresh failed, base ref gone)
- No prefix — all PR messages, binary notice, patch copied, stash warnings, etc.

The extension's display name is **GitBase Changes** (registered in `provider.ts:37`). Using
"Task Changes:" in messages is a leftover from an earlier name and is confusing.

**Fix:** Change all user-facing messages that start with `"Task Changes:"` to start with
`"GitBase:"` instead:

1. `extension.ts:18`: `'Task Changes: VS Code Git extension not found. Extension disabled.'`
   → `'GitBase: VS Code Git extension not found. Extension disabled.'`

2. `picker.ts:264`: `\`Task Changes: "${newRef}" is not a valid Git ref.\``
   → `\`GitBase: "${newRef}" is not a valid Git ref.\``

**Files:** `src/extension.ts`, `src/picker.ts`

**Scenario updates:**
- FS-01 S04 — update expected error message to `GitBase: VS Code Git extension not found. Extension disabled.`
- FS-02 S08 — update expected error message to `GitBase: "nonexistent-ref" is not a valid Git ref.`

---

## FIX-09 · Enter ref… with a SHA shows 40-char SHA as label

**Problem:** When the user types or pastes a full commit SHA in "Enter ref…", the SCM group
label becomes `Commit · 8f3a9b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a` — the raw 40-character
SHA. Compare with the Commit picker, which shows the commit subject (`Commit · Fix login
bug`). The SHA label is opaque and gives the user no information about what commit they
chose.

**Current behaviour documented in:** FS-02 S07

**Root cause:** In `picker.ts:256-258` (the `else` / `'ref'` branch), `newLabel` is never
set. `label = newLabel ?? newRef` therefore falls back to `newRef` — the raw typed string.
The Commit picker sets `newLabel = picked.label` (the subject line), but Enter ref has no
equivalent lookup.

**Fix:** After `detectRefType` resolves the typed string to `'Commit'`, resolve the subject
with a one-shot `git log`:

```typescript
} else {
  const detected = await detectRefType(root, newRef)
  type = detected.type
  if (detected.shadowed === 'tag') {
    void vscode.window.showWarningMessage(
      `"${newRef}" matches both a branch and a tag. Treating as branch. Use the Tag… picker to select the tag.`
    )
  }
  // For commit SHAs entered via Enter ref…, resolve the subject so the label
  // is human-readable (mirrors what the Commit picker does).
  if (type === 'Commit' && !newLabel) {
    const subject = (await gitOrNull(root, 'log', '-1', '--format=%s', newRef))?.trim()
    if (subject) newLabel = subject
  }
}
```

The label is then `newLabel ?? newRef`: the subject when available, the SHA otherwise (e.g.
if git fails, which is unlikely since `rev-parse --verify` already succeeded above).

**Files:** `src/picker.ts`

**Scenario update:** FS-02 S07 — update expected label from `Commit · <sha>` to
`Commit · <subject>` (the commit's one-line subject). Update the note: "Enter ref… with a
SHA now resolves the commit subject and uses it as the label, matching the behaviour of the
Commit picker. The stored ref is still the full 40-char SHA."

---

## FIX-10 · Auto-recovery fires alarm even when recovery succeeds

**Problem:** When the stored base ref is deleted, `provider.ts:run()` immediately fires a
warning notification:
> "GitBase: base ref "feature/beta" no longer exists. Select a new base to continue."

with a "Select Base" button — and *then* silently auto-recovers to `origin/main`. The user
sees an alarm saying action is required, but by the time they read it, the extension has
already self-healed. If they click "Select Base", the picker opens for no reason.

**Current behaviour documented in:** FS-06 S03, S04

**Root cause:** `provider.ts:121` fires `showWarningMessage` with `void` (fire-and-forget),
then immediately runs `detectDefaultBranch`. The notification is queued before the outcome of
recovery is known, so it always shows the "action required" wording regardless of whether
recovery will succeed.

**Fix:** Await `detectDefaultBranch` first; then show a notification whose wording matches
the outcome:

```typescript
// In provider.ts, replace the block starting at line ~107:
if (!ok) {
  this.group.resourceStates = []
  this.decoProvider.clear(root)
  this.baseRef   = 'HEAD'
  this.baseLabel = 'HEAD'
  this.baseType  = undefined
  await Promise.all([
    this.ctx.workspaceState.update(`taskChanges.base.${root}`,      undefined),
    this.ctx.workspaceState.update(`taskChanges.baseLabel.${root}`, undefined),
    this.ctx.workspaceState.update(`taskChanges.baseType.${root}`,  undefined),
  ])
  this.syncLabel()
  assertScmContext()

  // Attempt auto-recovery BEFORE notifying, so notification wording matches outcome.
  const detected = await detectDefaultBranch(root)
  if (detected) {
    this.baseRef   = detected
    this.baseLabel = detected
    this.baseType  = 'Branch'
    this.autoDetectDone = true
    await Promise.all([
      this.ctx.workspaceState.update(`taskChanges.base.${root}`,      detected),
      this.ctx.workspaceState.update(`taskChanges.baseLabel.${root}`, detected),
      this.ctx.workspaceState.update(`taskChanges.baseType.${root}`,  'Branch'),
    ])
    this.syncLabel()
    // Inform, don't alarm — no action needed.
    void vscode.window.showInformationMessage(
      `GitBase: base ref "${ref}" was deleted; auto-recovered to ${detected}.`
    )
    this.schedule()
  } else {
    this.autoDetectDone = false
    // No recovery possible — user must act.
    void vscode.window.showWarningMessage(
      `GitBase: base ref "${ref}" no longer exists. Select a new base to continue.`,
      'Select Base',
    ).then(action => {
      if (action === 'Select Base') void vscode.commands.executeCommand('taskChanges.selectBase', this.scm)
    })
  }
  return
}
```

**Files:** `src/provider.ts`

**Scenario updates:**

FS-06 S03 — split expected behaviour into two branches:
- If `origin/main` (or other default) is detectable: expected info notification
  `GitBase: base ref "feature/beta" was deleted; auto-recovered to origin/main.` (no button).
  No user action needed; SCM label updates automatically. "Select Base" button is absent.
- If no default is detectable: expected warning notification
  `GitBase: base ref "feature/beta" no longer exists. Select a new base to continue.`
  with `Select Base` button (unchanged from current wording).

FS-06 S04 — update note: "Auto-recovery now runs before the notification fires. If recovery
succeeds, an info notification (not a warning) is shown and the `Select Base` button is
absent. S03 and S04 are now observable from the same refresh in all cases."

FS-06 S04b — no change needed (the no-default-branch path produces the warning notification,
same as before).

FS-06 S05 — update precondition: only reachable when `detectDefaultBranch` returns `null`
(i.e. the warning-with-button path). Remove the "re-create the deleted base scenario" note;
the scenario now needs a repo where no default branch is detectable.

---

## FIX-11 · "Advertise PR changes" notification fires on every pr-base selection

**Problem:** Every time the user selects "GitHub PR · my work vs target…", an info
notification fires:
> "Base set to PR #N target (origin/main). For the exact PR diff, use 'GitHub PR · PR changes…'."

This is noise for any user who has used the extension more than once — the picker already
shows both PR options side-by-side with clear labels. Additionally, when the base ref is
already local (the stale path), TWO info notifications fire back-to-back:
1. "Diff is against your local origin/main (last fetched). Run git fetch to update."
2. The advertising notification above.

Two sequential popups for a single user action is poor UX.

**Current behaviour documented in:** FS-08 S01 (advertising), FS-08 S10 (double notification)

**Root cause:** `picker.ts:191-194` — the `showInformationMessage` advertising "PR changes…"
fires unconditionally after any successful pr-base resolution, including the stale case.

**Fix:** Remove the advertising notification entirely. The stale notification (when `result.stale`)
is retained as-is — it provides actionable information. The SCM label change is sufficient
confirmation that the base was set.

```typescript
// picker.ts — replace lines 185-194:
if (!result.prEnter) {
  if (result.stale) {
    void vscode.window.showInformationMessage(
      `Diff is against your local ${result.ref} (last fetched). Run git fetch to update.`
    )
  }
  // Advertising notification removed — the picker already shows both PR options.
}
```

**Files:** `src/picker.ts`

**Scenario updates:**

FS-08 S01 — remove the bullet:
- ~~"Expected: info notification mentioning `'GitHub PR · PR changes…'` as the alternative"~~
- No notification appears when the base is fresh (fetched for the first time or repo was
  clean). The SCM label change to `GitHub PR #N · owner/repo · my work vs target` is the
  only feedback.

FS-08 S10 — simplify to a single expected notification:
- Expected: one info notification `Diff is against your local origin/main (last fetched). Run git fetch to update.`
- Remove mention of a second notification. The stale notification is the only one shown.

---

## FIX-12 · Force Exit after Stash-and-Exit retry leaves orphaned exit stash

**Problem:** The "Stash and Exit" flow (added in FIX-06) stashes working-tree changes with
the message `gitbase: exit stash`, then calls `exitPr` again. If that second `exitPr` call
fails (e.g. the previous branch was deleted in the interim) and the user clicks "Force Exit",
`prReviewState` is cleared but the `gitbase: exit stash` remains in the stash list with no
notification. The user has no way to know their review-session edits are waiting in the stash.

**Current behaviour:** Not documented in any scenario.

**Root cause:** `picker.ts:77-85` — the `!retry.ok` path for the Stash-and-Exit retry
shows the "Failed to restore previous branch" error and offers Force Exit. On Force Exit it
returns `prExit: true` without disclosing the orphaned exit stash.

**Fix:** After Force Exit in the retry-failed path, show a warning about the exit stash:

```typescript
// picker.ts — inside the !retry.ok block after Stash and Exit:
if (!retry.ok) {
  const act = await vscode.window.showErrorMessage(
    `Failed to restore previous branch. Run "git checkout ${prReviewState.prevBranch}" manually.`,
    'Force Exit'
  )
  if (act === 'Force Exit') {
    void vscode.window.showWarningMessage(
      'Your stashed changes are saved as "gitbase: exit stash". Run "git stash pop" to recover them.',
      'Copy command'
    ).then(a => {
      if (a === 'Copy command') void vscode.env.clipboard.writeText('git stash pop')
    })
    return { ref: prReviewState.prevBase, label: prReviewState.prevBaseLabel, type: prReviewState.prevBaseType, prExit: true }
  }
  return undefined
}
```

**Files:** `src/picker.ts`

**Scenario update:** FS-09 S08 — add a new sub-scenario S08b:

**S08b · Force Exit after Stash-and-Exit retry failure discloses the exit stash**
- Precondition: in PR review mode with a dirty working tree; prevBranch deleted while in review
- [Claude] make a working-tree edit in detached HEAD: `echo "review edit" >> README.md`
- [User] open picker → `← Exit GitHub PR Review`
- Expected: warning `You have uncommitted changes. Stash them and exit PR review?` → click `Stash and Exit`
- [Claude] verify `git stash list` now contains `gitbase: exit stash`
- Expected: second error `Failed to restore previous branch. Run "git checkout feature/alpha" manually.` (prevBranch was deleted)
- [User] click `Force Exit`
- Expected: additional warning `Your stashed changes are saved as "gitbase: exit stash". Run "git stash pop" to recover them.` with `Copy command` button
- [Claude] verify `git stash list` still contains the exit stash entry
- [Reset] `git stash drop` to clean up; re-create `feature/alpha` for subsequent scenarios

---

## FIX-13 · `openWithoutAutoReveal` writes explicit `scm.autoReveal: true` to settings.json

**Problem:** `openWithoutAutoReveal` (workarounds.ts) temporarily sets `scm.autoReveal =
false`, then restores the previous value in a `finally` block. The previous value is read
with `scmConfig.get<boolean>('autoReveal')`, which returns the *effective* value (including
defaults) — `true` — even when the user has never explicitly set the preference. The `finally`
block then writes `scm.autoReveal = true` to the user's `settings.json`. After a single
A/U file open, the user's settings.json gains an entry they never wrote:

```json
"scm.autoReveal": true
```

This is functionally harmless but is unexpected settings.json pollution.

**Current behaviour documented in:** FS-04 S03 (the "verify restored" Claude step implicitly
accepts this behaviour)

**Root cause:** `workarounds.ts:93` — `scmConfig.get` returns the effective value. `inspect`
returns only the explicitly-set value.

**Fix:** Use `inspect` to get only the explicitly-configured global value, and restore to
`undefined` (removing the entry) when it was never explicitly set:

```typescript
export async function openWithoutAutoReveal(uri: vscode.Uri): Promise<void> {
  const scmConfig  = vscode.workspace.getConfiguration('scm')
  // Use inspect() to get only the explicitly-set global value (undefined if defaulted).
  const prev = scmConfig.inspect<boolean>('autoReveal')?.globalValue
  // Only write if the effective value is not already false (i.e. don't suppress if user
  // explicitly disabled auto-reveal — writing false when false is a no-op anyway).
  const effective = scmConfig.get<boolean>('autoReveal')
  if (effective !== false) await scmConfig.update('autoReveal', false, vscode.ConfigurationTarget.Global)
  try {
    await vscode.window.showTextDocument(uri)
  } finally {
    // Restore to the previously-explicit value (undefined removes the setting from settings.json).
    if (effective !== false) await scmConfig.update('autoReveal', prev, vscode.ConfigurationTarget.Global)
  }
}
```

When `prev` is `undefined`, `scmConfig.update('autoReveal', undefined, Global)` removes the
key from settings.json — restoring the truly original state.

**Files:** `src/workarounds.ts`

**Scenario updates:**

FS-04 S03 — update the Claude verification step:
- "[Claude] re-read the VS Code user settings file and verify `scm.autoReveal` is **absent**
  (the setting was not explicitly set before the test; the restore now removes it rather than
  writing `true` explicitly)"
- Note: if the user explicitly had `"scm.autoReveal": true` before the test, the key will
  still be present with value `true` after restore. This is correct. Only users who had no
  explicit setting see a cleaner settings.json.

FS-04 S03c — no change needed (the `effective !== false` guard preserves the existing
behaviour for explicitly-false users).

---

## FIX-14 · FS-03 S12 — misleading "SCM list updates" after first commit on unborn repo

**Problem (test description only — no code change):**

FS-03 S12 says:
> "[Claude] make the first commit … Expected: within ~500ms the SCM list updates (the
> `repo.state.onDidChange` event fires after the commit, scheduling a refresh)"

This implies the list becomes non-empty after the commit. In practice, the base is still
`HEAD` (auto-detect ran on the unborn repo and found nothing), so after the commit the diff
is `git diff HEAD --` — always empty. The "update" means the refresh runs without crashing;
the list stays empty.

**Fix (test description only):**

Update FS-03 S12 — replace the commit/update bullet:
> "[Claude] make the first commit: `echo hello > first.txt && git add first.txt && git commit -m "init"`"
> "Expected: within ~500ms the provider refreshes without error — `repo.state.onDidChange`
> fires, scheduling a refresh. The SCM list remains empty (base is still `HEAD`; `git diff
> HEAD` on a now-valid HEAD produces no output) and no error notification appears."

---

## FIX-15 · FS-04 S14 — scenario setup is unrealistic for the content provider fallback message

**Problem (test description only — no code change):**

FS-04 S14 says: "a file exists in the working tree that does NOT exist at the base ref (e.g.
set base to a commit that predates the file's creation, so the file is shown as A in the SCM
list **but also appears as M** because it has been modified since it was added)".

This is self-contradictory. If the file did not exist at the base ref, the diff classifies it
as `A` (Added). `A` files do not open a diff editor — they use `taskChanges.openUntracked`
which opens the file directly. The content provider's `(file did not exist at <ref>)` fallback
only appears on the **left side of a diff editor**, which is only opened for `M` and `R` files.
An `M` file by definition existed at the diff ref (git found a modification, not an addition).
So the scenario's main premise is contradictory and the described path is not triggerable via
normal SCM panel interaction.

The "alternative setup" in the note ("manually open a `basegit:` URI via the diff editor for a
path that never existed at the base ref") is the only realistic trigger, but it requires external
URL invocation, not normal UI interaction.

**Fix (test description only):**

Rewrite FS-04 S14 with a realistic setup that actually reaches the fallback message:

**S14 · Content provider shows fallback message when `git show` fails for a branch-based ref**
- Precondition: base is set to a branch (e.g. `origin/main`); diff editor is open on a tracked
  `M` file showing base content on the left side
- [Claude] corrupt the content provider cache for this file by pushing a commit to `origin/main`
  that moves it past the cached branch tip: `git commit --allow-empty -m "advance base" && git push origin main`; then in the test repo: `git fetch origin`
- [Claude] trigger a refresh: the cache invalidates, the provider re-fetches. Verify `git show
  origin/main:<file>` still succeeds (file still exists on the new tip) — this scenario only
  applies when the file was **deleted** from the base branch. Adjust setup: `git rm <file> &&
  git commit -m "delete from base" && git push origin main`; `git fetch origin`
- [User] click the file in the SCM list (it appears as M since HEAD still has it, but
  `git show origin/main:<file>` now fails because the file was deleted from the base branch)
- Expected: left side of diff editor shows `(file did not exist at origin/main)` — `git show`
  exits non-zero; the content provider substitutes the fallback string
- Expected: right side shows the current working-tree content normally
- [Claude] confirm: `git show origin/main:<filepath>` exits non-zero
- Note: for SHA-based refs (e.g. a merge-base SHA) the fallback reads `(file did not exist at
  <8-char-sha>)`; for named refs it shows the full ref name.
- [Reset] restore the file on `origin/main` and reset the test repo

---

## Out of scope — additional known limitations identified during this review

### workspaceState verification steps require sqlite3 access
Multiple test scenarios ([FS-02 S01, FS-05 S09, FS-08 S01, etc.]) instruct Claude to "verify
workspaceState key contains…". VS Code stores `workspaceState` in an SQLite database at
`<user-data-dir>/User/workspaceStorage/<hash>/state.vscdb`. Reading it requires `sqlite3
<path> "SELECT value FROM ItemTable WHERE key='taskChanges.base.<root>'"`. The test scenarios
should document this mechanism once in the FS-01 preamble rather than leaving each "[Claude]
verify workspaceState" step implicit. **Action:** add a "How to inspect workspaceState" note
to the test-scenarios.md preamble in the next test-scenarios revision pass.

### Stash exit-description persists after manual stash drop (FS-09 S11)
If the user manually runs `git stash drop` while in PR review mode, the stash SHA stored in
`prReviewState` still exists in workspaceState. On reload, the exit item's description still
shows `return to feature/alpha · pop stash` even though the stash is gone. When the user
actually exits, `popStashBySha` returns `true` (index not found = already gone) and exit
completes cleanly. The misleading description is a display artefact that self-corrects on
exit. No code change is practical without adding a stash-presence check to every picker open.
**Action:** document as a known limitation in FS-09 S11's note.
