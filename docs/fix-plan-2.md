# GitBase Fix Plan

Each fix is self-contained. Work through them in order: implement the code change, run the
affected test scenario manually, then update `docs/test-scenarios.md` to reflect the new
behaviour before moving to the next fix.

---

## FIX-01 · Distinct error for non-existent PR (HTTP 404)

**Problem:** A well-formed URL pointing to a PR that does not exist produces:
> "Could not fetch PR #N from GitHub. Check the URL and your network connection."

The network is fine and the URL format is valid — the PR simply doesn't exist.
The user is sent to debug the wrong thing.

**Current behaviour documented in:** FS-08 S04

**Root cause:** `resolvePrMeta` (`pr.ts:65`) returns `undefined` for 404. `resolvePr`
passes that `undefined` straight through. In `picker.ts:124-126` the single `undefined`
check covers both 404 and genuine network failures, so both get the same generic message.

**Fix:**
1. Add `'not-found'` to the `resolvePr` return type union (it already exists in
   `PrMetaResult` but is collapsed to `undefined` before it leaves `resolvePrMeta`).
2. In `resolvePrMeta` (`pr.ts:65`), instead of `return undefined`, return the string
   sentinel `'not-found'` directly — or change the function signature to propagate it.
3. In `resolvePr`, when `meta === 'not-found'`, return `'not-found'`.
4. In `picker.ts`, add a branch before the generic `undefined` check:
   ```
   if (result === 'not-found') {
     void vscode.window.showErrorMessage(`PR #${prNumber} was not found on GitHub. Check the PR number in the URL.`)
     return undefined
   }
   ```

**Files:** `src/pr.ts`, `src/picker.ts`

**Scenario update:** FS-08 S04 — change expected error message to:
`PR #N was not found on GitHub. Check the PR number in the URL.`

---

## FIX-02 · Distinct error when GitHub auth is cancelled

**Problem:** Cancelling the GitHub sign-in dialog during PR entry produces:
> "Could not fetch PR #N from GitHub. Check the URL and your network connection."

The URL is correct and the network is reachable. The user cancelled auth intentionally.

**Current behaviour documented in:** FS-09 S15

**Root cause:** `resolvePrMeta` wraps `getSession({ createIfNone: true })` in a try/catch
(`pr.ts:70-71`). When the user cancels, VS Code throws and the catch returns `undefined`.
`resolvePr` then returns `undefined`. `picker.ts:124-126` shows the generic error.

**Fix:**
1. Add `'auth-cancelled'` to the `resolvePr` return type union.
2. In `resolvePrMeta`, when the `getSession({ createIfNone: true })` call throws, return
   the sentinel `'auth-cancelled'` rather than `undefined`.
   Change `pr.ts:71`: `} catch { return undefined }` → `} catch { return 'auth-cancelled' }`
3. Propagate `'auth-cancelled'` through `resolvePr` (return it unchanged when `meta ===
   'auth-cancelled'`).
4. In `picker.ts`, add a branch before the generic `undefined` check:
   ```
   if (result === 'auth-cancelled') {
     // User dismissed the sign-in dialog — silent no-op, same as cancelling the picker.
     return undefined
   }
   ```
   No error notification is shown: the user deliberately cancelled, so silence is correct.

**Files:** `src/pr.ts`, `src/picker.ts`

**Scenario update:** FS-09 S15 — update expected behaviour:
- Remove the expected error notification entirely.
- Expected: nothing happens (silent no-op, same as pressing Escape on the picker).
- Note: auth cancellation is now distinguishable from a network failure and is treated as
  a deliberate user cancel, not an error.

---

## FIX-03 · 50-commit picker depth — visible hint in UI

**Problem:** The Commit picker silently shows only the 50 most recent commits. Users who
expect to find an older commit see it missing with no explanation and no guidance on how
to reach it.

**Current behaviour documented in:** FS-02 S05, S05b

**Root cause:** `picker.ts:198` passes `-50` to `git log`. No UI element communicates
this limit.

**Fix:** After building `items` in the `commit` branch (`picker.ts:197-210`), append a
separator whose label communicates the limit:
```typescript
items.push({ label: 'Showing 50 most recent — use Enter ref… to set an older commit', kind: vscode.QuickPickItemKind.Separator })
```
VS Code renders separator labels as greyed section headers. The item is not selectable.
No logic changes required.

**Files:** `src/picker.ts`

**Scenario update:** FS-02 S05 — add to expected behaviour:
- Expected: a greyed footer label at the bottom of the commit list reads
  `Showing 50 most recent — use Enter ref… to set an older commit`.

FS-02 S05b — update note: the truncation is now visible in the UI; the user no longer
needs to discover the limit by noticing a commit is absent.

---

## FIX-04 · Warn on branch/tag name ambiguity in Enter ref…

**Problem:** When both a local branch and a tag share the same short name (e.g. `v1.0`),
typing that name in "Enter ref…" silently picks the branch. The label says `Branch · v1.0`
with no indication the tag was shadowed. The user who typed a tag name gets wrong
merge-base semantics with no feedback.

**Current behaviour documented in:** FS-02 S15

**Root cause:** `detectRefType` (`git.ts:83-88`) checks `refs/heads/` first and returns
`'Branch'` immediately on a match, without checking `refs/tags/`. No caller is aware of
the shadow.

**Fix:** In `detectRefType`, before returning `'Branch'` for a heads match, check whether
a tag with the same name also exists. If both exist, emit a warning notification and still
return `'Branch'` (preserving the existing precedence), but the user is now informed:
```typescript
export async function detectRefType(root: string, ref: string): Promise<'Branch' | 'Tag' | 'Commit'> {
  if (await gitOrNull(root, 'show-ref', '--verify', `refs/heads/${ref}`)) {
    if (await gitOrNull(root, 'show-ref', '--verify', `refs/tags/${ref}`)) {
      void vscode.window.showWarningMessage(
        `"${ref}" matches both a branch and a tag. Treating as branch. Use the Tag… picker to select the tag.`
      )
    }
    return 'Branch'
  }
  if (await gitOrNull(root, 'show-ref', '--verify', `refs/tags/${ref}`))    return 'Tag'
  if (await gitOrNull(root, 'show-ref', '--verify', `refs/remotes/${ref}`)) return 'Branch'
  return 'Commit'
}
```
Note: `detectRefType` is in `git.ts` which currently has no `vscode` import. Add the
import, or move the notification to the call site in `picker.ts` by returning a richer
result type. The call-site approach keeps `git.ts` free of VS Code dependencies.

**Call-site approach (preferred):**
- Change `detectRefType` to return `{ type: 'Branch' | 'Tag' | 'Commit'; shadowed?: 'tag' }`.
- In `picker.ts`, after `await detectRefType(...)`, if `shadowed === 'tag'`, show the
  warning notification before returning the selection.

**Files:** `src/git.ts`, `src/picker.ts`

**Scenario update:** FS-02 S15 — add to expected behaviour:
- Expected: warning notification `"v1.0" matches both a branch and a tag. Treating as
  branch. Use the Tag… picker to select the tag.`
- Expected: label still shows `Branch · v1.0` (precedence unchanged).

---

## FIX-05 · Notify user when PR base diff uses a stale local ref

**Problem:** In "my work vs target" mode, if `origin/<baseRef>` already exists locally,
the extension skips fetching and computes the diff against the potentially stale local
copy. The user receives no indication the base may be out of date relative to the remote.
The diff can be silently misleading.

**Current behaviour documented in:** FS-08 S10

**Root cause:** `pr.ts:105-107` — the fetch is conditional on the ref not existing
locally. When it does exist (the common case after any prior fetch), the block is skipped
entirely with no feedback.

**Fix:** In `resolvePr`, track whether the fetch was skipped. Propagate that flag back
through the return value (or as a property on the returned `BaseSelection`). In
`picker.ts`, when the base-only path completes and the fetch was skipped, show an info
notification:
```
"Diff is against your local origin/<baseRef>. Run git fetch to see the latest base."
```
The notification replaces (or supplements) the existing info notification at `picker.ts:149-152`
that advertises the "PR changes…" alternative.

**Implementation detail:** The simplest approach is to check in `resolvePr` whether the
fetch block ran:
```typescript
let fetched = false
if (!await gitOrNull(root, 'rev-parse', '--verify', localBase)) {
  if (await gitOrNull(root, 'fetch', 'origin', baseRef) === null) return 'fetch-failed'
  fetched = true
}
// ... return selection with a `stale: !fetched` flag
```
Then in `picker.ts`, when `!result.prEnter && result.stale`:
```typescript
void vscode.window.showInformationMessage(
  `Diff is against your local ${localBase} (last fetched). Run git fetch to update.`
)
```

**Files:** `src/pr.ts`, `src/picker.ts`

**Scenario update:** FS-08 S10 — update expected behaviour:
- Expected: info notification `Diff is against your local origin/main (last fetched). Run git fetch to update.`
- Note text: remove the characterisation of this as purely "intentional" and silent. It is
  still intentional (no automatic fetch), but the user is now informed.

---

## FIX-06 · Offer "Stash and Exit" when exiting PR review with dirty tree

**Problem:** When the user tries to exit PR review while having local edits in detached
HEAD, they see:
> "Stash or discard your changes before exiting GitHub PR Review"

There are no buttons — just a warning. The user must manually run `git stash`, re-open
the picker, and select exit again. The extension already knows how to stash (it does it
on entry); it should offer to do so on exit too.

**Current behaviour documented in:** FS-09 S04

**Root cause:** `picker.ts:66-67` — `showWarningMessage` is called with no action buttons
when `exitResult.reason === 'dirty'`.

**Fix:** Add a `'Stash and Exit'` button. When clicked, stash the working-tree changes
and immediately call `exitPr` again:
```typescript
if (exitResult.reason === 'dirty') {
  const action = await vscode.window.showWarningMessage(
    'You have uncommitted changes. Stash them and exit PR review?',
    'Stash and Exit', 'Cancel'
  )
  if (action !== 'Stash and Exit') return undefined
  await gitOrNull(root, 'stash', 'push', '-m', 'gitbase: exit stash')
  // Re-run exit now that tree is clean.
  const retry = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Exiting GitHub PR Review…', cancellable: false },
    () => exitPr(root, prReviewState)
  )
  // Handle retry result (ok/stashPopFailed) with the same logic below.
  ...
}
```
The stash created during "Stash and Exit" is separate from (and on top of) any existing
`gitbase: PR review` stash. Both are in the stash list; the PR-review stash is still
popped by SHA so ordering does not matter.

**Files:** `src/picker.ts`

**Scenario update:** FS-09 S04 — update expected behaviour:
- Expected: warning message `You have uncommitted changes. Stash them and exit PR review?`
  with buttons `Stash and Exit` and `Cancel`.
- Clicking `Stash and Exit`: exits cleanly; any edits made during review are stashed.
- Clicking `Cancel`: no change, still in PR review mode.

---

## FIX-07 · "Already in PR review" — surface at picker level, not as a surprise notification

**Problem:** When the user is already in PR review mode and selects `GitHub PR · PR
changes…` from the picker, the picker closes and then a notification appears:
> "Already in GitHub PR Review. Exit the current review first before starting a new one."

The user clicked an item that appeared selectable, and the result — a dismissible
notification — can be easy to miss. Meanwhile the `← Exit GitHub PR Review` item is
already visible at the top of the same picker, making the `PR changes…` item misleading
by comparison.

**Current behaviour documented in:** FS-09 S12

**Root cause:** `picker.ts:98-103` — the guard fires after the item is selected (picker
already dismissed), then shows a `showWarningMessage`.

**Fix:** When `prReviewState` is active, modify the `GitHub PR · PR changes…` picker item
before it is shown to communicate that it is not available:

```typescript
{
  label: isDirty ? 'GitHub PR · PR changes… (will stash)' : 'GitHub PR · PR changes…',
  description: prReviewState ? 'exit current review first' : 'compare PR to its base',
  key: 'pr-review'
}
```

Keep the guard at `picker.ts:98` as a safety net, but the user now sees the constraint
before selecting the item, and can immediately select `← Exit GitHub PR Review` above it.
The post-selection warning notification is still shown (as the guard fires) but is now
redundant reinforcement rather than the primary signal.

**Files:** `src/picker.ts`

**Scenario update:** FS-09 S12 — add to expected behaviour (before selecting the item):
- Expected: `GitHub PR · PR changes…` item shows description `exit current review first`
  while in PR review mode.
- Expected: warning notification still appears after selection (guard retained as safety
  net), but the user has already seen the constraint inline.

---

## Out of scope — known VS Code limitations

The following issues were identified but cannot be fixed in this extension's code. They
are documented here for completeness.

### Git panel button flicker (FS-05 S10)
`assertScmContext()` in `workarounds.ts` temporarily evicts VS Code's SCM context keys
after every GitBase refresh, briefly hiding git's Stage/Discard buttons. This is a
side-effect of Workaround C, which is itself fixing a VS Code SCM context-key staleness
bug. No VS Code API exists to target context-key eviction to a specific provider.
**Action:** keep as documented; set `WORKAROUND_STALE_SCM_CONTEXT = false` to reproduce.

### Double badge for `git rm --cached` / stage-then-revert (FS-05 S06)
When the working tree matches HEAD but the index differs from the base, both the git
extension and GitBase register a `FileDecoration` under the same plain `file:` URI,
causing a stacked double badge in Explorer. No VS Code API exists to clear a specific
provider's decoration for a given URI.
**Action:** keep as documented in `docs/bug-vscode-file-decoration-badge-stacking.md`.

### Last-writer-wins for same repo in two VS Code windows (FS-06 S07)
Two VS Code windows on the same folder share `workspaceState` storage. The last write
wins on reload. This is a VS Code architecture constraint; `workspaceState` has no
per-window isolation.
**Action:** keep as documented; behaviour is predictable once understood.
