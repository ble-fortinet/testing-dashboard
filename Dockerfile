# make image TAG=v0.1.0   (see Makefile)
ARG GIT_COMMIT=unknown

FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS builder
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
WORKDIR /app
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --frozen --no-dev --no-install-project
# --chmod: the build host's umask leaks into COPY (0027 on the VMs)
COPY --chmod=755 pyproject.toml uv.lock ./
COPY --chmod=755 src ./src
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev --no-editable

FROM python:3.12-slim-bookworm
ARG GIT_COMMIT
LABEL org.opencontainers.image.revision="${GIT_COMMIT}"
ENV GIT_COMMIT="${GIT_COMMIT}" PATH="/app/.venv/bin:$PATH"
# uid 10004: portal 10001, job-arch 10002, support-hub 10003. /data must be writable by it.
RUN useradd --system --uid 10004 --no-create-home tdash
COPY --from=builder /app/.venv /app/.venv
# fail the build, not the VM: the runtime user must read every module, page and script
RUN su -s /bin/sh tdash -c 'python -c "import tdash.app as a, pathlib; [p.read_bytes() for p in pathlib.Path(a.HERE).rglob(\"*\") if p.is_file()]"' \
    || { echo "FATAL: tdash unreadable by the runtime user"; exit 1; }
USER tdash
WORKDIR /app
EXPOSE 9230
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:9230/healthz', timeout=2)"]
CMD ["uvicorn", "--factory", "tdash.app:create_app", "--host", "0.0.0.0", "--port", "9230"]
