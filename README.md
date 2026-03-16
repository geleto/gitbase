# gitbase

A VSCode extension that shows working-tree changes in the Source Control panel relative to a selected Git branch, commit, or tag, presented just like the familiar Changes and Staged Changes views, so the entire task remains visible across multiple commits.

---

## The Problem

The built-in git panel shows changes relative to `HEAD` — the last commit. Once you commit, those changes disappear from view, even if they are all part of the same task or feature.

**gitbase** solves this by letting you pin any branch, commit, tag, or GitHub Pull Request as a *base*, and then showing every change your working tree has accumulated since that base — continuously, as you edit.

---

## Features

- **Familiar SCM panel** — changes appear in a dedicated *GitBase Changes* group in the Source Control panel, using the same look and inline actions as the native git Changes view
- **Any base ref** — pick a local branch, remote branch, tag, commit hash, or enter any git ref manually
- **Merge-base diffing** — when diffing against a branch, gitbase computes the merge-base automatically, so you only see *your* changes, not commits that have landed on the base branch since you branched off
- **GitHub PR integration** — paste a GitHub PR URL to review the PR changes in your working tree, or to compare your current branch against the PR's target branch
- **Diff views with blame** — clicking a changed file opens a side-by-side diff; the base side shows inline blame annotations (author, date, commit subject) in the gutter
- **Explorer & editor integration** — right-click any changed file to open its diff or copy a patch
- **Multi-root workspace support** — each repository maintains its own independent base selection

---

## Getting Started

1. Open the **Source Control** panel (`Ctrl+Shift+G`).
2. Find the **GitBase Changes** group and click the branch icon (or click the status bar item) to run **Select Base…**.
3. Pick a branch, tag, commit, or PR. All changes since that base appear immediately.

From this point on the list updates automatically as you edit, stage, commit, or switch branches.

---

## Selecting a Base

The **Select Base…** quick-pick offers several categories:

| Category | What it shows |
|---|---|
| **Default branch** | `main`, `master`, or the repo's configured upstream default — one-click to pick the most common base |
| **Branches** | All local and remote branches |
| **Tags** | All tags in the repository |
| **Recent commits** | The 50 most recent commits on the current branch |
| **Enter a ref** | Free-text input for any git ref (SHA, `HEAD~5`, `v2.0^`, etc.) |
| **GitHub PR** | Paste a `https://github.com/…/pull/NNN` URL — the picker then asks which of two modes to use (see below) |

The selected base is saved per repository and restored across sessions.

---

## GitHub PR Integration

After entering a PR URL the base selector asks which mode to use:

**PR changes** — For reviewing someone else's PR. gitbase stashes any uncommitted work, checks out the PR commit in detached HEAD mode, and shows the PR's changes against its target branch. When you select a different base, your original branch and stash are restored. Avoid committing while in this mode — any commits made on the detached HEAD will be warned about on exit.

**My work vs target** — Non-destructive. Stays on your current branch and shows how it differs from the PR's target branch. Useful when you are the PR author and want to track your accumulated changes.

GitHub authentication uses VSCode's built-in GitHub sign-in. No tokens to manage.

---

## Commands

| Command | Description |
|---|---|
| **Select Base…** | Open the base picker |
| **Refresh** | Force-refresh the change list |
| **Open Diff Against Base** | Open a side-by-side diff for the selected file |
| **Copy Changes (Patch)** | Copy the file's diff as a unified patch |

**Open Diff Against Base** and **Copy Changes (Patch)** also appear in the Explorer right-click menu and editor title bar for any file that has changes relative to the base.

---

## Diff Views & Blame

Clicking a changed file opens a side-by-side diff. The left pane shows the file at the base ref; the right pane shows the current working-tree version.

The left (base) pane displays **inline blame annotations** in the gutter:

```
a3f8c12  2024-11-04  Jane Doe  •  fix: handle null response
```

Hovering a blame entry shows the full commit details.

---

## File History Timeline

> ⚠️ **This feature does not work out of the box.** VSCode restricts proposed APIs to extensions that are explicitly trusted at launch. Without the flag below, the GitBase History section will simply not appear in the Timeline panel — no error, no indication why.

**To enable the timeline**, launch VSCode from the terminal with:

```
code --enable-proposed-api gitbase.gitbase
```

You must pass this flag every time VSCode starts. A shell alias or a wrapper script is the most practical way to handle this:

```bash
# ~/.bashrc or ~/.zshrc
alias code='code --enable-proposed-api gitbase.gitbase'
```

Once enabled, open any file and expand the **Timeline** panel at the bottom of the Explorer sidebar. A **GitBase History** section lists commits that touched the file, 50 at a time, with author, date, and subject. Clicking an entry opens a diff between that commit and its parent.

---

## Requirements

- **VSCode** 1.85.0 or later
- **Git** installed and on `PATH`
- (Optional) A GitHub account signed in to VSCode for PR integration
