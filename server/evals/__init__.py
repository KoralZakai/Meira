"""evals — Meira's evaluation matrix, built into the implementation.

Seven rows, five of them the owner's own definitions:

    Accuracy      dataset + ground truth -> accuracy, precision/recall, F1;
                  live: an LLM judge scores whole agent answers
    Reliability   failure cases, hallucinations, tool failures, timeouts,
                  retries -> success rate / error rate
    Performance   latency p50/p95/p99 per tool and per request, throughput,
                  tokens/sec (live only)
    Scalability   what happens at 10x the requests, and which part gives first
    Cost          tokens, API calls, CPU -> cost per request / task / user-day
    RAG quality   Recall@K and MRR of memory retrieval

    cd server && python -m evals --offline      # free, deterministic, in CI
    cd server && python -m evals --live         # real model, hard $ cap, weekly

THE SILENT-STATE RULE APPLIES TO THE EVALS TOO. A suite that cannot run says
WHY in the report ("not run" + reason) — it never reports a green it did not
earn. A suite that crashes is RED, not skipped.

Nothing in this package calls the real model, real Google, Supabase or any
network in --offline mode: every model client is built by ai_gate.client() and
that is the seam the fake plugs into; every outbound HTTP request is answered
by evals.fakes.ExternalSim and counted.
"""
SUITES = ("accuracy", "reliability", "performance", "scalability", "cost", "rag")
