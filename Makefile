# =============================================================================
# DORA Dashboard - monorepo orchestration
#
# The human interface for the whole project. `make help` lists everything.
# Turborepo is the machine interface underneath, invoked by path so the build
# always uses the version the lockfile pins rather than a global copy.
# =============================================================================

.DEFAULT_GOAL := help
SHELL := /bin/bash

TURBO    := node_modules/.bin/turbo
PRETTIER := node_modules/.bin/prettier
ESLINT   := node_modules/.bin/eslint
API_WS   := @dora-dashboard/api
WEB_WS   := @dora-dashboard/web
CORE_WS  := @dora-dashboard/core

# Repositories to crawl live in a local, untracked file so no private repository
# name ever enters git. Copy repos.local.example.json to start.
REPOS_FILE ?= repos.local.json
RUN_DIR    := .run

BOLD  := \033[1m
CYAN  := \033[36m
GREEN := \033[32m
YELLOW:= \033[33m
RESET := \033[0m

.PHONY: help all install build typecheck test test-coverage test-coverage-force quality \
        fmt fmt-check lint lint-fix check-names dev dev-bg dev-stop dev-logs api web crawl crawl-full \
        crawl-all env clean clean-data

# --- Getting started ----------------------------------------------------------

help: ## Show this help, grouped by section
	@awk 'BEGIN {FS = ":.*##"} \
		/^# ---/ {gsub(/^# --- | -+$$/, ""); printf "\n$(BOLD)%s$(RESET)\n", $$0} \
		/^[a-zA-Z0-9_-]+:.*##/ {printf "  $(CYAN)%-22s$(RESET) %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@printf '%b\n' ""
	@printf '%b\n' "$(BOLD)Quick start:$(RESET)"
	@printf '%b\n' "  make all          install, build, run every quality gate"
	@printf '%b\n' "  make crawl-all    crawl every repository in $(REPOS_FILE)"
	@printf '%b\n' "  make dev          API on :8787 and web on :5181, in the foreground"
	@printf '%b\n' ""

all: install env build quality ## Complete setup: dependencies, .env, build and every gate
	@printf '%b\n' "$(GREEN)Ready. Run make crawl-all, then make dev.$(RESET)"

install: ## Install every workspace's dependencies from the lockfile
	npm install --no-audit --no-fund

env: ## Create .env from .env.example if it does not exist yet
	@test -f .env || { cp .env.example .env && echo "Created .env (AUTH_MODE=gh-cli)"; }

# --- Build and quality --------------------------------------------------------

build: ## Build core, API and web through turbo (cached)
	$(TURBO) run build

typecheck: ## Typecheck every workspace (cached)
	$(TURBO) run typecheck

test: ## Run every test suite (cached)
	$(TURBO) run test

test-coverage: ## Run every suite with its coverage floor (cached; counts may be replayed)
	$(TURBO) run test:coverage

test-coverage-force: ## Same, ignoring the cache; use this before quoting a figure
	$(TURBO) run test:coverage --force

fmt: ## Format the repository with prettier
	$(PRETTIER) --write . --log-level warn

fmt-check: ## Fail if anything is unformatted
	$(PRETTIER) --check . --log-level warn

lint: ## Lint every workspace with eslint
	$(ESLINT) . --max-warnings 0

lint-fix: ## Apply the fixes eslint can make on its own
	$(ESLINT) . --fix

check-names: ## Fail if a name listed in .private-names appears in a tracked file
	node scripts/check-private-names.mjs

quality: fmt-check lint check-names typecheck test-coverage ## Every gate CI runs

# --- Running ------------------------------------------------------------------

dev: env ## API and web together in the foreground (Ctrl+C stops both)
	$(TURBO) run dev --filter=$(API_WS) --filter=$(WEB_WS)

dev-bg: env ## API and web in the background, logs under .run/
	@mkdir -p $(RUN_DIR)
	@$(TURBO) run build --filter=$(CORE_WS) > /dev/null
	@nohup npm run dev -w $(API_WS) > $(RUN_DIR)/api.log 2>&1 & echo $$! > $(RUN_DIR)/api.pid
	@nohup npm run dev -w $(WEB_WS) > $(RUN_DIR)/web.log 2>&1 & echo $$! > $(RUN_DIR)/web.pid
	@printf '%b\n' "$(GREEN)API http://127.0.0.1:8787  web http://localhost:5181$(RESET)  (make dev-logs, make dev-stop)"

dev-stop: ## Stop servers started by dev-bg
	@for svc in api web; do \
		if [ -f $(RUN_DIR)/$$svc.pid ]; then pkill -P $$(cat $(RUN_DIR)/$$svc.pid) 2>/dev/null; kill $$(cat $(RUN_DIR)/$$svc.pid) 2>/dev/null; rm -f $(RUN_DIR)/$$svc.pid; echo "stopped $$svc"; fi; \
	done

dev-logs: ## Follow the background servers' logs
	tail -f $(RUN_DIR)/api.log $(RUN_DIR)/web.log

api: env ## The API alone on :8787
	$(TURBO) run build --filter=$(CORE_WS) > /dev/null && npm run dev -w $(API_WS)

web: ## The web app alone on :5181 (expects the API running)
	npm run dev -w $(WEB_WS)

# --- Crawling -----------------------------------------------------------------

crawl: ## Crawl one repository: make crawl repo=owner/name [workflow=deploy.yml] [branch=main]
	@test -n "$(repo)" || { echo "Usage: make crawl repo=owner/name [workflow=deploy.yml] [branch=main]"; exit 1; }
	@$(TURBO) run build --filter=$(CORE_WS) > /dev/null
	npm run --silent crawl -w $(API_WS) -- $(repo) $(if $(workflow),--workflow $(workflow)) $(if $(branch),--branch $(branch)) $(if $(full),--full)

crawl-full: ## Re-read a repository from scratch: make crawl-full repo=owner/name
	@$(MAKE) --no-print-directory crawl repo=$(repo) workflow=$(workflow) branch=$(branch) full=1

crawl-all: ## Crawl every repository listed in repos.local.json
	@test -f $(REPOS_FILE) || { echo "$(YELLOW)No $(REPOS_FILE); copy repos.local.example.json and edit it.$(RESET)"; exit 1; }
	@node -e 'for (const r of JSON.parse(require("fs").readFileSync("$(REPOS_FILE)","utf8"))) console.log([r.repo, (r.workflows||[]).join(","), r.branch||"main"].join(" "))' | \
		while read -r repo workflows branch; do \
			flags=""; for w in $${workflows//,/ }; do flags="$$flags --workflow $$w"; done; \
			echo "$(BOLD)$$repo$(RESET)"; \
			$(TURBO) run build --filter=$(CORE_WS) > /dev/null; \
			npm run --silent crawl -w $(API_WS) -- $$repo $$flags --branch $$branch || exit 1; \
		done

# --- Housekeeping -------------------------------------------------------------

clean: ## Remove build output, coverage and the turbo cache (keeps crawled data)
	rm -rf apps/*/dist packages/*/dist apps/*/coverage packages/*/coverage .turbo apps/*/.turbo packages/*/.turbo

clean-data: ## Delete the crawled SQLite cache
	rm -rf data
