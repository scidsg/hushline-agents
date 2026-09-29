from __future__ import annotations

import json
import shlex

import pytest
from test_code_agent import RUNNER_SCRIPT, _run_bash


@pytest.mark.parametrize(
    ("credit_fields", "limit_fields", "expected_rc"),
    [
        ({"hasCredits": True, "balance": "946.6"}, {}, 0),
        ({"unlimited": True}, {}, 0),
        ({"hasCredits": False, "balance": "0"}, {}, 1),
        ({"hasCredits": True, "balance": "0"}, {}, 1),
        ({"hasCredits": True, "balance": "invalid"}, {}, 1),
        ({"hasCredits": True, "balance": "50"}, {"spendControlReached": True}, 1),
        ({"hasCredits": True, "balance": "50"}, {"individualLimit": {}}, 1),
        (
            {"hasCredits": True, "balance": "50"},
            {"rateLimitReachedType": "workspace_member_credits_depleted"},
            1,
        ),
    ],
)
def test_paid_credits_allow_exhausted_quota_without_overriding_access_controls(
    credit_fields: dict[str, object], limit_fields: dict[str, object], expected_rc: int
) -> None:
    limits = {
        "primary": {"usedPercent": 100, "windowDurationMins": 10080, "resetsAt": 1791172544},
        "credits": credit_fields,
        "rateLimitReachedType": "rate_limit_reached",
        **limit_fields,
    }
    status = json.dumps({"ordinaryUsageAllowed": False, "rateLimitsByLimitId": {"codex": limits}})
    result = _run_bash(
        f"""
source {shlex.quote(str(RUNNER_SCRIPT))}
CODEX_STATUS_CHECK_ENABLED=1
HUSHLINE_DAILY_CODEX_STATUS_JSON={shlex.quote(status)}
sleep() {{ echo unexpected-sleep; return 1; }}
set +e
wait_for_codex_status_credit_window
rc=$?
printf 'rc=%s\\n' "$rc"
"""
    )

    assert result.returncode == 0, result.stderr
    assert f"rc={expected_rc}" in result.stdout
    assert "unexpected-sleep" not in result.stdout
    assert ("paid credits are available" in result.stdout) == (expected_rc == 0)
