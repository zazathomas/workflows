SHELL := bash
YARN ?= $(shell if command -v yarn >/dev/null 2>&1; then echo yarn; else echo 'corepack yarn'; fi)
# The ignored local vendor directory can be stale; the release build uses modules.
export GOFLAGS := $(GOFLAGS) -mod=mod -tags=kubernetes_protomessage_one_more_release
VERSION ?= latest
GIT_COMMIT ?= $(shell git rev-parse HEAD 2>/dev/null || echo unknown)
GIT_TAG ?= $(shell git describe --exact-match --tags HEAD 2>/dev/null || echo untagged)
GIT_TREE_STATE ?= $(shell if test -z "$$(git status --porcelain 2>/dev/null)"; then echo clean; else echo dirty; fi)
BUILD_DATE ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
LDFLAGS := -X github.com/argoproj/argo-workflows/v4.version=$(VERSION) -X github.com/argoproj/argo-workflows/v4.buildDate=$(BUILD_DATE) -X github.com/argoproj/argo-workflows/v4.gitCommit=$(GIT_COMMIT) -X github.com/argoproj/argo-workflows/v4.gitTag=$(GIT_TAG) -X github.com/argoproj/argo-workflows/v4.gitTreeState=$(GIT_TREE_STATE)

.PHONY: help cli ui-build compatibility upstream-contract upstream-versions test test-hack test-ui test-ui-e2e test-api lint clean

help:
	@echo 'cli           Build the server and embedded UI'
	@echo 'compatibility Run server API, client and resource-kind checks'
	@echo 'upstream-contract Check the API contract for every registered upstream release'
	@echo 'upstream-versions Fetch every registered upstream release tag'
	@echo 'test          Run server and UI unit tests'
	@echo 'test-hack     Run the compatibility tooling unit tests'
	@echo 'test-ui-e2e   Run isolated browser tests (UI dev server must be running)'
	@echo 'test-api      Run live API e2e tests (disposable cluster required)'
	@echo 'lint          Run UI lint and TypeScript checks'

ui-build:
	$(YARN) --cwd ui install --frozen-lockfile
	$(YARN) --cwd ui build

cli: ui-build
	$(MAKE) -B dist/argo

# Build with an existing UI bundle (used by Docker and local development).
dist/argo:
	test -f ui/dist/app/index.html
	mkdir -p dist
	go build -ldflags '$(LDFLAGS)' -o dist/argo ./cmd/argo

upstream-contract:
	python3 hack/verify-upstream-contract.py --all

upstream-versions:
	python3 hack/fetch-upstream-versions.py

test-hack:
	python3 -m unittest discover -s hack/tests

compatibility: upstream-contract
	go test ./server/... ./cmd/argo/... ./pkg/apiclient/... ./api/openapi-spec ./pkg/apis/workflow/v1alpha1
	go test -tags=api,kubernetes_protomessage_one_more_release ./test/e2e -run '^TestAPIFixturesExist$$'

test: compatibility test-hack test-ui

test-ui:
	$(YARN) --cwd ui test --runInBand

test-ui-e2e:
	$(YARN) --cwd ui playwright test -c playwright.mock.config.ts

# This suite creates and deletes resources in the argo namespace.
test-api:
	go test -tags=api,kubernetes_protomessage_one_more_release ./test/e2e -timeout 30m

lint:
	$(YARN) --cwd ui lint

clean:
	rm -rf dist ui/dist ui/test-results ui/playwright-report
