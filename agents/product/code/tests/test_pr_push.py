from __future__ import annotations

import os
import shlex
import shutil
import subprocess
from pathlib import Path

RUNNER = Path(__file__).resolve().parents[1] / "scripts" / "code_agent.sh"


def test_pr_push_preserves_concurrent_remote_commit_after_fetch(tmp_path: Path) -> None:
    git_executable = shutil.which("git")
    assert git_executable is not None
    env = dict(os.environ)
    env.update(
        GIT_CONFIG_GLOBAL=os.devnull,
        GIT_CONFIG_NOSYSTEM="1",
        GIT_AUTHOR_NAME="Push Test",
        GIT_AUTHOR_EMAIL="push-test@example.invalid",
        GIT_COMMITTER_NAME="Push Test",
        GIT_COMMITTER_EMAIL="push-test@example.invalid",
    )

    def git(directory: Path, *args: str) -> str:
        return subprocess.check_output(
            [git_executable, "-C", str(directory), *args],
            env=env,
            text=True,
            stderr=subprocess.PIPE,
        ).strip()

    def push(directory: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["/bin/bash", "-c", f"source {shlex.quote(str(RUNNER))}; push_branch_for_pr feature"],
            cwd=directory,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    remote = tmp_path / "remote.git"
    runner = tmp_path / "runner"
    collaborator = tmp_path / "collaborator"
    git(tmp_path, "init", "--bare", str(remote))
    git(tmp_path, "clone", str(remote), str(runner))
    git(runner, "checkout", "-b", "feature")
    git(runner, "commit", "--allow-empty", "-m", "Initial synthetic commit")
    result = push(runner)
    assert result.returncode == 0, result.stderr

    git(runner, "commit", "--allow-empty", "-m", "Fast-forward update")
    result = push(runner)
    assert result.returncode == 0, result.stderr
    assert git(remote, "rev-parse", "feature") == git(runner, "rev-parse", "HEAD")

    git(tmp_path, "clone", "--branch", "feature", str(remote), str(collaborator))
    git(collaborator, "commit", "--allow-empty", "-m", "Concurrent fix")
    git(collaborator, "push", "origin", "feature")
    remote_fix = git(collaborator, "rev-parse", "HEAD")
    git(runner, "commit", "--allow-empty", "-m", "Stale runner work")
    local_work = git(runner, "rev-parse", "HEAD")

    # Reproduce a background/worktree fetch refreshing the implicit lease.
    git(runner, "fetch", "origin")
    assert git(runner, "rev-parse", "origin/feature") == remote_fix
    result = push(runner)

    assert result.returncode != 0
    assert "Local work is preserved" in result.stderr
    assert git(remote, "rev-parse", "feature") == remote_fix
    assert git(runner, "rev-parse", "HEAD") == local_work
