# VS Code bug: SCM inline-button cache contamination across providers

**Status:** Worked around in GitBase (`WORKAROUND_URI_FRAGMENT = true`)
**Affects:** VS Code SCM panel, multiple SCM providers open simultaneously
**Workaround:** Give each provider's `resourceUri` a unique URI fragment

---

## Summary

When two SCM providers (e.g. the built-in `vscode.git` extension and a
third-party provider like GitBase) both track the same file, the VS Code SCM
tree view reuses the inline-action button set that was computed for the file
under the *git* provider's resource entry and applies it, unchanged, to the
third-party provider's entry for the same file.  The result is that completely
wrong buttons — Stage Changes, Discard Changes, Unstage — appear on the
third-party provider's resources.

---

## Environment

- VS Code version: **1.96.x** (confirmed with the `0870c2a0c7` app bundle)
- OS: Windows 11
- Extensions: `vscode.git` (built-in), GitBase (this extension)

---

## Steps to reproduce

> **Prerequisite:** in `src/extension.ts` set `WORKAROUND_URI_FRAGMENT = false`
> and recompile, so the workaround does not mask the bug.

1. Open a git repository that has at least one file modified in the working
   tree **and** one file that differs from an earlier base commit (so the file
   appears in *both* the git provider's "Changes" group and the GitBase
   provider's group).
2. Alternatively, have a file in the git "Staged Changes" group that also
   appears in GitBase.
3. In the Source Control panel, expand both providers.
4. Hover over any file in the **GitBase** panel that is also present in the
   git panel.

**Expected:** The GitBase row shows only the GitBase inline buttons (Open
File).

**Actual:** The GitBase row shows the git extension's inline buttons:

- If the file is in git's *Staged Changes* (`index` group): **Open File** +
  **Unstage** buttons appear on the GitBase resource.
- If the file is in git's *Changes* (`workingTree` group): **Open File** +
  **Stage Changes** + **Discard Changes** buttons appear on the GitBase
  resource.

The pattern is exact: the number and type of buttons on GitBase resources
match one-for-one the buttons on the same files in the git panel.

---

## Root cause

VS Code's SCM tree view renderer caches the computed set of inline action
buttons keyed by `resourceUri.toString()`.  The git extension writes its
button set into the cache under the plain `file:` URI
(`file:///c:/path/to/file.ts`).  Because GitBase uses the **same** plain
`file:` URI as its `SourceControlResourceState.resourceUri`, the renderer
finds the cached entry from the git extension and renders those buttons on the
GitBase row without re-evaluating the `when` clauses for the new provider
context.

The `when` clauses on the git extension's menu contributions correctly guard
against cross-provider display:

```json
"when": "scmProvider == git && scmResourceGroup == workingTree"
```

However, because the cache lookup happens *before* `when` clause evaluation
for the current resource, the stale cached buttons are displayed regardless.

---

## Impact

- Clicking the **Stage Changes** button from the GitBase panel on a file that
  is already clean relative to HEAD will attempt to stage non-existent
  changes (the git command fails silently or shows an error).
- Clicking **Discard Changes** similarly targets git's working tree, not the
  GitBase diff, and fails silently for committed files.
- The **Unstage** button similarly has no effect for files not in git's index.
- In all cases the buttons are functionally harmless for files that are
  committed (not in git's working tree), but they are visually confusing and
  misleading.

---

## Workaround applied in GitBase

A `#gitbase` fragment is appended to the `file:` URI used as `resourceUri`
for every `SourceControlResourceState` created by GitBase:

```typescript
const resourceUri = workUri.with({ fragment: 'gitbase' })
// → file:///c:/path/to/file.ts#gitbase
```

`vscode.Uri.fsPath` ignores the fragment, so the SCM panel still displays the
correct relative file path.  The fragment makes the URI string distinct from
the git extension's plain URI, so the renderer finds no cached entry and
computes a fresh button set that correctly reflects the GitBase provider's
`when` conditions.

The `openFile` command handler strips the fragment before calling
`vscode.commands.executeCommand('vscode.open', ...)` so the real file is
opened:

```typescript
const uri = vscode.Uri.from(resource.resourceUri).with({ fragment: '' })
```

The `FileDecorationProvider` registers decorations for **both** the fragment
URI (for the SCM panel badge) and the plain URI (for the Explorer badge).

---

## Suggested VS Code fix

The renderer should not use the cached button set when the current resource
belongs to a different SCM provider than the one that wrote the cache entry.
The cache key should include the SCM provider ID (e.g.
`${scmProviderId}::${resourceUri.toString()}`) so that two providers tracking
the same file each get an independent, correctly evaluated button set.
