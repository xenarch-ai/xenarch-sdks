"""Idempotency-Key minting for link creation.

The platform honors ``Idempotency-Key`` on ``POST /v1/links`` and returns the
cached link only when the *same body + key* arrives twice — so a fresh key per
create dedupes a network-level retry of one create request. (A re-run of
``create(params)`` mints a fresh nonce, i.e. a different body, so it makes a
new link; cross-invocation dedup isn't possible without a stable nonce.) The
jsonl is an append-only audit trail of issued keys. Mirrors the CLI's
``idempotency.ts``.
"""
from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

_CONFIG_DIR = Path(os.path.expanduser("~")) / ".xenarch"


def new_key() -> str:
    """A fresh idempotency key (UUID4 hex, ``idem_`` prefixed)."""
    return f"idem_{uuid.uuid4().hex}"


def record(key: str, *, created_at: int, config_dir: str | Path | None = None) -> None:
    """Append a key to the local audit log. Best-effort — never raises."""
    directory = Path(config_dir) if config_dir else _CONFIG_DIR
    try:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        line = json.dumps({"key": key, "created_at": created_at})
        with (directory / "idempotency.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        # An unwritable home dir must not block a create.
        pass
