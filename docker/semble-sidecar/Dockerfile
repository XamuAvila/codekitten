# Semble sidecar (KIT-036) — semantic code search over the shared clone
# volume. Runs server.py: an HTTP shim bridging the reviewer container to
# semble's stdio-only MCP server. Index persists under SEMBLE_CACHE_LOCATION
# (PVC mount, keyed by repo+base in the Pod manifest).
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /app

# git: semble walks repos; pre-install python deps at build time so Pod
# startup does not hit the network for the shim (semble itself resolves via
# uvx on first run and is cached in the image by the warmup below).
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

RUN uv venv /venv && uv pip install --python /venv/bin/python aiohttp "mcp>=1.0"

# Warm the uvx cache with semble so first Pod start is offline-safe.
RUN uvx --from "semble[mcp]" semble --help || true

COPY server.py /app/server.py

ENV PORT=8765
EXPOSE 8765

CMD ["/venv/bin/python", "/app/server.py"]
