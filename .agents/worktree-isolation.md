# Agent worktree isolation

Read this file before creating or using an agent worktree. Paths are relative to the repository's main checkout, whose `.git` directory all linked worktrees share.

Claude Code agents create worktrees only under `.claude/worktrees/`. Codex agents create worktrees only under `.codex/worktrees/`. Both directories are ignored. Tracked agents, skills, and configuration elsewhere under `.claude/` and `.codex/` stay tracked.

Each writer creates and owns its worktree from fresh `origin/main`, then uses the assigned base for implementation. Never edit, stage, stash, reset, switch branches, install, or build in the human checkout. Never add, remove, prune, move, or edit a worktree under the other tool's directory or a worktree you did not create. This includes its registration in the shared worktree registry and its checked-out branch. Read-only inspection is allowed. A delegated agent that did not create the worktree returns any required mutation commands to its creator to execute.

Before creating a branch or checking one out, inspect the worktree registry. If the target branch is already checked out in another worktree, from either tool, stop and report that worktree's path. Never force the checkout, delete the worktree or branch, or rename either to bypass the conflict. Never move another worktree's branch through a rebase or stack command.

Install each worktree's own `node_modules` with `npm ci` inside that worktree when Node dependencies are needed. Never share or symlink dependency installs from the human checkout, another worktree, or the other tool. If your worktree holds changes you did not make, stop and report them instead of committing or discarding them.
