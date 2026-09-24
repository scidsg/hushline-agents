#!/usr/bin/env python3
"""Read-only, fail-closed planning for two outstanding runner work items."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from typing import Any

Json = dict[str, Any]


class GitHub:
    def __init__(self) -> None:
        self.repo = os.environ.get("HUSHLINE_REPO_SLUG", "scidsg/hushline")
        self.bot = os.environ.get("HUSHLINE_BOT_LOGIN", "hushline-dev")
        self.owner = os.environ.get("HUSHLINE_DAILY_PROJECT_OWNER", self.repo.split("/")[0])
        self.title = os.environ.get("HUSHLINE_DAILY_PROJECT_TITLE", "Hush Line Roadmap")

    def api(self, endpoint: str, payload: Json | None = None, *, pages: bool = False) -> Any:
        args = ["gh", "api", endpoint]
        if payload is not None:
            args += ["--input", "-"]
        if pages:
            args += ["--paginate", "--slurp"]
        attempts = int(os.environ.get("HUSHLINE_DAILY_GITHUB_READ_ATTEMPTS", "3"))
        for attempt in range(max(1, attempts)):
            result = subprocess.run(  # noqa: S603 -- argument array; no shell or credential arguments.
                args,
                input=json.dumps(payload) if payload is not None else None,
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )
            if result.returncode == 0:
                data = json.loads(result.stdout)
                if isinstance(data, dict) and data.get("errors"):
                    raise RuntimeError("GitHub returned incomplete GraphQL data")
                return data
            if attempt + 1 < attempts:
                time.sleep(
                    int(os.environ.get("HUSHLINE_DAILY_GITHUB_READ_RETRY_DELAY_SECONDS", "2"))
                )
        raise RuntimeError("Cannot verify GitHub state; no new work may be claimed")

    def graphql(self, query: str, **variables: Any) -> Json:
        return dict(self.api("graphql", {"query": query, "variables": variables})["data"])

    def pulls(self) -> list[Json]:
        pages = self.api(f"repos/{self.repo}/pulls?state=open&per_page=100", pages=True)
        return [pr for page in pages for pr in page if pr["user"]["login"] == self.bot]

    def project_items(self) -> list[Json]:
        owner_type = self.graphql(
            "query($login:String!){repositoryOwner(login:$login){__typename}}", login=self.owner
        )["repositoryOwner"]["__typename"]
        field = {"User": "user", "Organization": "organization"}[owner_type]
        cursor = None
        project_id = None
        while True:
            projects = self.graphql(
                "query($login:String!,$cursor:String){"
                + field
                + "(login:$login){projectsV2(first:100,after:$cursor){"
                "nodes{id title closed} pageInfo{hasNextPage endCursor}}}}",
                login=self.owner,
                cursor=cursor,
            )[field]["projectsV2"]
            for project in projects["nodes"]:
                if project["title"] == self.title and not project["closed"]:
                    if project_id is not None:
                        raise RuntimeError("Ambiguous project title")
                    project_id = project["id"]
            if not projects["pageInfo"]["hasNextPage"]:
                break
            cursor = projects["pageInfo"]["endCursor"]
        if project_id is None:
            raise RuntimeError("Runner project not found")
        items: list[Json] = []
        cursor = None
        while True:
            connection = self.graphql(
                "query($id:ID!,$cursor:String,$field:String!){node(id:$id){... on ProjectV2{"
                "items(first:100,after:$cursor){nodes{isArchived content{... on Issue{number state "
                "repository{nameWithOwner}}} fieldValueByName(name:$field){"
                "... on ProjectV2ItemFieldSingleSelectValue{name}}}"
                "pageInfo{hasNextPage endCursor}}}}}",
                id=project_id,
                cursor=cursor,
                field=os.environ.get("HUSHLINE_DAILY_PROJECT_STATUS_FIELD_NAME", "Status"),
            )["node"]["items"]
            for item in connection["nodes"]:
                content = item.get("content") or {}
                if (
                    not item["isArchived"]
                    and content.get("state") == "OPEN"
                    and (content.get("repository") or {}).get("nameWithOwner") == self.repo
                ):
                    items.append(
                        {
                            "number": content["number"],
                            "status": (item.get("fieldValueByName") or {}).get("name", ""),
                        }
                    )
            if not connection["pageInfo"]["hasNextPage"]:
                return items
            cursor = connection["pageInfo"]["endCursor"]

    def blocked(self, number: int) -> bool:
        pages = self.api(
            f"repos/{self.repo}/issues/{number}/dependencies/blocked_by?per_page=100", pages=True
        )
        return any(issue["state"] != "closed" for page in pages for issue in page)

    def is_open(self, number: int) -> bool:
        return bool(self.api(f"repos/{self.repo}/issues/{number}")["state"] == "open")


def branch_issue(head: str) -> int | None:
    for prefix in (
        os.environ.get("HUSHLINE_DAILY_BRANCH_PREFIX", "codex/daily-issue-"),
        os.environ.get("HUSHLINE_DAILY_EPIC_BRANCH_PREFIX", "codex/epic-"),
    ):
        if head.startswith(prefix) and re.fullmatch(r"[0-9]+", head[len(prefix) :]):
            return int(head[len(prefix) :])
    return None


def occupied(pulls: list[Json], items: list[Json]) -> tuple[int, set[int]]:
    represented = {n for pr in pulls if (n := branch_issue(pr["head"]["ref"])) is not None}
    in_progress = os.environ.get("HUSHLINE_DAILY_PROJECT_STATUS_IN_PROGRESS", "In Progress")
    assignments = {i["number"] for i in items if i["status"] == in_progress}
    return len(pulls) + len(assignments - represented), represented | assignments


def choose(github: GitHub, pulls: list[Json], items: list[Json], forced: int | None) -> int | None:
    count, assigned = occupied(pulls, items)
    limit = int(os.environ.get("HUSHLINE_DAILY_MAX_INFLIGHT", "2"))
    if count > limit:
        return None
    represented = {branch_issue(p["head"]["ref"]) for p in pulls}
    progress = os.environ.get("HUSHLINE_DAILY_PROJECT_STATUS_IN_PROGRESS", "In Progress")
    eligible = os.environ.get("HUSHLINE_DAILY_PROJECT_COLUMN", "Agent Eligible")
    if forced is not None:
        candidates = [forced]
    else:
        candidates = [i["number"] for i in items if i["status"] == progress]
        candidates += [i["number"] for i in items if i["status"] == eligible]
    for number in dict.fromkeys(candidates):
        # Existing PRs are maintained by the review pass, never reimplemented from the queue.
        if forced is None and number in represented:
            continue
        if number not in assigned and count >= limit:
            continue
        # A ready-for-review PR retains the review gate; drafts can park one slot.
        if number not in assigned and any(not pr["draft"] for pr in pulls):
            continue
        if github.is_open(number) and not github.blocked(number):
            return number
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("plan", "reviews", "check"))
    parser.add_argument("--issue", type=int)
    args = parser.parse_args()
    github = GitHub()
    pulls = github.pulls()
    if args.mode == "reviews":
        for pr in sorted(pulls, key=lambda p: p["number"]):
            number = branch_issue(pr["head"]["ref"])
            if number is not None:
                title = pr["title"].replace("\t", " ").replace("\n", " ")
                print(f"{pr['number']}\t{number}\t{pr['head']['ref']}\t{title}")
        return
    selected = choose(github, pulls, github.project_items(), args.issue)
    if args.mode == "check":
        if args.issue is None or selected != args.issue:
            raise RuntimeError("Assignment blocked by capacity or incomplete prerequisites")
    elif selected is not None:
        print(selected)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, KeyError, ValueError, TypeError, OSError, subprocess.TimeoutExpired):
        print("Blocked: cannot verify available issue slots and dependencies.", file=sys.stderr)
        sys.exit(1)
