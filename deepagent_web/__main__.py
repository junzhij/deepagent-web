"""``python -m deepagent_web`` / ``deepagent-web`` entry point."""

from __future__ import annotations

import argparse
import os


def main() -> None:
    parser = argparse.ArgumentParser(prog="deepagent-web", description="Visualise LangChain Deep Agent runs in the browser.")
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    parser.add_argument(
        "--agent",
        action="append",
        default=[],
        metavar="MODULE:ATTR",
        help="Your own agent: a compiled deep agent graph or a factory `(model) -> graph`. Repeatable.",
    )
    parser.add_argument("--runs-dir", default=os.environ.get("DEEPAGENT_WEB_RUNS_DIR", "runs"), help="Where run logs are saved.")
    args = parser.parse_args()

    import sys

    import uvicorn

    sys.path.insert(0, os.getcwd())  # so `--agent my_agent:graph` finds modules in the current directory
    from .server import create_app

    env_refs = [r for r in os.environ.get("DEEPAGENT_WEB_AGENTS", "").split(",") if r.strip()]
    app = create_app(agent_refs=env_refs + args.agent, runs_dir=args.runs_dir)
    print(f"Deep Agent Web running at http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
