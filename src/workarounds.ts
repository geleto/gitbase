import * as vscode from 'vscode'

/**
 * Workaround flags for known VS Code bugs.
 *
 * Each flag is documented with the bug it works around, the fix applied, and
 * how to disable it for reproduction purposes.  See docs/ for full bug reports.
 */

/**
 * WORKAROUND A: VS Code SCM inline-button cache contamination.
 *
 * The VS Code SCM tree view caches the computed inline action buttons per
 * resource URI.  When the same file appears in both the native git SCM panel
 * and the GitBase panel (e.g. a file modified in the working tree but whose
 * base-relative diff is also tracked by GitBase), the git panel writes its
 * Stage / Discard / Unstage buttons into the cache under the plain file URI.
 * GitBase then renders its copy of that resource with the SAME URI and picks
 * up git's cached button set instead of its own.
 *
 * Fix: give GitBase resource states a URI with a `#gitbase` fragment.  The
 * fragment is invisible in the SCM label (VS Code uses `fsPath`, which strips
 * fragments, for display) but produces a distinct cache key, so GitBase always
 * gets a fresh, uncontaminated button set.
 *
 * Side-effect: none known.  Set to `false` to revert to plain file URIs.
 * See: docs/bug-vscode-scm-button-cache-contamination.md
 */
export const WORKAROUND_URI_FRAGMENT = true

/**
 * WORKAROUND B: Explorer double-badge when a file appears in both panels.
 *
 * VS Code stacks FileDecoration badges from all registered providers for the
 * same URI.  A file that is modified in the working tree (and therefore also
 * decorated by the git extension under its plain `file:` URI) would receive
 * two overlapping badges — e.g. "M, M" — in the Explorer.
 *
 * Fix: skip registering the plain-URI FileDecoration for files that are
 * already dirty relative to HEAD (i.e. files the git extension will decorate).
 * GitBase's SCM-panel badge is unaffected because it uses the `#gitbase`
 * fragment URI (WORKAROUND_URI_FRAGMENT) which the git extension never touches.
 *
 * Set to `false` to always register the plain-URI decoration (causes double
 * badges in the Explorer for files in both panels).
 * See: docs/bug-vscode-file-decoration-badge-stacking.md
 */
export const WORKAROUND_DOUBLE_BADGE = true

/**
 * WORKAROUND C: VS Code stale SCM context keys.
 *
 * VS Code does not always flush `scmProvider` / `scmResourceGroup` context
 * keys when focus moves between SCM providers.  Workaround A above is the
 * primary fix; this secondary workaround re-asserts our context keys in the
 * specific code paths where staleness is observable (deleted-ref recovery and
 * the null-diff edge case).
 *
 * Previously, `assertScmContext()` was also called on every periodic refresh
 * (~every 400 ms), which caused git-panel inline buttons (Stage / Discard) to
 * disappear on every hover while both SCM panels were visible.  That call site
 * has been removed; the assertion now only fires on the two edge-case paths
 * where the context genuinely needs to be re-established.
 *
 * Known side-effect: git extension inline buttons may still disappear briefly
 * in those edge cases (deleted-ref recovery, unborn repo), which is acceptable.
 * Set to `false` to disable all assertions.
 * See: docs/bug-vscode-scm-button-cache-contamination.md (secondary mitigation)
 */
export const WORKAROUND_STALE_SCM_CONTEXT = true

/**
 * Re-assert our SCM context keys to evict stale values left by the git
 * provider.  Call after every refresh.  See WORKAROUND_STALE_SCM_CONTEXT.
 */
export function assertScmContext(): void {
  if (!WORKAROUND_STALE_SCM_CONTEXT) return
  void vscode.commands.executeCommand('setContext', 'scmProvider',      'taskchanges')
  void vscode.commands.executeCommand('setContext', 'scmResourceGroup', 'changes')
}

/**
 * WORKAROUND D: scm.autoReveal / git panel expansion on file open.
 *
 * When a file is opened from our panel, VS Code's `scm.autoReveal` and the
 * git extension's own `onDidChangeActiveTextEditor` handler both look for the
 * newly active file in every SCM provider and expand/select it there.  Because
 * the git provider registers first, files that also appear in "Staged Changes"
 * would cause that group to expand and steal focus from GitBase.
 *
 * Fix: call `workbench.view.scm` before opening the document.  This asserts
 * our provider as the focused SCM so that both reveal mechanisms target our
 * panel (where the file is already visible) instead of git's Staged Changes.
 */
export async function openWithoutAutoReveal(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('workbench.view.scm')
  await vscode.window.showTextDocument(uri)
}
