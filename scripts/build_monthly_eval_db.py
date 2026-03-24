#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable


@dataclass(frozen=True)
class MonthWindow:
    month: str
    start: datetime
    end: datetime


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build a monthly SQLite archive for the OpenAlice paper-trading evaluation.",
    )
    parser.add_argument(
        "--month",
        required=True,
        help="Month to archive in YYYY-MM format, e.g. 2026-03.",
    )
    parser.add_argument(
        "--source-root",
        default="/tmp/openalice-review/data",
        help="OpenAlice data directory to archive.",
    )
    parser.add_argument(
        "--archive-root",
        default=None,
        help="Directory where the monthly archive should be written. Defaults to <repo>/data/archive/monthly.",
    )
    return parser.parse_args()


def month_window(month: str) -> MonthWindow:
    start = datetime.strptime(month, "%Y-%m").replace(tzinfo=UTC)
    year = start.year + (1 if start.month == 12 else 0)
    next_month = 1 if start.month == 12 else start.month + 1
    end = start.replace(year=year, month=next_month)
    return MonthWindow(month=month, start=start, end=end)


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    normalized = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def parse_epoch_millis(value: Any) -> datetime | None:
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(int(value) / 1000, tz=UTC)
    except Exception:
        return None


def within_month(timestamp: datetime | None, window: MonthWindow) -> bool:
    return timestamp is not None and window.start <= timestamp < window.end


def copy_file(source_root: Path, raw_root: Path, relative_path: str) -> Path | None:
    source_path = source_root / relative_path
    if not source_path.exists():
        return None
    target_path = raw_root / relative_path
    ensure_dir(target_path.parent)
    shutil.copy2(source_path, target_path)
    return target_path


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def stringify_output(value: Any) -> str:
    if isinstance(value, str):
        return value
    return json_dumps(value)


def read_json_file(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def discover_relative_paths(source_root: Path, pattern: str) -> list[str]:
    return sorted(
        str(path.relative_to(source_root))
        for path in source_root.rglob(pattern)
        if path.is_file()
    )


def detect_trading_commit_paths(source_root: Path) -> list[str]:
    paths = discover_relative_paths(source_root, "commit.json")
    allowed_roots = {"trading", "securities-trading", "crypto-trading"}
    results: list[str] = []
    for relative_path in paths:
        first_part = Path(relative_path).parts[0]
        if first_part in allowed_roots:
            results.append(relative_path)
    return sorted(set(results))


def trading_account_id(relative_path: str) -> str:
    path = Path(relative_path)
    parts = path.parts
    if len(parts) >= 3 and parts[0] == "trading":
        return parts[1]
    return path.parent.name


def extract_operation_symbol(operation: dict[str, Any]) -> str | None:
    action = operation.get("action")
    if action not in {"placeOrder", "closePosition"}:
        return None
    contract = operation.get("contract") or {}
    if not isinstance(contract, dict):
        return None
    symbol = contract.get("symbol") or contract.get("aliceId")
    return str(symbol) if symbol else None


def to_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except Exception:
        return None


def create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        PRAGMA journal_mode = WAL;

        CREATE TABLE IF NOT EXISTS archive_meta (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS file_inventory (
          relative_path TEXT PRIMARY KEY,
          file_sha256 TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          modified_at TEXT NOT NULL,
          raw_copy_path TEXT,
          captured_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS events (
          seq INTEGER PRIMARY KEY,
          ts_ms INTEGER NOT NULL,
          ts_iso TEXT NOT NULL,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          channel TEXT,
          target TEXT,
          prompt TEXT,
          reply TEXT,
          duration_ms INTEGER
        );

        CREATE TABLE IF NOT EXISTS session_messages (
          uuid TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          role TEXT NOT NULL,
          provider TEXT NOT NULL,
          parent_uuid TEXT,
          content_text TEXT,
          raw_json TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_session_messages_session_id
          ON session_messages(session_id, timestamp);

        CREATE TABLE IF NOT EXISTS news_items (
          seq INTEGER PRIMARY KEY,
          ts_ms INTEGER NOT NULL,
          ts_iso TEXT NOT NULL,
          pub_ts_ms INTEGER,
          pub_ts_iso TEXT,
          source TEXT,
          title TEXT NOT NULL,
          content TEXT,
          link TEXT,
          guid TEXT,
          dedup_key TEXT,
          metadata_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS file_snapshots (
          relative_path TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          content_type TEXT NOT NULL,
          file_sha256 TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tool_calls (
          seq INTEGER PRIMARY KEY,
          tool_call_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          duration_ms INTEGER NOT NULL,
          ts_ms INTEGER NOT NULL,
          ts_iso TEXT NOT NULL,
          input_json TEXT NOT NULL,
          output_text TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_tool_calls_session_name
          ON tool_calls(session_id, name, ts_ms);

        CREATE TABLE IF NOT EXISTS brain_commits (
          hash TEXT PRIMARY KEY,
          parent_hash TEXT,
          timestamp TEXT NOT NULL,
          commit_type TEXT NOT NULL,
          message TEXT NOT NULL,
          frontal_lobe TEXT,
          emotion TEXT,
          raw_json TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_brain_commits_timestamp
          ON brain_commits(timestamp);

        CREATE TABLE IF NOT EXISTS trading_commits (
          account_id TEXT NOT NULL,
          source_relative_path TEXT NOT NULL,
          hash TEXT NOT NULL,
          parent_hash TEXT,
          timestamp TEXT NOT NULL,
          message TEXT NOT NULL,
          round INTEGER,
          operation_count INTEGER NOT NULL,
          success_count INTEGER NOT NULL,
          rejected_count INTEGER NOT NULL,
          net_liquidation REAL,
          total_cash_value REAL,
          unrealized_pnl REAL,
          realized_pnl REAL,
          positions_json TEXT,
          pending_orders_json TEXT,
          raw_json TEXT NOT NULL,
          PRIMARY KEY(account_id, hash)
        );

        CREATE INDEX IF NOT EXISTS idx_trading_commits_account_timestamp
          ON trading_commits(account_id, timestamp);

        CREATE TABLE IF NOT EXISTS trading_operations (
          account_id TEXT NOT NULL,
          commit_hash TEXT NOT NULL,
          op_index INTEGER NOT NULL,
          timestamp TEXT NOT NULL,
          action TEXT NOT NULL,
          symbol TEXT,
          status TEXT,
          success INTEGER,
          order_id TEXT,
          error TEXT,
          operation_json TEXT NOT NULL,
          result_json TEXT,
          PRIMARY KEY(account_id, commit_hash, op_index)
        );

        CREATE INDEX IF NOT EXISTS idx_trading_operations_symbol
          ON trading_operations(symbol, timestamp);

        CREATE TABLE IF NOT EXISTS alpaca_market_seconds (
          source_relative_path TEXT NOT NULL,
          source_line INTEGER NOT NULL,
          account_id TEXT NOT NULL,
          feed TEXT NOT NULL,
          sample_ts TEXT NOT NULL,
          market_open INTEGER,
          next_open TEXT,
          next_close TEXT,
          market_clock_ts TEXT,
          symbol_count INTEGER NOT NULL,
          raw_json TEXT NOT NULL,
          PRIMARY KEY(source_relative_path, source_line)
        );

        CREATE INDEX IF NOT EXISTS idx_alpaca_market_seconds_sample_ts
          ON alpaca_market_seconds(sample_ts);

        CREATE INDEX IF NOT EXISTS idx_alpaca_market_seconds_account_ts
          ON alpaca_market_seconds(account_id, sample_ts);

        CREATE TABLE IF NOT EXISTS alpaca_market_second_symbols (
          source_relative_path TEXT NOT NULL,
          source_line INTEGER NOT NULL,
          account_id TEXT NOT NULL,
          sample_ts TEXT NOT NULL,
          symbol TEXT NOT NULL,
          bid REAL,
          ask REAL,
          spread REAL,
          bid_size REAL,
          ask_size REAL,
          bid_exchange TEXT,
          ask_exchange TEXT,
          quote_ts TEXT,
          last REAL,
          last_size REAL,
          trade_exchange TEXT,
          trade_conditions_json TEXT NOT NULL,
          tape TEXT,
          trade_ts TEXT,
          raw_json TEXT NOT NULL,
          PRIMARY KEY(source_relative_path, source_line, symbol)
        );

        CREATE INDEX IF NOT EXISTS idx_alpaca_market_second_symbols_symbol_ts
          ON alpaca_market_second_symbols(symbol, sample_ts);

        CREATE TABLE IF NOT EXISTS alpaca_trade_updates (
          source_relative_path TEXT NOT NULL,
          source_line INTEGER NOT NULL,
          account_id TEXT NOT NULL,
          ts TEXT NOT NULL,
          event TEXT NOT NULL,
          order_id TEXT,
          client_order_id TEXT,
          symbol TEXT,
          side TEXT,
          status TEXT,
          qty TEXT,
          filled_qty TEXT,
          filled_avg_price REAL,
          raw_json TEXT NOT NULL,
          PRIMARY KEY(source_relative_path, source_line)
        );

        CREATE INDEX IF NOT EXISTS idx_alpaca_trade_updates_ts
          ON alpaca_trade_updates(ts);

        CREATE INDEX IF NOT EXISTS idx_alpaca_trade_updates_symbol_ts
          ON alpaca_trade_updates(symbol, ts);

        CREATE TABLE IF NOT EXISTS alpaca_account_snapshots (
          source_relative_path TEXT NOT NULL,
          source_line INTEGER NOT NULL,
          account_id TEXT NOT NULL,
          ts TEXT NOT NULL,
          reason TEXT NOT NULL,
          market_open INTEGER,
          next_open TEXT,
          next_close TEXT,
          market_clock_ts TEXT,
          net_liquidation REAL,
          total_cash_value REAL,
          unrealized_pnl REAL,
          realized_pnl REAL,
          buying_power REAL,
          day_trades_remaining REAL,
          position_count INTEGER NOT NULL,
          open_order_count INTEGER NOT NULL,
          excluded_symbols_json TEXT,
          excluded_position_count INTEGER,
          excluded_order_count INTEGER,
          excluded_market_value REAL,
          excluded_unrealized_pnl REAL,
          evaluation_net_liquidation REAL,
          evaluation_total_cash_value REAL,
          evaluation_unrealized_pnl REAL,
          evaluation_realized_pnl REAL,
          evaluation_buying_power REAL,
          evaluation_day_trades_remaining REAL,
          evaluation_position_count INTEGER,
          evaluation_open_order_count INTEGER,
          evaluation_positions_json TEXT,
          evaluation_open_orders_json TEXT,
          positions_json TEXT NOT NULL,
          open_orders_json TEXT NOT NULL,
          raw_json TEXT NOT NULL,
          PRIMARY KEY(source_relative_path, source_line)
        );

        CREATE INDEX IF NOT EXISTS idx_alpaca_account_snapshots_ts
          ON alpaca_account_snapshots(ts);

        CREATE INDEX IF NOT EXISTS idx_alpaca_account_snapshots_account_ts
          ON alpaca_account_snapshots(account_id, ts);
        """
    )
    conn.commit()


def existing_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    cursor = conn.execute(f"PRAGMA table_info({table})")
    return {str(row[1]) for row in cursor.fetchall()}


def ensure_table_columns(conn: sqlite3.Connection, table: str, columns: dict[str, str]) -> None:
    current = existing_columns(conn, table)
    for name, definition in columns.items():
        if name in current:
            continue
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")
    conn.commit()


def ensure_schema_migrations(conn: sqlite3.Connection) -> None:
    ensure_table_columns(
        conn,
        "alpaca_account_snapshots",
        {
            "excluded_symbols_json": "TEXT",
            "excluded_position_count": "INTEGER",
            "excluded_order_count": "INTEGER",
            "excluded_market_value": "REAL",
            "excluded_unrealized_pnl": "REAL",
            "evaluation_net_liquidation": "REAL",
            "evaluation_total_cash_value": "REAL",
            "evaluation_unrealized_pnl": "REAL",
            "evaluation_realized_pnl": "REAL",
            "evaluation_buying_power": "REAL",
            "evaluation_day_trades_remaining": "REAL",
            "evaluation_position_count": "INTEGER",
            "evaluation_open_order_count": "INTEGER",
            "evaluation_positions_json": "TEXT",
            "evaluation_open_orders_json": "TEXT",
        },
    )


def upsert_meta(conn: sqlite3.Connection, key: str, value: dict[str, Any]) -> None:
    conn.execute(
        """
        INSERT INTO archive_meta(key, value_json)
        VALUES(?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
        """,
        (key, json_dumps(value)),
    )


def ingest_inventory(
    conn: sqlite3.Connection,
    source_root: Path,
    raw_root: Path,
    relative_paths: Iterable[str],
) -> None:
    captured_at = datetime.now(tz=UTC).isoformat()
    for relative_path in sorted(set(relative_paths)):
        source_path = source_root / relative_path
        if not source_path.exists() or not source_path.is_file():
            continue
        raw_copy = copy_file(source_root, raw_root, relative_path)
        stat = source_path.stat()
        conn.execute(
            """
            INSERT INTO file_inventory(relative_path, file_sha256, size_bytes, modified_at, raw_copy_path, captured_at)
            VALUES(?, ?, ?, ?, ?, ?)
            ON CONFLICT(relative_path) DO UPDATE SET
              file_sha256 = excluded.file_sha256,
              size_bytes = excluded.size_bytes,
              modified_at = excluded.modified_at,
              raw_copy_path = excluded.raw_copy_path,
              captured_at = excluded.captured_at
            """,
            (
                relative_path,
                sha256_file(source_path),
                stat.st_size,
                datetime.fromtimestamp(stat.st_mtime, tz=UTC).isoformat(),
                str(raw_copy) if raw_copy else None,
                captured_at,
            ),
        )


def ingest_file_snapshots(conn: sqlite3.Connection, source_root: Path, relative_paths: Iterable[str]) -> None:
    for relative_path in sorted(set(relative_paths)):
        source_path = source_root / relative_path
        if not source_path.exists() or not source_path.is_file():
            continue
        content = source_path.read_text(encoding="utf-8")
        content_type = "json" if source_path.suffix == ".json" else "markdown" if source_path.suffix == ".md" else "text"
        conn.execute(
            """
            INSERT INTO file_snapshots(relative_path, content, content_type, file_sha256)
            VALUES(?, ?, ?, ?)
            ON CONFLICT(relative_path) DO UPDATE SET
              content = excluded.content,
              content_type = excluded.content_type,
              file_sha256 = excluded.file_sha256
            """,
            (
                relative_path,
                content,
                content_type,
                hashlib.sha256(content.encode("utf-8")).hexdigest(),
            ),
        )


def ingest_events(conn: sqlite3.Connection, source_root: Path, window: MonthWindow) -> int:
    path = source_root / "event-log/events.jsonl"
    if not path.exists():
        return 0
    count = 0
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            ts = parse_epoch_millis(row.get("ts"))
            if not within_month(ts, window):
                continue
            payload = row.get("payload") or {}
            conn.execute(
                """
                INSERT OR REPLACE INTO events(seq, ts_ms, ts_iso, event_type, payload_json, channel, target, prompt, reply, duration_ms)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    int(row["seq"]),
                    int(row["ts"]),
                    ts.isoformat(),
                    row.get("type"),
                    json_dumps(payload),
                    payload.get("channel"),
                    payload.get("to"),
                    payload.get("prompt"),
                    payload.get("reply"),
                    payload.get("durationMs"),
                ),
            )
            count += 1
    return count


def normalize_session_content(message: dict[str, Any]) -> str | None:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(str(item.get("text", "")))
        return "\n".join(part for part in parts if part) or None
    return None


def ingest_sessions(conn: sqlite3.Connection, source_root: Path, window: MonthWindow) -> int:
    sessions_root = source_root / "sessions"
    if not sessions_root.exists():
        return 0
    count = 0
    for path in sessions_root.rglob("*.jsonl"):
        session_id = str(path.relative_to(sessions_root)).removesuffix(".jsonl")
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                timestamp = parse_iso_datetime(row.get("timestamp"))
                if not within_month(timestamp, window):
                    continue
                message = row.get("message") or {}
                conn.execute(
                    """
                    INSERT OR REPLACE INTO session_messages(uuid, session_id, timestamp, role, provider, parent_uuid, content_text, raw_json)
                    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        row.get("uuid"),
                        row.get("sessionId") or session_id,
                        timestamp.isoformat(),
                        message.get("role") or row.get("type"),
                        row.get("provider"),
                        row.get("parentUuid"),
                        normalize_session_content(message),
                        json_dumps(row),
                    ),
                )
                count += 1
    return count


def ingest_news(conn: sqlite3.Connection, source_root: Path, window: MonthWindow) -> int:
    path = source_root / "news-collector/news.jsonl"
    if not path.exists():
        return 0
    count = 0
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            ts = parse_epoch_millis(row.get("ts"))
            pub_ts = parse_epoch_millis(row.get("pubTs"))
            if not (within_month(ts, window) or within_month(pub_ts, window)):
                continue
            metadata = row.get("metadata") or {}
            conn.execute(
                """
                INSERT OR REPLACE INTO news_items(
                  seq, ts_ms, ts_iso, pub_ts_ms, pub_ts_iso, source, title, content, link, guid, dedup_key, metadata_json
                )
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    int(row["seq"]),
                    int(row["ts"]),
                    ts.isoformat() if ts else None,
                    int(row["pubTs"]) if row.get("pubTs") is not None else None,
                    pub_ts.isoformat() if pub_ts else None,
                    metadata.get("source"),
                    row.get("title"),
                    row.get("content"),
                    metadata.get("link"),
                    metadata.get("guid"),
                    row.get("dedupKey"),
                    json_dumps(metadata),
                ),
            )
            count += 1
    return count


def ingest_tool_calls(conn: sqlite3.Connection, source_root: Path, window: MonthWindow) -> int:
    path = source_root / "tool-calls/tool-calls.jsonl"
    if not path.exists():
        return 0
    count = 0
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            ts = parse_epoch_millis(row.get("timestamp"))
            if not within_month(ts, window):
                continue
            conn.execute(
                """
                INSERT OR REPLACE INTO tool_calls(
                  seq, tool_call_id, session_id, name, status, duration_ms, ts_ms, ts_iso, input_json, output_text
                )
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    int(row["seq"]),
                    row.get("id"),
                    row.get("sessionId"),
                    row.get("name"),
                    row.get("status") or "ok",
                    int(row.get("durationMs") or 0),
                    int(row["timestamp"]),
                    ts.isoformat(),
                    json_dumps(row.get("input")),
                    stringify_output(row.get("output")),
                ),
            )
            count += 1
    return count


def ingest_brain_commits(conn: sqlite3.Connection, source_root: Path, window: MonthWindow) -> int:
    path = source_root / "brain/commit.json"
    if not path.exists():
        return 0
    state = read_json_file(path)
    commits = state.get("commits") or []
    count = 0
    for commit in commits:
        if not isinstance(commit, dict):
            continue
        timestamp = parse_iso_datetime(commit.get("timestamp"))
        if not within_month(timestamp, window):
            continue
        state_after = commit.get("stateAfter") or {}
        conn.execute(
            """
            INSERT OR REPLACE INTO brain_commits(
              hash, parent_hash, timestamp, commit_type, message, frontal_lobe, emotion, raw_json
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                commit.get("hash"),
                commit.get("parentHash"),
                timestamp.isoformat(),
                commit.get("type"),
                commit.get("message"),
                state_after.get("frontalLobe"),
                state_after.get("emotion"),
                json_dumps(commit),
            ),
        )
        count += 1
    return count


def ingest_trading_commits(conn: sqlite3.Connection, source_root: Path, window: MonthWindow) -> tuple[int, int]:
    commit_count = 0
    operation_count = 0
    for relative_path in detect_trading_commit_paths(source_root):
        path = source_root / relative_path
        state = read_json_file(path)
        commits = state.get("commits") or []
        account_id = trading_account_id(relative_path)
        for commit in commits:
            if not isinstance(commit, dict):
                continue
            timestamp = parse_iso_datetime(commit.get("timestamp"))
            if not within_month(timestamp, window):
                continue
            operations = commit.get("operations") or []
            results = commit.get("results") or []
            state_after = commit.get("stateAfter") or {}
            success_count = sum(
                1 for result in results if isinstance(result, dict) and result.get("success") is True
            )
            rejected_count = sum(
                1
                for result in results
                if isinstance(result, dict) and (result.get("status") == "rejected" or result.get("success") is False)
            )
            conn.execute(
                """
                INSERT OR REPLACE INTO trading_commits(
                  account_id, source_relative_path, hash, parent_hash, timestamp, message, round,
                  operation_count, success_count, rejected_count, net_liquidation, total_cash_value,
                  unrealized_pnl, realized_pnl, positions_json, pending_orders_json, raw_json
                )
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    account_id,
                    relative_path,
                    commit.get("hash"),
                    commit.get("parentHash"),
                    timestamp.isoformat(),
                    commit.get("message"),
                    commit.get("round"),
                    len(operations),
                    success_count,
                    rejected_count,
                    state_after.get("netLiquidation"),
                    state_after.get("totalCashValue"),
                    state_after.get("unrealizedPnL"),
                    state_after.get("realizedPnL"),
                    json_dumps(state_after.get("positions")),
                    json_dumps(state_after.get("pendingOrders")),
                    json_dumps(commit),
                ),
            )
            commit_count += 1

            for index, operation in enumerate(operations):
                if not isinstance(operation, dict):
                    continue
                result = results[index] if index < len(results) and isinstance(results[index], dict) else None
                conn.execute(
                    """
                    INSERT OR REPLACE INTO trading_operations(
                      account_id, commit_hash, op_index, timestamp, action, symbol, status, success,
                      order_id, error, operation_json, result_json
                    )
                    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        account_id,
                        commit.get("hash"),
                        index,
                        timestamp.isoformat(),
                        operation.get("action"),
                        extract_operation_symbol(operation),
                        result.get("status") if result else None,
                        int(result.get("success")) if result and result.get("success") is not None else None,
                        result.get("orderId") if result else None,
                        result.get("error") if result else None,
                        json_dumps(operation),
                        json_dumps(result) if result is not None else None,
                    ),
                )
                operation_count += 1
    return commit_count, operation_count


def ingest_alpaca_market_seconds(conn: sqlite3.Connection, source_root: Path, window: MonthWindow) -> tuple[int, int]:
    root = source_root / "alpaca-eval/market-seconds"
    if not root.exists():
        return 0, 0
    sample_count = 0
    symbol_count = 0
    for path in sorted(root.rglob("*.jsonl")):
        relative_path = str(path.relative_to(source_root))
        with path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, start=1):
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                sample_ts = parse_iso_datetime(row.get("sampleTs"))
                if not within_month(sample_ts, window):
                    continue
                market_clock = row.get("marketClock") if isinstance(row.get("marketClock"), dict) else {}
                symbols = row.get("symbols") if isinstance(row.get("symbols"), dict) else {}
                conn.execute(
                    """
                    INSERT OR REPLACE INTO alpaca_market_seconds(
                      source_relative_path, source_line, account_id, feed, sample_ts,
                      market_open, next_open, next_close, market_clock_ts, symbol_count, raw_json
                    )
                    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        relative_path,
                        line_number,
                        row.get("accountId"),
                        row.get("feed"),
                        sample_ts.isoformat(),
                        int(bool(market_clock.get("isOpen"))) if market_clock.get("isOpen") is not None else None,
                        market_clock.get("nextOpen"),
                        market_clock.get("nextClose"),
                        market_clock.get("timestamp"),
                        len(symbols),
                        json_dumps(row),
                    ),
                )
                sample_count += 1

                for symbol, symbol_row in symbols.items():
                    if not isinstance(symbol_row, dict):
                        continue
                    conn.execute(
                        """
                        INSERT OR REPLACE INTO alpaca_market_second_symbols(
                          source_relative_path, source_line, account_id, sample_ts, symbol,
                          bid, ask, spread, bid_size, ask_size, bid_exchange, ask_exchange,
                          quote_ts, last, last_size, trade_exchange, trade_conditions_json, tape, trade_ts, raw_json
                        )
                        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            relative_path,
                            line_number,
                            row.get("accountId"),
                            sample_ts.isoformat(),
                            symbol,
                            to_float(symbol_row.get("bid")),
                            to_float(symbol_row.get("ask")),
                            to_float(symbol_row.get("spread")),
                            to_float(symbol_row.get("bidSize")),
                            to_float(symbol_row.get("askSize")),
                            symbol_row.get("bidExchange"),
                            symbol_row.get("askExchange"),
                            symbol_row.get("quoteTimestamp"),
                            to_float(symbol_row.get("last")),
                            to_float(symbol_row.get("lastSize")),
                            symbol_row.get("tradeExchange"),
                            json_dumps(symbol_row.get("tradeConditions") or []),
                            symbol_row.get("tape"),
                            symbol_row.get("tradeTimestamp"),
                            json_dumps(symbol_row),
                        ),
                    )
                    symbol_count += 1
    return sample_count, symbol_count


def ingest_alpaca_trade_updates(conn: sqlite3.Connection, source_root: Path, window: MonthWindow) -> int:
    root = source_root / "alpaca-eval/trade-updates"
    if not root.exists():
        return 0
    count = 0
    for path in sorted(root.rglob("*.jsonl")):
        relative_path = str(path.relative_to(source_root))
        with path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, start=1):
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                ts = parse_iso_datetime(row.get("ts"))
                if not within_month(ts, window):
                    continue
                conn.execute(
                    """
                    INSERT OR REPLACE INTO alpaca_trade_updates(
                      source_relative_path, source_line, account_id, ts, event, order_id,
                      client_order_id, symbol, side, status, qty, filled_qty, filled_avg_price, raw_json
                    )
                    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        relative_path,
                        line_number,
                        row.get("accountId"),
                        ts.isoformat(),
                        row.get("event"),
                        row.get("orderId"),
                        row.get("clientOrderId"),
                        row.get("symbol"),
                        row.get("side"),
                        row.get("status"),
                        row.get("qty"),
                        row.get("filledQty"),
                        to_float(row.get("filledAvgPrice")),
                        json_dumps(row),
                    ),
                )
                count += 1
    return count


def ingest_alpaca_account_snapshots(conn: sqlite3.Connection, source_root: Path, window: MonthWindow) -> int:
    root = source_root / "alpaca-eval/account-snapshots"
    if not root.exists():
        return 0
    count = 0
    for path in sorted(root.rglob("*.jsonl")):
        relative_path = str(path.relative_to(source_root))
        with path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, start=1):
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                ts = parse_iso_datetime(row.get("ts"))
                if not within_month(ts, window):
                    continue
                market_clock = row.get("marketClock") if isinstance(row.get("marketClock"), dict) else {}
                account = row.get("account") if isinstance(row.get("account"), dict) else {}
                positions = row.get("positions") if isinstance(row.get("positions"), list) else []
                open_orders = row.get("openOrders") if isinstance(row.get("openOrders"), list) else []
                evaluation = row.get("evaluation") if isinstance(row.get("evaluation"), dict) else {}
                evaluation_account = evaluation.get("account") if isinstance(evaluation.get("account"), dict) else {}
                evaluation_positions = (
                    evaluation.get("positions") if isinstance(evaluation.get("positions"), list) else positions
                )
                evaluation_open_orders = (
                    evaluation.get("openOrders") if isinstance(evaluation.get("openOrders"), list) else open_orders
                )
                excluded_symbols = (
                    evaluation.get("excludedSymbols") if isinstance(evaluation.get("excludedSymbols"), list) else []
                )
                conn.execute(
                    """
                    INSERT OR REPLACE INTO alpaca_account_snapshots(
                      source_relative_path, source_line, account_id, ts, reason,
                      market_open, next_open, next_close, market_clock_ts, net_liquidation,
                      total_cash_value, unrealized_pnl, realized_pnl, buying_power, day_trades_remaining,
                      position_count, open_order_count, excluded_symbols_json, excluded_position_count,
                      excluded_order_count, excluded_market_value, excluded_unrealized_pnl,
                      evaluation_net_liquidation, evaluation_total_cash_value, evaluation_unrealized_pnl,
                      evaluation_realized_pnl, evaluation_buying_power, evaluation_day_trades_remaining,
                      evaluation_position_count, evaluation_open_order_count, evaluation_positions_json,
                      evaluation_open_orders_json, positions_json, open_orders_json, raw_json
                    )
                    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        relative_path,
                        line_number,
                        row.get("accountId"),
                        ts.isoformat(),
                        row.get("reason"),
                        int(bool(market_clock.get("isOpen"))) if market_clock.get("isOpen") is not None else None,
                        market_clock.get("nextOpen"),
                        market_clock.get("nextClose"),
                        market_clock.get("timestamp"),
                        to_float(account.get("netLiquidation")),
                        to_float(account.get("totalCashValue")),
                        to_float(account.get("unrealizedPnL")),
                        to_float(account.get("realizedPnL")),
                        to_float(account.get("buyingPower")),
                        to_float(account.get("dayTradesRemaining")),
                        len(positions),
                        len(open_orders),
                        json_dumps(excluded_symbols),
                        int(evaluation.get("excludedPositionCount") or 0),
                        int(evaluation.get("excludedOrderCount") or 0),
                        to_float(evaluation.get("excludedMarketValue")),
                        to_float(evaluation.get("excludedUnrealizedPnL")),
                        to_float(evaluation_account.get("netLiquidation")),
                        to_float(evaluation_account.get("totalCashValue")),
                        to_float(evaluation_account.get("unrealizedPnL")),
                        to_float(evaluation_account.get("realizedPnL")),
                        to_float(evaluation_account.get("buyingPower")),
                        to_float(evaluation_account.get("dayTradesRemaining")),
                        len(evaluation_positions),
                        len(evaluation_open_orders),
                        json_dumps(evaluation_positions),
                        json_dumps(evaluation_open_orders),
                        json_dumps(positions),
                        json_dumps(open_orders),
                        json_dumps(row),
                    ),
                )
                count += 1
    return count


def fetch_count(conn: sqlite3.Connection, table: str) -> int:
    cursor = conn.execute(f"SELECT COUNT(*) FROM {table}")
    return int(cursor.fetchone()[0])


def main() -> None:
    args = parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    source_root = Path(args.source_root).resolve()
    archive_root = Path(args.archive_root).resolve() if args.archive_root else repo_root / "data/archive/monthly"
    window = month_window(args.month)

    if not source_root.exists():
        raise SystemExit(f"Source root does not exist: {source_root}")

    month_dir = archive_root / window.month
    raw_root = month_dir / "raw"
    ensure_dir(raw_root)
    ensure_dir(month_dir)

    db_path = month_dir / f"alice_eval_{window.month}.sqlite"
    conn = sqlite3.connect(db_path)
    try:
        create_schema(conn)
        ensure_schema_migrations(conn)

        inventory_paths = [
            "event-log/events.jsonl",
            "news-collector/news.jsonl",
            "tool-calls/tool-calls.jsonl",
            "cron/jobs.json",
            "brain/persona.md",
            "brain/heartbeat.md",
            "brain/commit.json",
            "brain/frontal-lobe.md",
            "brain/emotion-log.md",
            "default/persona.default.md",
            "default/heartbeat.default.md",
            "config/accounts.json",
            "config/platforms.json",
            "config/crypto.json",
            "config/securities.json",
            "config/engine.json",
            "config/heartbeat.json",
            "config/alpaca-eval.json",
            "config/news.json",
            "config/connectors.json",
            "config/agent.json",
            "config/ai-provider-manager.json",
            "config/compaction.json",
            "config/market-data.json",
            "config/tools.json",
        ]
        inventory_paths.extend(
            str(path.relative_to(source_root))
            for path in (source_root / "sessions").rglob("*.jsonl")
            if path.is_file()
        )
        inventory_paths.extend(
            str(path.relative_to(source_root))
            for path in (source_root / "alpaca-eval").rglob("*.jsonl")
            if path.is_file()
        )
        inventory_paths.extend(detect_trading_commit_paths(source_root))
        ingest_inventory(conn, source_root, raw_root, inventory_paths)
        ingest_file_snapshots(
            conn,
            source_root,
            [
                "brain/persona.md",
                "brain/heartbeat.md",
                "brain/commit.json",
                "brain/frontal-lobe.md",
                "brain/emotion-log.md",
                "default/persona.default.md",
                "default/heartbeat.default.md",
                "config/accounts.json",
                "config/platforms.json",
                "config/crypto.json",
                "config/securities.json",
                "config/engine.json",
                "config/heartbeat.json",
                "config/alpaca-eval.json",
                "config/news.json",
                "config/connectors.json",
                "config/agent.json",
                "config/ai-provider-manager.json",
                "config/compaction.json",
                "config/market-data.json",
                "config/tools.json",
                "cron/jobs.json",
            ],
        )

        events_ingested = ingest_events(conn, source_root, window)
        sessions_ingested = ingest_sessions(conn, source_root, window)
        news_ingested = ingest_news(conn, source_root, window)
        tool_calls_ingested = ingest_tool_calls(conn, source_root, window)
        brain_commits_ingested = ingest_brain_commits(conn, source_root, window)
        trading_commits_ingested, trading_operations_ingested = ingest_trading_commits(conn, source_root, window)
        alpaca_market_seconds_ingested, alpaca_market_second_symbols_ingested = ingest_alpaca_market_seconds(conn, source_root, window)
        alpaca_trade_updates_ingested = ingest_alpaca_trade_updates(conn, source_root, window)
        alpaca_account_snapshots_ingested = ingest_alpaca_account_snapshots(conn, source_root, window)

        upsert_meta(
            conn,
            "archive_info",
            {
                "month": window.month,
                "built_at": datetime.now(tz=UTC).isoformat(),
                "source_root": str(source_root),
                "repo_root": str(repo_root),
                "archive_root": str(month_dir),
            },
        )
        upsert_meta(
            conn,
            "counts",
            {
                "events_ingested": events_ingested,
                "session_messages_ingested": sessions_ingested,
                "news_items_ingested": news_ingested,
                "tool_calls_ingested": tool_calls_ingested,
                "brain_commits_ingested": brain_commits_ingested,
                "trading_commits_ingested": trading_commits_ingested,
                "trading_operations_ingested": trading_operations_ingested,
                "alpaca_market_seconds_ingested": alpaca_market_seconds_ingested,
                "alpaca_market_second_symbols_ingested": alpaca_market_second_symbols_ingested,
                "alpaca_trade_updates_ingested": alpaca_trade_updates_ingested,
                "alpaca_account_snapshots_ingested": alpaca_account_snapshots_ingested,
                "events_rows": fetch_count(conn, "events"),
                "session_messages_rows": fetch_count(conn, "session_messages"),
                "news_rows": fetch_count(conn, "news_items"),
                "tool_calls_rows": fetch_count(conn, "tool_calls"),
                "brain_commits_rows": fetch_count(conn, "brain_commits"),
                "trading_commits_rows": fetch_count(conn, "trading_commits"),
                "trading_operations_rows": fetch_count(conn, "trading_operations"),
                "alpaca_market_seconds_rows": fetch_count(conn, "alpaca_market_seconds"),
                "alpaca_market_second_symbols_rows": fetch_count(conn, "alpaca_market_second_symbols"),
                "alpaca_trade_updates_rows": fetch_count(conn, "alpaca_trade_updates"),
                "alpaca_account_snapshots_rows": fetch_count(conn, "alpaca_account_snapshots"),
                "file_inventory_rows": fetch_count(conn, "file_inventory"),
                "file_snapshots_rows": fetch_count(conn, "file_snapshots"),
            },
        )
        conn.commit()

        manifest = {
            "month": window.month,
            "built_at": datetime.now(tz=UTC).isoformat(),
            "source_root": str(source_root),
            "database": str(db_path),
            "raw_root": str(raw_root),
            "counts": {
                "events": fetch_count(conn, "events"),
                "session_messages": fetch_count(conn, "session_messages"),
                "news_items": fetch_count(conn, "news_items"),
                "tool_calls": fetch_count(conn, "tool_calls"),
                "brain_commits": fetch_count(conn, "brain_commits"),
                "trading_commits": fetch_count(conn, "trading_commits"),
                "trading_operations": fetch_count(conn, "trading_operations"),
                "alpaca_market_seconds": fetch_count(conn, "alpaca_market_seconds"),
                "alpaca_market_second_symbols": fetch_count(conn, "alpaca_market_second_symbols"),
                "alpaca_trade_updates": fetch_count(conn, "alpaca_trade_updates"),
                "alpaca_account_snapshots": fetch_count(conn, "alpaca_account_snapshots"),
                "file_inventory": fetch_count(conn, "file_inventory"),
                "file_snapshots": fetch_count(conn, "file_snapshots"),
            },
        }
        (month_dir / "manifest.json").write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(json.dumps(manifest, indent=2, ensure_ascii=False))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
