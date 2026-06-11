.DEFAULT_GOAL := help

.PHONY: help
help:
	@awk 'BEGIN {FS = ":.*?## "} /^[0-9a-zA-Z_-]+:.*?## / {printf "%-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

.PHONY: lint
lint: ## Check Python formatting, lint, typing, and shell syntax
	python3 -m ruff format --check .
	python3 -m ruff check .
	python3 -m mypy scripts sales/scripts tests
	for script in scripts/*.sh social/scripts/*.sh social/scripts/lib/*.sh sales/scripts/*.sh; do bash -n "$$script"; done
	python3 scripts/validate_social_plists.py

.PHONY: fix
fix: ## Format and auto-fix supported Python issues
	python3 -m ruff check --fix .
	python3 -m ruff format .

.PHONY: test
test: ## Run the runner test suite
	python3 -m pytest -q
