# Generate a GitBase Test Prompt from a Combined Test Plan

## Purpose

This file is itself a prompt. Open it in a Claude Code session and provide a combined test plan file (from `docs/test-plans/`) as context. Claude will generate a ready-to-use interactive test prompt and write it to `docs/test-prompts/` using the same base filename.

**Usage:**

```
Open this file in Claude Code, then say:
  "Generate a test prompt from docs/test-plans/combined-01-normal-operation.md"
```

Claude will read the plan, generate the prompt, and write it to:
`docs/test-prompts/combined-01-normal-operation.md`

---

## What a Test Plan Is

Test plans live in `docs/test-plans/`. They are human-maintained, structured documents that describe grouped test scenarios optimised for execution efficiency. Each plan:

- Covers multiple feature sets from `docs/test-scenarios.md`
- Groups scenarios that share git state, so Claude sets up state once and the user acts on it multiple times
- Preserves full scenario detail, including source IDs (e.g. `FS-02 S01`), git commands, expected outcomes, and reset steps
- Is the **source of truth** — prompts are derived from plans, not vice versa

When a scenario changes in `test-scenarios.md`, the corresponding test plan is updated, then the prompt is regenerated from the plan.

---

## What a Test Prompt Is

Test prompts live in `docs/test-prompts/`. They are **executable**: a tester opens one in a Claude Code session and Claude actively runs git commands, prints instructions, waits for the user to perform VS Code UI actions, checks results, and guides the tester step by step to completion.

A prompt is not a reference document. It is a script Claude follows interactively.

---

## Hard Rules That Must Be in Every Generated Prompt

Include the following block verbatim near the top of every generated prompt, after the prerequisites section:

```
> **Hard rule: Claude cannot interact with the VS Code UI.**
> Every click, menu selection, keyboard shortcut, and visual observation is a [User] step.
> Every git command, file system operation, and workspaceState inspection is a [Claude] step.
> Claude must never say "open picker", "click", "reload window", "add folder", or any UI action in a [Claude] step.
> Claude must wait for the user to report the result of each [User] step before proceeding.
```

---

## Step Notation

Use exactly these prefixes in the generated prompt — no others:

| Prefix | Who acts | What it means |
|--------|----------|---------------|
| `[Claude]` | Claude | Runs a shell or git command in the terminal and reports the output |
| `[User]` | Tester | Performs a VS Code UI action and reports what they see |
| `[Check]` | Claude | Runs a verification command and compares output to the expected value; reports pass or fail |
| `[Reset]` | Claude (or User if UI needed) | Restores state before the next scenario |

---

## Structure of a Generated Prompt

```
# <Plan Title> — GitBase Interactive Test

## Prerequisites
<What must already exist: test repo path, extension installed, VS Code open>

## Hard Rule
<Insert the hard rule block verbatim>

## Overview
<One paragraph: what this prompt covers, which feature sets, estimated number of user interactions>

---

## Section N: <Section Name>

### Checkpoint N.M — <Scenario short name> (`FS-XX SYY[, FS-XX SYY]`)

**Purpose:** <One sentence: what this checkpoint verifies>

**Precondition:** <State required before this checkpoint>

<Interleaved [Claude] / [User] / [Check] / [Reset] steps in execution order>

---
```

Each **checkpoint** corresponds to one scenario or a tightly-merged group of scenarios. The source IDs (e.g. `FS-02 S01`) appear in the checkpoint heading so the tester can cross-reference `docs/test-scenarios.md` if needed.

---

## Rules for Generating Checkpoints from Plan Sections

1. **One checkpoint per scenario** by default. Merge into a single checkpoint only when scenarios share an identical user action and the observations can be made simultaneously (e.g. observing the label AND verifying workspaceState in one picker open).

2. **All [Claude] setup steps for a section come before the first [User] step of that section**, unless a Claude step depends on user-reported state. Never make the user wait while Claude runs unrelated commands mid-section.

3. **Every [User] step must be followed by either a [Check] step or explicit instruction to proceed.** Never leave the user hanging after a UI action.

4. **Every expected outcome must be stated explicitly** before the user performs the action, so the user knows what to look for. Use the format:
   ```
   [User] <action>
   Expected: <what the user should see>
   ```

5. **[Check] steps must include the exact command and the exact expected output.** If the output is variable (e.g. a SHA), describe what form it should take. Example:
   ```
   [Check] git rev-parse HEAD
   Expected: a 40-character hex SHA (note this value for later)
   ```

6. **[Reset] steps must leave the repo in a state that the next checkpoint's precondition is satisfied.** State explicitly what the post-reset state is.

7. **Preserve all Notes from the source plan.** Notes explain why the expected behaviour is what it is. Include them as-is, indented under the step they apply to.

8. **Excluded scenarios** listed in the plan must not appear in the generated prompt. Do not reference them.

9. **Do not invent steps or commands** not present in the source plan. If the plan is ambiguous, copy the exact language from `docs/test-scenarios.md` for that scenario.

10. **End the prompt with a Teardown section** that restores the repo to the state described in the plan's teardown, ready for the next test plan.

---

## How to Invoke This

When the user says "generate a test prompt from `docs/test-plans/<filename>.md`":

1. Read the specified test plan file in full.
2. Read `docs/test-scenarios.md` to resolve any scenario references that need more detail.
3. Generate the prompt following all rules above.
4. Write it to `docs/test-prompts/<same-filename>.md`.
5. Report the number of checkpoints generated and any ambiguities you encountered.
