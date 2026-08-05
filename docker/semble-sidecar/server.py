"""Semble sidecar HTTP shim (KIT-036).

Semble's MCP server is stdio-only, which cannot cross container boundaries.
This shim spawns `semble[mcp]` as a stdio subprocess via the official MCP
client and exposes a minimal HTTP API on the Pod's shared network namespace:

    GET  /health            -> {"status": "ok"}
    POST /search            {"query": str, "top_k": int}
                            -> {"results": [{"path", "score", "snippet"}]}

Consumed by packages/reviewer/src/mcp/semantic-search.ts. The response shape
here is the contract SidecarResponseSchema validates — change both together.

Env:
    REPO_PATH               absolute path of the clone (default /workspace/repo)
    SEMBLE_CACHE_LOCATION   index dir (set by the Pod manifest, keyed repo+base)
    PORT                    listen port (default 8765)
"""

import asyncio
import contextlib
import json
import os
import re
import sys

from aiohttp import web
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

REPO_PATH = os.environ.get("REPO_PATH", "/workspace/repo")
PORT = int(os.environ.get("PORT", "8765"))

_session: ClientSession | None = None


async def wait_for_clone(path: str, timeout_s: int = 300) -> None:
    """The reviewer container clones after both containers start — poll until
    the clone exists before first use (reviews start with clone anyway)."""
    for _ in range(timeout_s):
        if os.path.isdir(os.path.join(path, ".git")):
            return
        await asyncio.sleep(1)
    print(f"[semble-sidecar] clone not found at {path} after {timeout_s}s", file=sys.stderr)


def parse_results(raw_text: str) -> list[dict]:
    """Best-effort parse of semble's search tool output into structured rows.

    Semble returns human-readable text blocks; each block starts with a file
    path (optionally `path:line`) and may carry a score. Anything unparseable
    lands as a snippet under the last seen path.
    """
    # Observed semble 0.5.3 output (local smoke, 2026-08-05):
    # {"query": ..., "results": [{"file_path", "start_line", "end_line",
    #  "score", "content"}]}
    try:
        data = json.loads(raw_text)
        items = None
        if isinstance(data, dict) and isinstance(data.get("results"), list):
            items = data["results"]
        elif isinstance(data, list):
            items = data
        if items is not None:
            parsed = []
            for item in items:
                if not isinstance(item, dict):
                    continue
                file_path = str(item.get("file_path", item.get("path", item.get("file", "unknown"))))
                start = item.get("start_line")
                parsed.append(
                    {
                        "path": f"{file_path}:{start}" if start is not None else file_path,
                        "score": float(item.get("score", 0.0)),
                        "snippet": str(item.get("content", item.get("snippet", ""))),
                    }
                )
            return parsed
    except (json.JSONDecodeError, TypeError, ValueError):
        pass

    results: list[dict] = []
    header = re.compile(r"^(?P<path>[\w./-]+\.[\w]+)(?::(?P<line>\d+))?(?:\s+\(score:?\s*(?P<score>[\d.]+)\))?\s*$")
    current: dict | None = None
    for line in raw_text.splitlines():
        match = header.match(line.strip())
        if match:
            if current is not None:
                results.append(current)
            current = {
                "path": match.group("path"),
                "score": float(match.group("score") or 0.0),
                "snippet": "",
            }
        elif current is not None:
            current["snippet"] = (current["snippet"] + "\n" + line).strip()
    if current is not None:
        results.append(current)
    if not results and raw_text.strip():
        results.append({"path": "unknown", "score": 0.0, "snippet": raw_text.strip()[:2000]})
    return results


async def handle_health(_request: web.Request) -> web.Response:
    return web.json_response({"status": "ok" if _session is not None else "starting"})


async def handle_search(request: web.Request) -> web.Response:
    if _session is None:
        return web.json_response({"code": "SERVICE_UNAVAILABLE", "message": "semble not ready"}, status=503)
    try:
        body = await request.json()
        query = str(body["query"])
        top_k = int(body.get("top_k", 10))
    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
        return web.json_response({"code": "VALIDATION", "message": "expected {query, top_k?}"}, status=400)

    try:
        result = await _session.call_tool(
            "search", {"query": query, "repo": REPO_PATH, "top_k": top_k}
        )
    except Exception as error:  # semble crash → 503, reviewer falls back lexically
        return web.json_response({"code": "SERVICE_UNAVAILABLE", "message": str(error)}, status=503)

    text = "\n".join(block.text for block in result.content if getattr(block, "text", None))
    return web.json_response({"results": parse_results(text)[:top_k]})


async def main() -> None:
    global _session
    await wait_for_clone(REPO_PATH)

    params = StdioServerParameters(
        command="uvx", args=["--from", "semble[mcp]", "semble"], env=dict(os.environ)
    )
    async with contextlib.AsyncExitStack() as stack:
        read, write = await stack.enter_async_context(stdio_client(params))
        session = await stack.enter_async_context(ClientSession(read, write))
        await session.initialize()
        _session = session
        print(f"[semble-sidecar] semble MCP ready, serving on :{PORT}")

        # Warm-up: build the index (and download the embedding model on the
        # very first run) before the reviewer needs it — the agentic loop's
        # 10s tool timeout is far shorter than a cold model download.
        try:
            await session.call_tool("search", {"query": "warmup", "repo": REPO_PATH, "top_k": 1})
            print("[semble-sidecar] index warm")
        except Exception as error:
            print(f"[semble-sidecar] warmup failed (non-fatal): {error}", file=sys.stderr)

        app = web.Application()
        app.router.add_get("/health", handle_health)
        app.router.add_post("/search", handle_search)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "0.0.0.0", PORT)
        await site.start()
        await asyncio.Event().wait()  # serve forever


if __name__ == "__main__":
    asyncio.run(main())
