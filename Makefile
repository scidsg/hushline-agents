.DEFAULT_GOAL := help

.PHONY: help
help:
	@awk 'BEGIN {FS = ":.*?## "} /^[0-9a-zA-Z_-]+:.*?## / {printf "%-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

.PHONY: lint
lint: ## Check Python formatting, lint, typing, and shell syntax
	python3 -m ruff format --check .
	python3 -m ruff check .
	python3 -m mypy scripts tests
	for script in scripts/code_agent.sh scripts/agent_issue_bootstrap.sh social/scripts/*.sh social/scripts/lib/*.sh; do bash -n "$$script"; done
	for plist in social/deploy/launchd/*.plist; do plutil -lint "$$plist" >/dev/null; done

.PHONY: fix
fix: ## Format and auto-fix supported Python issues
	python3 -m ruff check --fix .
	python3 -m ruff format .

.PHONY: test
test: ## Run the runner test suite
	python3 -m pytest -q
