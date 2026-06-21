"""Shared helpers for the AI service."""
from ..vbp_client import default_client, QueryResult, VBPError, VBPClient
from typing import Any


def clean(val: Any) -> Any:
    """Engine v1 returns SQL NULL as the literal string 'NULL' — clean it."""
    if val == "NULL" or val is None:
        return None
    return val


def _escape_literal(v: Any) -> str:
    """Escape a Python value for inlining into an SQL literal."""
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float)):
        return repr(v)
    s = str(v).replace("'", "''")
    return f"'{s}'"


def _inline_params(sql: str, params: list | None) -> str:
    """Replace %s placeholders with escaped literals.

    Engine v1 parser doesn't understand bound params, so we inline them.
    """
    if not params:
        return sql
    out_parts: list[str] = []
    idx = 0
    pi = 0
    while idx < len(sql):
        if sql[idx:idx + 2] == "%s" and pi < len(params):
            out_parts.append(_escape_literal(params[pi]))
            pi += 1
            idx += 2
        else:
            out_parts.append(sql[idx])
            idx += 1
    return "".join(out_parts)


def q(sql: str, params: list | None = None, columns: list[str] | None = None) -> list[dict]:
    """Short-hand: query + return list of dicts (engine-NULL cleaned)."""
    inlined = _inline_params(sql, params)
    result = default_client.query(inlined, None, columns=columns)
    if not result.columns and columns:
        result.columns = [(c, 0) for c in columns]
    out = []
    for row in result.rows:
        d = {}
        for i, (name, _) in enumerate(result.columns):
            d[name] = clean(row[i]) if i < len(row) else None
        out.append(d)
    return out


def q1(sql: str, params: list | None = None, columns: list[str] | None = None) -> dict | None:
    rows = q(sql, params, columns)
    return rows[0] if rows else None
