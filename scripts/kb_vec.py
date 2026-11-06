#!/usr/bin/env python3
"""Semantic index for the arXiv paper library (vectors.db, sqlite).

Commands:
  index-batch --jsonl '<json>'   Upsert embeddings for [{id,title,abstract,hash}]; rows whose
                                 hash matches the stored one are skipped.
  search --query "..." --top-k N Print {"ids": [...]} ranked by cosine similarity.

Model: BAAI/bge-small-en-v1.5 via fastembed (ONNX, no torch). First run
downloads the model (~30MB); failures are expected to degrade to keyword
search in the caller.
"""
import argparse
import json
import os
import sqlite3
import sys

DB_PATH = os.path.expanduser("~/.dsh-arxiv-inspiration/vectors.db")
MODEL_NAME = "BAAI/bge-small-en-v1.5"
EMBED_DIM = 384

_model = None


def model():
    global _model
    if _model is None:
        from fastembed import TextEmbedding

        _model = TextEmbedding(model_name=MODEL_NAME, cache_dir=os.path.expanduser("~/.dsh-arxiv-inspiration/models"))
    return _model


def connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS papers ("
        " id TEXT PRIMARY KEY, hash TEXT NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL)"
    )
    return conn


def embed(texts):
    return [e.tolist() for e in model().embed(texts)]


def cmd_index_batch(args):
    rows = json.loads(args.jsonl)
    conn = connect()
    stored = dict(conn.execute("SELECT id, hash FROM papers").fetchall())
    pending = [r for r in rows if r.get("id") and stored.get(r["id"]) != r.get("hash")]
    if not pending:
        print(json.dumps({"indexed": 0, "skipped": len(rows)}))
        return
    texts = [f"{r.get('title', '')}\n{(r.get('abstract') or '')[:2000]}" for r in pending]
    vectors = embed(texts)
    with conn:
        for r, vec in zip(pending, vectors):
            conn.execute(
                "INSERT INTO papers (id, hash, dim, vec) VALUES (?, ?, ?, ?)"
                " ON CONFLICT(id) DO UPDATE SET hash=excluded.hash, dim=excluded.dim, vec=excluded.vec",
                (r["id"], r.get("hash", ""), len(vec), json.dumps(vec).encode()),
            )
    print(json.dumps({"indexed": len(pending), "skipped": len(rows) - len(pending)}))


def cmd_search(args):
    conn = connect()
    rows = conn.execute("SELECT id, vec FROM papers").fetchall()
    if not rows:
        print(json.dumps({"ids": []}))
        return
    query_vec = embed([args.query])[0]
    def cosine(a):
        dot = sum(x * y for x, y in zip(query_vec, a))
        na = sum(x * x for x in query_vec) ** 0.5
        nb = sum(x * x for x in a) ** 0.5
        return dot / (na * nb) if na and nb else 0.0
    ranked = sorted(
        ((cosine(json.loads(vec)), pid) for pid, vec in rows),
        key=lambda t: t[0],
        reverse=True,
    )[: args.top_k]
    print(json.dumps({"ids": [pid for _, pid in ranked]}))


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_index = sub.add_parser("index-batch")
    p_index.add_argument("--jsonl", required=True)
    p_index.set_defaults(func=cmd_index_batch)
    p_search = sub.add_parser("search")
    p_search.add_argument("--query", required=True)
    p_search.add_argument("--top-k", type=int, default=20)
    p_search.set_defaults(func=cmd_search)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - degrade to keyword search upstream
        print(f"kb_vec.py: {exc}", file=sys.stderr)
        sys.exit(1)
