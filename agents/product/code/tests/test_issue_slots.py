from __future__ import annotations

import importlib.util
import json
import shlex
import subprocess
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[4]
SCRIPT = ROOT / "agents/product/code/scripts/issue_slots.py"
RUNNER = SCRIPT.with_name("code_agent.sh")
spec = importlib.util.spec_from_file_location("issue_slots", SCRIPT)
assert spec
assert spec.loader
slots = importlib.util.module_from_spec(spec)
spec.loader.exec_module(slots)


class FakeGitHub:
    def __init__(self, blocked: set[int] | None = None) -> None:
        self.blockers = blocked or set()

    def blocked(self, number: int) -> bool:
        return number in self.blockers

    def is_open(self, number: int) -> bool:
        return True


def pr(number: int, *, draft: bool = True, head: str | None = None) -> dict[str, Any]:
    return {
        "number": number + 1000,
        "head": {"ref": head or f"codex/daily-issue-{number}"},
        "draft": draft,
    }


def item(number: int, status: str = "Agent Eligible") -> dict[str, Any]:
    return {"number": number, "status": status}


def test_draft_pr_leaves_second_slot_available() -> None:
    assert slots.choose(FakeGitHub(), [pr(1)], [item(2), item(3)], None) == 2


def test_ready_pr_retains_new_work_review_gate() -> None:
    assert slots.choose(FakeGitHub(), [pr(1, draft=False)], [item(2)], None) is None


def test_two_drafts_fill_capacity_even_for_forced_issue() -> None:
    assert slots.choose(FakeGitHub(), [pr(1), pr(2)], [item(3)], None) is None
    assert slots.choose(FakeGitHub(), [pr(1), pr(2)], [item(3)], 3) is None


def test_issue_and_its_pr_count_once_but_epic_and_child_pr_count_separately() -> None:
    assert slots.occupied([pr(1)], [item(1, "In Progress")])[0] == 1
    assert slots.occupied([pr(1, head="codex/epic-1"), pr(2)], [item(2, "In Progress")])[0] == 2


def test_two_assigned_tickets_resume_without_claiming_third() -> None:
    items = [item(1, "In Progress"), item(2, "In Progress"), item(3)]
    assert slots.choose(FakeGitHub(), [], items, None) == 1
    assert slots.choose(FakeGitHub(), [], items, 3) is None


def test_resume_assignment_when_other_slot_is_review_ready() -> None:
    assert slots.choose(FakeGitHub(), [pr(1, draft=False)], [item(2, "In Progress")], None) == 2


def test_blocked_assignments_do_not_skip_capacity_accounting() -> None:
    items = [item(2, "In Progress"), item(3)]
    assert slots.choose(FakeGitHub({2}), [pr(1)], items, None) is None


def test_dependency_blocked_ticket_is_skipped_in_board_order() -> None:
    assert slots.choose(FakeGitHub({2}), [pr(1)], [item(2), item(3)], None) == 3
    assert slots.choose(FakeGitHub({2}), [pr(1)], [item(2)], 2) is None


def test_open_pr_is_not_reimplemented_from_in_progress_row() -> None:
    assert slots.choose(FakeGitHub(), [pr(1)], [item(1, "In Progress"), item(2)], None) == 2


def test_unknown_bot_branch_still_occupies_capacity() -> None:
    assert slots.occupied([pr(1, head="unusual")], [item(2, "In Progress")])[0] == 2


def test_overcapacity_fails_closed() -> None:
    assert slots.choose(FakeGitHub(), [pr(1), pr(2), pr(3)], [item(4)], 1) is None


def test_dependency_query_failure_is_not_treated_as_no_dependencies(monkeypatch: Any) -> None:
    github = slots.GitHub()

    def fail(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("unavailable")

    monkeypatch.setattr(github, "api", fail)
    with pytest.raises(RuntimeError):
        slots.choose(github, [pr(1)], [item(2)], None)


def test_closed_pr_releases_slot_and_closed_dependency_unblocks(monkeypatch: Any) -> None:
    github = slots.GitHub()
    monkeypatch.setattr(github, "is_open", lambda _: True)
    monkeypatch.setattr(github, "api", lambda *a, **kw: [[{"state": "closed"}]])
    assert slots.choose(github, [], [item(2)], None) == 2


def test_closed_issue_cannot_be_forced_or_selected_from_stale_board(monkeypatch: Any) -> None:
    github = FakeGitHub()
    monkeypatch.setattr(github, "is_open", lambda _: False)
    assert slots.choose(github, [], [item(1732)], None) is None
    assert slots.choose(github, [], [item(1732)], 1732) is None


def test_blockers_across_pages_are_checked(monkeypatch: Any) -> None:
    github = slots.GitHub()
    monkeypatch.setattr(
        github, "api", lambda *a, **kw: [[{"state": "closed"}], [{"state": "open"}]]
    )
    assert github.blocked(1)


def run_shell(script: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["/bin/bash", "-c", script], cwd=ROOT, text=True, capture_output=True, check=False
    )


def test_two_slot_monitor_returns_after_one_pass_without_closing_pr() -> None:
    result = run_shell(f"""
source {shlex.quote(str(RUNNER))}
fetch_pr_feedback_json() {{ printf '{{}}'; }}
fetch_pr_checks_json() {{ printf '[]'; }}
pr_feedback_state() {{ printf OPEN; }}
summarize_pr_feedback() {{ printf 'no-action'; }}
pr_feedback_action_key() {{ printf key; }}
pr_feedback_summary_requires_runner_action() {{ return 1; }}
sleep() {{ echo UNEXPECTED-SLEEP; return 99; }}
check_pr_feedback_after_delay 2363 2315 Title '' codex/daily-issue-2315
echo "closed=$PR_FEEDBACK_MONITOR_CLOSED"
""")
    assert result.returncode == 0, result.stderr
    assert "Completed feedback pass" in result.stdout
    assert "closed=0" in result.stdout
    assert "UNEXPECTED-SLEEP" not in result.stdout


def test_two_slot_review_pass_visits_both_prs_before_queue_selection() -> None:
    result = run_shell(f"""
source {shlex.quote(str(RUNNER))}
issue_slot_plan() {{
  printf '1001\\t1\\tcodex/daily-issue-1\\tOne\\n'
  printf '1002\\t2\\tcodex/daily-issue-2\\tTwo\\n'
}}
remote_branch_exists() {{ return 0; }}
run_step() {{ :; }}
gh() {{ printf ''; }}
check_pr_feedback_after_delay() {{ echo "review=$1"; }}
code=0
resume_open_issue_pr_monitor_if_any || code=$?
echo "status=$code"
""")
    assert result.returncode == 0, result.stderr
    assert "review=1001" in result.stdout
    assert "review=1002" in result.stdout
    assert "status=1" in result.stdout  # Main may proceed to capacity planning.


def test_failed_review_prevents_new_assignment() -> None:
    result = run_shell(f"""
source {shlex.quote(str(RUNNER))}
issue_slot_plan() {{ printf '1001\\t1\\tcodex/daily-issue-1\\tOne\\n'; }}
remote_branch_exists() {{ return 0; }}
run_step() {{ :; }}
gh() {{ printf ''; }}
check_pr_feedback_after_delay() {{ return 1; }}
code=0
resume_open_issue_pr_monitor_if_any || code=$?
echo "status=$code"
""")
    assert "status=2" in result.stdout


def test_graphql_errors_fail_closed_even_with_partial_data(monkeypatch: Any) -> None:
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *a, **kw: subprocess.CompletedProcess(
            [], 0, json.dumps({"data": {}, "errors": [{"message": "partial"}]}), ""
        ),
    )
    with pytest.raises(RuntimeError):
        slots.GitHub().api("graphql", {"query": "query{}"})


def test_project_query_ignores_closed_archived_and_other_repository_items(monkeypatch: Any) -> None:
    github = slots.GitHub()
    nodes = []
    for number, state, archived, repo in (
        (1732, "CLOSED", False, "scidsg/hushline"),
        (2, "OPEN", True, "scidsg/hushline"),
        (3, "OPEN", False, "other/repo"),
        (2366, "OPEN", False, "scidsg/hushline"),
    ):
        nodes.append(
            {
                "isArchived": archived,
                "content": {
                    "number": number,
                    "state": state,
                    "repository": {"nameWithOwner": repo},
                },
                "fieldValueByName": {"name": "In Progress"},
            }
        )
    responses = iter(
        [
            {"repositoryOwner": {"__typename": "Organization"}},
            {
                "organization": {
                    "projectsV2": {
                        "nodes": [{"id": "project", "title": "Hush Line Roadmap", "closed": False}],
                        "pageInfo": {"hasNextPage": False},
                    }
                }
            },
            {"node": {"items": {"nodes": nodes, "pageInfo": {"hasNextPage": False}}}},
        ]
    )
    monkeypatch.setattr(github, "graphql", lambda *a, **kw: next(responses))
    assert github.project_items() == [item(2366, "In Progress")]


def test_two_slot_main_reaches_second_assignment_without_one_pr_guard(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    result = run_shell(f"""
source {shlex.quote(str(RUNNER))}
REPO_DIR={shlex.quote(str(repo))}
initialize_run_state() {{ :; }}
cleanup() {{ :; }}
acquire_runner_lock() {{ :; }}
assert_runner_can_take_checkout() {{ :; }}
require_cmd() {{ :; }}
process_open_dependabot_prs() {{ return 0; }}
resume_open_issue_pr_monitor_if_any() {{ echo 'reviewed-draft'; return 1; }}
count_open_human_prs() {{ printf 0; }}
issue_slot_plan() {{
  if [[ "$1" == plan ]]; then printf 2366; else echo 'capacity-rechecked'; fi
}}
wait_for_codex_status_credit_window() {{ :; }}
resolve_issue_parent_epic() {{ printf '2365\\tPQ\\thttps://example.test\\n'; }}
find_open_pr_for_head_branch() {{ :; }}
count_open_bot_prs_excluding_heads() {{ printf 1; }}
run_step() {{ echo "step=$1"; }}
kill_all_docker_containers() {{ :; }}
kill_processes_on_ports() {{ :; }}
start_runtime_stack_and_seed_dev_data() {{ echo 'runtime-for-second-slot'; exit 42; }}
main
""")
    assert result.returncode == 42, result.stderr
    assert "reviewed-draft" in result.stdout
    assert "capacity-rechecked" in result.stdout
    assert "Mark issue #2366 as In Progress" in result.stdout
    assert "runtime-for-second-slot" in result.stdout
