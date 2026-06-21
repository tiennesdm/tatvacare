"""
Python VBP client (mirror of backend/lib/vbp.mjs + engine client.go).

Wire format (VBP_SPEC.md §2):
  +--------+---------+-----+-----+-----+----------+...+
  | 'VDB'  | len_le4 | seq | op  | flg |  body    |
  +--------+---------+-----+-----+-----+----------+...+
  | 3 B    | 4 B     | 1 B | 1 B | 1 B | (len-2)B |

OP_QUERY (0x06) body: [u32 query_id][u32 text_len][text utf-8][u16 param_count][params...]
Each param: [u16 type_id][u8 null_tag][body]
  - fixed-width types: body = exactly FixedWidth bytes
  - variable-width:   body = [u32 len][bytes]

Response frames (multiple):
  OP_DATA_CHUNK (0x0A): [u32 chunk_id][u32 row_count][u16 col_count]
    + per col: [u16 type_id][u8 bmp_size][null_bitmap]
    + col body: fixed=row_count*width; variable=for each row [u32 len][bytes]
  OP_ROWS_FINISHED (0x0B): [u64 rows_affected][u32 tag_len][tag][u32 exec_time_us]
  OP_COMMAND_COMPLETE (0x0C): 1 byte status
  OP_ERROR (0x0D): [5 sqlstate][u32 msg_len][msg][u32 detail_len][detail][u32 hint_len][hint][u32 position]
"""
from __future__ import annotations
import socket
import struct
import threading
from dataclasses import dataclass, field
from typing import Any

from .config import VBP_HOST, VBP_PORT

MAGIC = b"VDB"
HDR_LEN = 3 + 4 + 1  # 8 bytes

# Opcodes (u8)
OP_CLIENT_HELLO = 0x01
OP_SERVER_READY = 0x02
OP_AUTH_CHALLENGE = 0x03
OP_AUTH_RESPONSE = 0x04
OP_AUTH_OK = 0x05
OP_QUERY = 0x06
OP_DATA_CHUNK = 0x0A
OP_ROWS_FINISHED = 0x0B
OP_COMMAND_COMPLETE = 0x0C
OP_ERROR = 0x0D
OP_PING = 0x16
OP_PONG = 0x17

# Type IDs (u16)
T_BOOL = 16
T_INT2 = 21
T_INT4 = 23
T_INT8 = 20
T_FLOAT4 = 700
T_FLOAT8 = 701
T_TEXT = 25
T_VARCHAR = 1043
T_DATE = 1082
T_TIMESTAMP = 1114
T_NUMERIC = 1700

FIXED_WIDTH = {
    T_BOOL: 1, T_INT4: 4, T_FLOAT4: 4,
    T_INT8: 8, T_FLOAT8: 8, T_TIMESTAMP: 8,
}


@dataclass
class QueryResult:
    columns: list[tuple[str, int]] = field(default_factory=list)  # [(name, type_id)]
    rows: list[list[Any]] = field(default_factory=list)
    command_tag: str = ""
    rows_affected: int = 0

    def to_dicts(self) -> list[dict]:
        return [dict(zip((c[0] for c in self.columns), r)) for r in self.rows]


class VBPError(Exception):
    pass


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("socket closed")
        buf.extend(chunk)
    return bytes(buf)


def _recv_frame(sock: socket.socket) -> tuple[int, int, int, bytes]:
    """Receive one frame. Returns (seq, op, flags, body).

    Header is 8 bytes: magic(3) + payload_len(4) + seq(1).
    Payload is op(1) + flags(1) + body.
    """
    header = _recv_exact(sock, HDR_LEN)
    if header[:3] != MAGIC:
        raise VBPError(f"bad magic: {header[:3]!r}")
    payload_len = struct.unpack_from("<I", header, 3)[0]
    seq = header[7]
    payload = _recv_exact(sock, payload_len)
    op = payload[0]
    flags = payload[1]
    body = payload[2:]
    return seq, op, flags, body


def _encode_frame(seq: int, op: int, flags: int, body: bytes) -> bytes:
    # payload = op(1) + flags(1) + body — seq is in HEADER (byte 7), not in payload
    payload = bytes([op & 0xFF, flags & 0xFF]) + body
    payload_len = len(payload)
    return MAGIC + struct.pack("<I", payload_len) + bytes([seq & 0xFF]) + payload


def _encode_param(value: Any) -> bytes:
    """Encode one parameter: [u16 type_id][u8 null_tag][body]."""
    if value is None:
        return struct.pack("<HB", T_TEXT, 0)
    if isinstance(value, bool):
        return struct.pack("<HB", T_BOOL, 1) + struct.pack("<?", value)
    if isinstance(value, int):
        return struct.pack("<HB", T_INT8, 1) + struct.pack("<q", value)
    if isinstance(value, float):
        return struct.pack("<HB", T_FLOAT8, 1) + struct.pack("<d", value)
    # text
    s = str(value).encode("utf-8")
    body = struct.pack("<I", len(s)) + s
    return struct.pack("<HB", T_TEXT, 1) + body


def _encode_query_body(query_id: int, sql: str, params: list[Any]) -> bytes:
    sql_bytes = sql.encode("utf-8")
    body = struct.pack("<II", query_id, len(sql_bytes)) + sql_bytes
    body += struct.pack("<H", len(params))
    for p in params:
        body += _encode_param(p)
    return body


def _decode_value(type_id: int, raw: bytes) -> Any:
    if type_id == T_BOOL:
        return bool(raw[0])
    if type_id == T_INT4:
        return struct.unpack("<i", raw)[0]
    if type_id == T_INT8:
        return struct.unpack("<q", raw)[0]
    if type_id == T_FLOAT4:
        return struct.unpack("<f", raw)[0]
    if type_id == T_FLOAT8:
        return struct.unpack("<d", raw)[0]
    if type_id == T_TIMESTAMP:
        return raw.decode("utf-8", errors="replace")
    if type_id in (T_TEXT, T_VARCHAR):
        return raw.decode("utf-8", errors="replace")
    if type_id == T_NUMERIC:
        try:
            return float(raw.decode("utf-8"))
        except ValueError:
            return raw.decode("utf-8", errors="replace")
    if type_id == T_DATE:
        return raw.decode("utf-8", errors="replace")
    # Default
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return repr(raw)


def _decode_data_chunk(body: bytes, acc_cols: list[tuple[str, int]], acc_rows: list[list[Any]]):
    """Decode a DATA_CHUNK body, appending to accumulators."""
    if len(body) < 10:
        return
    # chunk_id u32, row_count u32, col_count u16
    row_count = struct.unpack_from("<I", body, 4)[0]
    col_count = struct.unpack_from("<H", body, 8)[0]
    off = 10
    col_types: list[int] = []
    col_widths: list[int] = []
    col_is_var: list[bool] = []
    col_nulls: list[bytes | None] = []
    col_data_start: list[int] = []
    for c in range(col_count):
        if off + 3 > len(body):
            return
        tid = struct.unpack_from("<H", body, off)[0]
        bmp_size = body[off + 2]
        off += 3
        col_types.append(tid)
        col_nulls.append(body[off:off + bmp_size] if bmp_size > 0 else None)
        off += bmp_size
        col_data_start.append(off)
        w = FIXED_WIDTH.get(tid, 0)
        col_widths.append(w)
        col_is_var.append(w == 0)
        if w > 0:
            off += row_count * w
        else:
            for _ in range(row_count):
                if off + 4 > len(body):
                    off = len(body)
                    break
                ln = struct.unpack_from("<I", body, off)[0]
                off += 4 + ln

    # Build rows
    for r in range(row_count):
        row: list[Any] = []
        for c in range(col_count):
            tid = col_types[c]
            nulls = col_nulls[c]
            if nulls is not None:
                byte_idx = r >> 3
                bit_idx = r & 7
                if byte_idx < len(nulls) and (nulls[byte_idx] & (1 << bit_idx)):
                    row.append(None)
                    continue
            start = col_data_start[c]
            if col_is_var[c]:
                # walk to row r
                o = start
                for pr in range(r):
                    if o + 4 > len(body):
                        o = len(body)
                        break
                    ln = struct.unpack_from("<I", body, o)[0]
                    o += 4 + ln
                if o + 4 > len(body):
                    row.append(None)
                    continue
                ln = struct.unpack_from("<I", body, o)[0]
                payload = body[o + 4:o + 4 + ln]
                row.append(_decode_value(tid, payload))
            else:
                w = col_widths[c]
                payload = body[start + r * w:start + r * w + w]
                row.append(_decode_value(tid, payload))
        acc_rows.append(row)


def _decode_error(body: bytes) -> str:
    if len(body) < 9:
        return body.decode("utf-8", errors="replace")
    sqlstate = body[:5].decode("ascii", errors="replace")
    msg_len = struct.unpack_from("<I", body, 5)[0]
    msg = body[9:9 + msg_len].decode("utf-8", errors="replace")
    return f"[{sqlstate}] {msg}"


class VBPClient:
    """Thread-safe VBP client with persistent connection + per-seq response routing."""

    def __init__(self, host: str = VBP_HOST, port: int = VBP_PORT):
        self.host = host
        self.port = port
        self._lock = threading.Lock()
        self._sock: socket.socket | None = None
        self._next_seq = 1
        self._buf = bytearray()

    def _connect(self):
        if self._sock is not None:
            return
        s = socket.create_connection((self.host, self.port), timeout=10)
        s.settimeout(15)
        self._sock = s
        # VBP requires CLIENT_HELLO handshake first
        self._handshake()

    def _handshake(self):
        """Send CLIENT_HELLO, expect SERVER_READY + (AUTH_CHALLENGE | AUTH_OK)."""
        # Build CLIENT_HELLO body:
        #   u16 version (=1) + u16 client_flags + u32 len+user + u32 len+db + u8 actor_kind + u32 len+actor_id
        user = b"ai_service"
        db = b"tatvacare"
        actor_id = b"ai-service-1"
        body = struct.pack("<HH", 1, 0)  # version + client_flags
        body += struct.pack("<I", len(user)) + user
        body += struct.pack("<I", len(db)) + db
        body += struct.pack("<B", 1)  # actor_kind
        body += struct.pack("<I", len(actor_id)) + actor_id
        self._sock.sendall(_encode_frame(1, OP_CLIENT_HELLO, 0, body))
        # Read frames until AUTH_OK (no-auth mode) or AUTH_CHALLENGE
        seen_ok = False
        deadline_loops = 10
        for _ in range(deadline_loops):
            rseq, op, flags, body = _recv_frame(self._sock)
            if op == OP_AUTH_OK:
                seen_ok = True
                break
            if op == OP_AUTH_CHALLENGE:
                # Auth required — engine v1 dev mode usually skips this.
                # Reply with empty AUTH_RESPONSE; engine should accept.
                empty = struct.pack("<I", 0)
                self._sock.sendall(_encode_frame(rseq, OP_AUTH_RESPONSE, 0, empty))
                continue
            if op == OP_SERVER_READY:
                # Auth-required flag is at body offset 8
                if len(body) >= 9 and body[8] == 0:
                    # no auth required → AUTH_OK already received (handleClientHello
                    # writes both frames); loop to next
                    continue
                continue
            if op == OP_ERROR:
                raise VBPError(_decode_error(body))
        if not seen_ok:
            raise VBPError("handshake: AUTH_OK not received")

    def _alloc_seq(self) -> int:
        seq = self._next_seq
        self._next_seq = (self._next_seq + 1) & 0xFF
        if self._next_seq == 0:
            self._next_seq = 1
        return seq

    def _send_query(self, sql: str, params: list[Any]) -> int:
        seq = self._alloc_seq()
        body = _encode_query_body(seq, sql, params)
        frame = _encode_frame(seq, OP_QUERY, 0, body)
        try:
            self._sock.sendall(frame)
        except (BrokenPipeError, ConnectionError, OSError):
            # Connection died — reconnect and retry once
            self._sock = None
            self._connect()
            seq = self._alloc_seq()
            body = _encode_query_body(seq, sql, params)
            frame = _encode_frame(seq, OP_QUERY, 0, body)
            self._sock.sendall(frame)
        return seq

    def _read_until_done(self, seq: int) -> QueryResult:
        """Read frames until we get COMMAND_COMPLETE or ERROR for this seq."""
        result = QueryResult()
        deadline_loops = 50
        while deadline_loops > 0:
            deadline_loops -= 1
            try:
                rseq, op, flags, body = _recv_frame(self._sock)
            except (BrokenPipeError, ConnectionError, OSError) as e:
                raise VBPError(f"connection lost: {e}")
            if rseq != seq and op != OP_DATA_CHUNK:
                # unsolicited; ignore (e.g. unsolicited PING/PONG)
                continue
            if op == OP_DATA_CHUNK:
                _decode_data_chunk(body, result.columns, result.rows)
            elif op == OP_ROWS_FINISHED:
                if len(body) >= 12:
                    result.rows_affected = struct.unpack_from("<Q", body, 0)[0]
                    tag_len = struct.unpack_from("<I", body, 8)[0]
                    result.command_tag = body[12:12 + tag_len].decode("utf-8", errors="replace")
            elif op == OP_COMMAND_COMPLETE:
                return result
            elif op == OP_ERROR:
                raise VBPError(_decode_error(body))
        raise VBPError("timed out reading response")

    def query(self, sql: str, params: list[Any] | None = None, columns: list[str] | None = None) -> QueryResult:
        params = params or []
        with self._lock:
            self._connect()
            seq = self._send_query(sql, params)
            result = self._read_until_done(seq)
        if columns and len(result.columns) == 0 and result.rows:
            # Engine v1 doesn't send column names in DATA_CHUNK.
            # Use provided column list.
            for c in columns:
                result.columns.append((c, 0))
        return result

    def query_dicts(self, sql: str, params: list[Any] | None = None,
                     columns: list[str] | None = None) -> list[dict]:
        result = self.query(sql, params, columns=columns)
        if not result.columns and columns:
            result.columns = [(c, 0) for c in columns]
        return result.to_dicts()

    def close(self):
        if self._sock:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None


# Module-level singleton (cheap connection per process)
default_client = VBPClient()
