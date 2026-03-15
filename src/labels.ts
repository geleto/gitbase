import * as vscode from 'vscode'

/**
 * Register a ResourceLabelFormatter for the basegit: scheme.
 *
 * URI structure:  basegit:/<file-path>?<encoded-query>#<label-suffix>
 * The URI fragment carries a short context string (e.g. "Deleted", "since main")
 * which VS Code appends parenthetically in editor tab titles and the Open Editors panel.
 *
 * DISABLED: registerResourceLabelFormatter is gated behind the "resolvers" proposed API.
 * Extensions must declare it in package.json#enabledApiProposals and run with
 * --enable-proposed-api, which blocks marketplace publishing.
 *
 * TODO: set LABEL_FORMATTER_ENABLED = true once VS Code stabilises this API and
 * registerResourceLabelFormatter is available without the proposed-API flag.
 */
const LABEL_FORMATTER_ENABLED = false

/**
 * Returns the title to pass to `vscode.diff`.
 * When the formatter is enabled VS Code derives the tab label from the basegit: URI fragment,
 * so an explicit title must not be provided (passing undefined lets the formatter take over).
 */
export function diffTitle(filename: string, shortSuffix: string): string | undefined {
  return LABEL_FORMATTER_ENABLED ? undefined : `${filename} (${shortSuffix})`
}

/**
 * Returns the fragment to embed in a basegit: URI.
 * When the formatter is enabled this becomes the parenthetical context shown in the tab label/tooltip.
 * When disabled the fragment is invisible; a minimal string is returned for URI distinctness only.
 */
export function baseFragment(
  type: 'Branch' | 'Tag' | 'Commit' | 'PR' | undefined,
  ref: string,
  label: string,
  comparison: string,
): string {
  if (!LABEL_FORMATTER_ENABLED) return comparison
  if (type === 'Commit') return `Commit · ${ref} · ${comparison}`
  if (type === 'PR')     return comparison === 'Deleted' ? `${label} · Deleted` : label
  return `${type ?? 'Ref'} · ${label} · ${comparison}`
}

export function registerLabelFormatter(ctx: vscode.ExtensionContext): void {
  if (!LABEL_FORMATTER_ENABLED) return

  // registerResourceLabelFormatter is not yet in stable typings — cast via any.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reg = (vscode.workspace as any).registerResourceLabelFormatter
  if (typeof reg !== 'function') return
  ctx.subscriptions.push(
    reg.call(vscode.workspace, {
      scheme: 'basegit',
      formatting: {
        label:                      '${path} (${fragment})',
        separator:                  '/',
        stripPathStartingSeparator: true,
      },
    })
  )
}
