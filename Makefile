.DEFAULT_GOAL := help

.PHONY: help
help:
	@awk 'BEGIN {FS = ":.*?## "} /^[0-9a-zA-Z_-]+:.*?## / {printf "%-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

.PHONY: lint
lint: ## Check Python formatting, lint, typing, and shell syntax
	python3 -m ruff format --check .
	python3 -m ruff check .
	python3 -m mypy scripts tests
	bash -n scripts/code_agent.sh
	bash -n scripts/agent_issue_bootstrap.sh

.PHONY: fix
fix: ## Format and auto-fix supported Python issues
	python3 -m ruff check --fix .
	python3 -m ruff format .

.PHONY: test
test: ## Run the runner test suite
	python3 -m pytest -q
