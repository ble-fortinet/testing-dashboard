# `make image` -> hrai-testing-dash:latest, `make image TAG=v0.1.0` -> hrai-testing-dash:v0.1.0.
# Never trust :latest on a host: retag :previous before rebuilding a tag in use.
TAG ?= latest

.PHONY: image check

image:
	docker build -t hrai-testing-dash:$(TAG) --build-arg GIT_COMMIT=$$(git rev-parse --short HEAD) .

check:
	uv run ruff check . && uv run ruff format --check . && uv run pytest -q
