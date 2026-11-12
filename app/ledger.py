"""SQLite store: mandates, orders and a hash-chained, append-only audit log.

Each event stores the hash of the previous event, so editing or deleting any row
breaks the chain and verify_chain() reports the first broken sequence number.
"""
from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterator

from .crypto import canonical_json, sha256_hex
from .models import utcnow

GENESIS = "0" * 64
# Order states that count against the budget.
COMMITTED_STATES = ("reserved", "awaiting_approval", "captured")

SCHEMA = """
CREATE TABLE IF NOT EXISTS mandates (
    id TEXT PRIMARY KEY,
    jws TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    vault_id TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
    payment_mandate_id TEXT PRIMARY KEY,
    mandate_id TEXT NOT NULL,
    paypal_order_id TEXT UNIQUE,
    amount TEXT NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL,
    step_up INTEGER NOT NULL DEFAULT 0,
    approve_url TEXT,
    capture_id TEXT,
    cart_jws TEXT NOT NULL,
    request_jws TEXT NOT NULL,
    decision TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nonces (
    nonce TEXT PRIMARY KEY,
    seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    mandate_id TEXT,
    ref TEXT,
    payload TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL
);
"""


class Ledger:
    def __init__(self, db_path: Path | str):
        self.db_path = str(db_path)
        if self.db_path != ":memory:":
            Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        self._conn.executescript(SCHEMA)

    # ---- transactions -------------------------------------------------
    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """Serialised write transaction: budget check and reservation happen atomically."""
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield self._conn
                self._conn.execute("COMMIT")
            except Exception:
                self._conn.execute("ROLLBACK")
                raise

    # ---- audit log ----------------------------------------------------
    def append_event(self, type_: str, payload: dict[str, Any], mandate_id: str | None = None, ref: str | None = None) -> dict:
        with self._lock:
            row = self._conn.execute("SELECT hash FROM events ORDER BY seq DESC LIMIT 1").fetchone()
            prev = row["hash"] if row else GENESIS
            ts = utcnow().isoformat()
            body = canonical_json(payload)
            digest = sha256_hex(canonical_json({"ts": ts, "type": type_, "mandate_id": mandate_id, "ref": ref, "payload": body, "prev": prev}))
            cur = self._conn.execute(
                "INSERT INTO events (ts, type, mandate_id, ref, payload, prev_hash, hash) VALUES (?,?,?,?,?,?,?)",
                (ts, type_, mandate_id, ref, body, prev, digest),
            )
            return {"seq": cur.lastrowid, "ts": ts, "type": type_, "hash": digest}

    def events(self, mandate_id: str | None = None, ref: str | None = None, limit: int = 200) -> list[dict]:
        sql = "SELECT * FROM events"
        args: list[Any] = []
        clauses = []
        if mandate_id:
            clauses.append("mandate_id = ?")
            args.append(mandate_id)
        if ref:
            clauses.append("ref = ?")
            args.append(ref)
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY seq DESC LIMIT ?"
        args.append(limit)
        with self._lock:
            rows = self._conn.execute(sql, args).fetchall()
        return [{**dict(r), "payload": json.loads(r["payload"])} for r in rows]

    def verify_chain(self) -> dict:
        with self._lock:
            rows = self._conn.execute("SELECT * FROM events ORDER BY seq ASC").fetchall()
        prev = GENESIS
        for r in rows:
            expected = sha256_hex(canonical_json({"ts": r["ts"], "type": r["type"], "mandate_id": r["mandate_id"], "ref": r["ref"], "payload": r["payload"], "prev": prev}))
            if r["prev_hash"] != prev or r["hash"] != expected:
                return {"valid": False, "events": len(rows), "broken_at_seq": r["seq"]}
            prev = r["hash"]
        return {"valid": True, "events": len(rows), "head": prev}

    # ---- mandates ----------------------------------------------------
    def save_mandate(self, mandate_id: str, jws: str) -> None:
        with self._lock:
            self._conn.execute("INSERT INTO mandates (id, jws, created_at) VALUES (?,?,?)", (mandate_id, jws, utcnow().isoformat()))

    def get_mandate(self, mandate_id: str) -> dict | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM mandates WHERE id = ?", (mandate_id,)).fetchone()
        return dict(row) if row else None

    def list_mandates(self) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self._conn.execute("SELECT * FROM mandates ORDER BY created_at DESC").fetchall()]

    def set_mandate_status(self, mandate_id: str, status: str) -> None:
        with self._lock:
            self._conn.execute("UPDATE mandates SET status = ? WHERE id = ?", (status, mandate_id))

    def set_vault_id(self, mandate_id: str, vault_id: str) -> None:
        with self._lock:
            self._conn.execute("UPDATE mandates SET vault_id = ? WHERE id = ?", (vault_id, mandate_id))

    # ---- budget & orders ---------------------------------------------
    def committed(self, mandate_id: str, conn: sqlite3.Connection | None = None) -> Decimal:
        conn = conn or self._conn
        placeholders = ",".join("?" for _ in COMMITTED_STATES)
        rows = conn.execute(
            f"SELECT amount FROM orders WHERE mandate_id = ? AND status IN ({placeholders})",
            (mandate_id, *COMMITTED_STATES),
        ).fetchall()
        return sum((Decimal(r["amount"]) for r in rows), Decimal("0.00"))

    def captured(self, mandate_id: str) -> Decimal:
        with self._lock:
            rows = self._conn.execute("SELECT amount FROM orders WHERE mandate_id = ? AND status = 'captured'", (mandate_id,)).fetchall()
        return sum((Decimal(r["amount"]) for r in rows), Decimal("0.00"))

    def use_nonce(self, nonce: str, conn: sqlite3.Connection) -> bool:
        """Returns False if the nonce was already used (replayed request)."""
        try:
            conn.execute("INSERT INTO nonces (nonce, seen_at) VALUES (?,?)", (nonce, utcnow().isoformat()))
            return True
        except sqlite3.IntegrityError:
            return False

    def get_order_by_payment_mandate(self, pm_id: str, conn: sqlite3.Connection | None = None) -> dict | None:
        conn = conn or self._conn
        row = conn.execute("SELECT * FROM orders WHERE payment_mandate_id = ?", (pm_id,)).fetchone()
        return dict(row) if row else None

    def get_order(self, paypal_order_id: str) -> dict | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM orders WHERE paypal_order_id = ?", (paypal_order_id,)).fetchone()
        return dict(row) if row else None

    def insert_order(self, conn: sqlite3.Connection, **fields: Any) -> None:
        now = utcnow().isoformat()
        fields.setdefault("created_at", now)
        fields.setdefault("updated_at", now)
        cols = ",".join(fields)
        conn.execute(f"INSERT INTO orders ({cols}) VALUES ({','.join('?' for _ in fields)})", tuple(fields.values()))

    def update_order(self, payment_mandate_id: str, **fields: Any) -> None:
        fields["updated_at"] = utcnow().isoformat()
        sets = ",".join(f"{k} = ?" for k in fields)
        with self._lock:
            self._conn.execute(f"UPDATE orders SET {sets} WHERE payment_mandate_id = ?", (*fields.values(), payment_mandate_id))

    def list_orders(self, mandate_id: str | None = None) -> list[dict]:
        with self._lock:
            if mandate_id:
                rows = self._conn.execute("SELECT * FROM orders WHERE mandate_id = ? ORDER BY created_at DESC", (mandate_id,)).fetchall()
            else:
                rows = self._conn.execute("SELECT * FROM orders ORDER BY created_at DESC").fetchall()
        return [dict(r) for r in rows]
