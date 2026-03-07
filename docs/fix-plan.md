# GitBase Fix Plan

Each step is self-contained: fix the code, compile, run the affected scenarios, then update
`docs/test-scenarios.md` to reflect the new correct behaviour before moving on.

Steps are ordered by severity — genuine bugs first, UX improvements after.

---

## Step 1 — Block nested PR review entry

**Problem (FS-09 S12):** When the user is already in PR review mode (HEAD is detached),
selecting `GitHub PR · PR changes…` again stores `prevBranch = 'HEAD'`. Exit then calls
`git checkout HEAD`, which is a no-op, leaving the user stranded on the PR's SHA with the
prReviewState cleared and no way back.

**File:** `src/picker.ts`

**Change:** At the top of the `pr-review` branch (around line 97, just before the `prUrl`
input box), add a guard that detects an already-active `prReviewState` and blocks entry with
an informational message:

```typescript
if (typeItem.key === 'pr-review') {
  if (prReviewState) {
    void vscode.window.showWarningMessage(
      'Already in GitHub PR Review. Exit the current review first before starting a new one.',
    )
    return undefined
  }
  // ... existing pr-review flow
}
```

**test-scenarios.md update — FS-09 S12:**
Rewrite the scenario. The new expected behaviour is:
- `[User]` selects `GitHub PR · PR changes…` while already in PR review mode.
- Expected: warning notification `Already in GitHub PR Review. Exit the current review first
  before starting a new one.`
- Expected: HEAD unchanged, prReviewState unchanged, `← Exit GitHub PR Review` still present.
- Remove all notes about `prevBranch = 'HEAD'` and the no-op exit; they no longer apply.

---

## Step 2 — Nested repo provider resolution uses longest-match

**Problem (FS-07 S07b):** `resolveProviderForResource` iterates providers in Map-insertion
order and returns the first whose root is a path prefix of the file URI. If repo A is at
`/project` and repo B at `/project/packages/lib`, repo A always wins for repo B's files
because it was inserted first and its prefix matches.

**File:** `src/extension.ts`

**Change:** In `resolveProviderForResource` (lines 79–84), sort candidates by root-path
length descending before the `find()`, so the most-specific (deepest) repo always wins:

```typescript
function resolveProviderForResource(uri: vscode.Uri): TaskChangesProvider | undefined {
  return [...providers.values()]
    .sort((a, b) => (b.scm.rootUri?.fsPath.length ?? 0) - (a.scm.rootUri?.fsPath.length ?? 0))
    .find(p => {
      const root = p.scm.rootUri?.fsPath
      return root && (uri.fsPath === root || uri.fsPath.startsWith(root + nodePath.sep))
    })
}
```

**test-scenarios.md update — FS-07 S07b:**
Change the expected outcome from "may be computed relative to repo A's root" to:
- Expected: path is computed relative to repo B's root (the most-specific provider wins
  regardless of insertion order).
- Remove the "known limitation" framing and the note about insertion order.
- The `Copy Changes (Patch)` note can also be updated: both commands now resolve correctly
  for nested repos.

---

## Step 3 — Distinguish HTTP 404 (not found) from HTTP 401 (auth required)

**Problem (FS-08 S04):** `fetchPrMeta` maps both HTTP 401 and HTTP 404 to `'auth-required'`.
So entering a URL for a non-existent PR causes VS Code to prompt for GitHub sign-in
unnecessarily. The sign-in prompt is confusing because the error is "PR doesn't exist", not
"you're not authenticated".

**File:** `src/pr.ts`

**Change:** Add a distinct sentinel for "not found" and let `resolvePrMeta` treat it
immediately as a hard failure without prompting for auth:

```typescript
type PrMetaResult = { baseRef: string; headSha: string } | 'auth-required' | 'not-found' | undefined

// In fetchPrMeta:
if (res.statusCode === 401) { res.resume(); resolve('auth-required'); return }
if (res.statusCode === 404) { res.resume(); resolve('not-found');     return }

// In resolvePrMeta:
if (result === 'not-found') return undefined   // hard stop — no auth retry
if (result === 'auth-required') {
  // ... existing createIfNone: true auth-retry logic
}
```

**test-scenarios.md update — FS-08 S04:**
Replace the two-case note (signed-in vs not signed-in) with a single path:
- Expected: error message `Could not fetch PR #N from GitHub. Check the URL and your network
  connection.` is shown immediately, with no sign-in prompt, regardless of auth state.
- Remove the note about 404 and 401 being treated identically.

---

## Step 4 — Preserve staging state on stash pop

**Problem (FS-09 S02c):** `popStashBySha` calls `git stash pop` without `--index`. Git
applies all stashed content (including what was staged) into the working tree as unstaged
changes, silently losing the user's staging intent.

**File:** `src/pr.ts`

**Change:** Add `--index` to the pop command in `popStashBySha` (line 83):

```typescript
return await gitOrNull(root, 'stash', 'pop', '--index', `stash@{${idx}}`) !== null
```

**test-scenarios.md update — FS-09 S02c:**
Change the expected outcome for the post-exit `git status` check:
- Expected: the previously-staged change is in the **index** (staged), NOT in the working
  tree only.
- Remove the note explaining that staging state is lost and why.

---

## Step 5 — Fail fast when base-branch fetch fails

**Problem (FS-08 S11):** When `origin/<baseRef>` doesn't exist locally and the fetch fails,
`resolvePr` silently ignores the failure and returns the ref anyway. The picker closes with a
success label, then ~400ms later the provider detects the ref is missing and shows a
"no longer exists" warning. This looks like a success followed by an immediate unexplained
failure.

**File:** `src/pr.ts`

**Change:** Check the fetch result and return a new error sentinel if it fails
(around lines 104–106):

```typescript
if (!await gitOrNull(root, 'rev-parse', '--verify', localBase)) {
  const fetched = await gitOrNull(root, 'fetch', 'origin', baseRef)
  if (fetched === null) return 'fetch-failed'
}
```

Add `'fetch-failed'` to the return type of `resolvePr` and handle it in `picker.ts` with a
specific error message:

```typescript
if (result === 'fetch-failed') {
  void vscode.window.showErrorMessage(
    `Could not fetch base branch "${baseRef}" from origin. Check your network connection.`
  )
  return undefined
}
```

**test-scenarios.md update — FS-08 S11:**
Change the expected behaviour:
- Expected: the picker does NOT close with a success label. Instead, an error notification
  `Could not fetch base branch "..." from origin. Check your network connection.` appears
  immediately.
- Expected: stored base is unchanged (no label update, no deferred missing-base warning).
- Remove the two-step "success then failure" description entirely.

---

## Step 6 — Classify remote branches correctly in `detectRefType`

**Problem (FS-02 S13):** `detectRefType` checks `refs/heads/<ref>` then `refs/tags/<ref>`
only. A remote branch like `origin/feature/alpha` falls through to `'Commit'`, so typing it
in "Enter ref…" produces type `Commit` and skips merge-base logic. The diff is tip-to-tip
instead of fork-point-to-HEAD.

**File:** `src/git.ts`

**Change:** Add a `refs/remotes/` check before the fallthrough (lines 83–87):

```typescript
export async function detectRefType(root: string, ref: string): Promise<'Branch' | 'Tag' | 'Commit'> {
  if (await gitOrNull(root, 'show-ref', '--verify', `refs/heads/${ref}`))   return 'Branch'
  if (await gitOrNull(root, 'show-ref', '--verify', `refs/tags/${ref}`))    return 'Tag'
  if (await gitOrNull(root, 'show-ref', '--verify', `refs/remotes/${ref}`)) return 'Branch'
  return 'Commit'
}
```

**test-scenarios.md update — FS-02 S13:**
Change the expected outcome:
- Expected label: `Branch · origin/feature/alpha` (not `Commit · …`)
- Expected stored type: `Branch`
- Expected: merge-base logic applies (same as selecting from Branch… picker)
- Remove the "known limitation" note and the advice to use the Branch… picker instead.

---

## Step 7 — Freeze tag refs from "Enter ref…" to SHA

**Problem (FS-02 S07b):** The `Tag…` picker stores the resolved SHA (frozen). "Enter ref…"
with a tag name stores the symbolic string. If the tag is later deleted, the symbolic ref
breaks and triggers auto-recovery. Users who type a tag name have no reason to expect
different durability than using the picker.

**File:** `src/picker.ts`

**Change:** In the final ref/type derivation block (around line 214), when the detected type
is `'Tag'` and the flow came from the `'ref'` key (Enter ref…), store the resolved SHA
instead of the typed name:

```typescript
const type = typeItem.key === 'branch' ? 'Branch'
           : typeItem.key === 'tag'    ? 'Tag'
           : typeItem.key === 'commit' ? 'Commit'
           : await detectRefType(root, newRef)

// Freeze tags to SHA regardless of how they were entered, so deletion doesn't break the base.
const ref = (typeItem.key === 'branch')                           ? newRef   // symbolic: tracks tip
          : (typeItem.key === 'ref' && type !== 'Tag')            ? newRef   // branch/commit: as typed
          : resolved                                                          // tag or Tag… picker: frozen
```

**test-scenarios.md update — FS-02 S07b:**
Change the expected behaviour:
- Expected: stored ref is the resolved SHA (same as using the `Tag…` picker).
- Remove the comparison between symbolic vs frozen behaviour and the note about the deletion
  failure mode.
- The note explaining that `Tag…` and `Enter ref…` differ can be removed.

---

## Step 8 — Informative message when base content is unavailable

**Problem (FS-04 S14):** When `git show <ref>:<path>` fails because the file didn't exist at
the base ref, the diff editor shows a blank left side with no explanation. Users can't tell
whether the diff is correct or broken.

**File:** `src/content.ts`

**Change:** Replace the `?? ''` fallbacks with a comment string when `git show` fails and the
ref is not a SHA-based merge-base (i.e., the path genuinely didn't exist at that point):

```typescript
const raw = await gitOrNull(root, 'show', `${ref}:${fp}`)
const content = raw ?? `(file did not exist at ${isSha(ref) ? ref.slice(0, 8) : ref})`
```

Apply the same change to both the SHA-cache and branch-cache paths.

**test-scenarios.md update — FS-04 S14:**
Change the expected outcome:
- Expected: left side of diff editor shows the single line
  `(file did not exist at <ref>)` rather than a blank document.
- Update the note at `content.ts:49` and `content.ts:60` references accordingly.

---

## Non-fixable items (document-only updates)

The following issues are caused by VS Code API limitations and cannot be fixed in the
extension. Their test-scenarios.md entries are already accurate, but the framing can be
improved to make the limitation clearer to testers.

### FS-04 S03 — `openWithoutAutoReveal` temporarily mutates a global setting
The `scm.autoReveal` mutation is the only available mechanism; there is no VS Code API to
suppress auto-reveal for a single open call. The workaround comment in `workarounds.ts` is
accurate. No code change possible; scenario text is correct as-is.

### FS-05 S10 — Git panel buttons flicker after GitBase refresh
`assertScmContext()` is required to fix a different (more severe) VS Code bug. The flicker is
an unavoidable side-effect. Scenario text is correct as-is.

### FS-06 S07 — Last-writer-wins for same folder in two windows
VS Code's `workspaceState` is per-workspace storage shared across all windows on the same
folder. There is no cross-window locking mechanism. Scenario text is correct as-is.

### FS-08 S10 — Stale local base branch used without re-fetching
This is intentional for offline/performance reasons. Scenario text is correct as-is; the note
explaining the rationale is sufficient.
