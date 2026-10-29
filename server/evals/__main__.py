"""python -m evals — run the evaluation matrix.

    cd server
    python -m evals --offline            # CI: free, deterministic, ~1 minute, no network, no key
    python -m evals --live               # weekly: the offline suites PLUS real-model suites, $ capped
    python -m evals --offline --only accuracy,rag --out /tmp/evals

Writes <out>/report.json and <out>/report.md (default: server/evals/out/) and
prints the matrix. Exit code: 1 only when something is RED (a regression past
its threshold, or a suite that crashed); yellow (a known gap) and "not run"
exit 0 — and are printed, never hidden.

--live needs NEBIUS_API_KEY in the environment. It refuses to start when it
finds Supabase / WhatsApp credentials (nothing may touch production), keeps
no state outside a temp directory, and stops spending at --budget (default
$0.20, estimated from llm_usage.PRICES).
"""
from __future__ import annotations

import argparse
import os
import sys


def main(argv: list | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m evals", description=__doc__.split("\n\n")[0])
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--offline", action="store_true", help="free, deterministic suites only (default)")
    mode.add_argument("--live", action="store_true", help="also run the real-model suites (costs money, capped)")
    parser.add_argument("--only", default="", help="comma-separated suites: accuracy,reliability,performance,"
                                                    "scalability,cost,rag (live variants follow their name)")
    parser.add_argument("--out", default=None, help="output directory (default: server/evals/out)")
    parser.add_argument("--budget", type=float, default=0.20, help="live spend cap in USD (default 0.20)")
    parser.add_argument("-q", "--quiet", action="store_true", help="print only the matrix")
    args = parser.parse_args(argv)

    # The server's JSON stores resolve DATA_DIR at IMPORT time: this must precede
    # every server import, and credentials must be blanked before config loads .env.
    from evals import env
    env.bootstrap_data_dir()
    env.blank_secrets_env(keep=("NEBIUS_API_KEY", "EMBED_MODEL", "EMBED_BASE_URL") if args.live else ())

    from evals import report

    def say(message: str) -> None:
        if not args.quiet:
            print(message, file=sys.stderr, flush=True)

    only = [s.strip() for s in args.only.split(",") if s.strip()] or None
    suites, seconds = report.run_suites(live=args.live, only=only, budget=args.budget, progress=say)
    result = report.build(suites, "live" if args.live else "offline", seconds=seconds)
    json_path, md_path = report.write(result, args.out or report.OUT_DIR)
    print(report.render_markdown(result))
    say(f"wrote {os.path.relpath(json_path)} and {os.path.relpath(md_path)}")
    return result["exit_code"]


if __name__ == "__main__":
    raise SystemExit(main())
