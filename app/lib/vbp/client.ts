/**
 * VBP client (TypeScript) — talks to Vedadb's native Veda Binary Protocol
 * on TCP port 6381. NO PG-wire, NO HTTP fallback.
 *
 * Reference: vedadb-engine/internal/wire/vbp/frame.go + client.go
 *
 * Wire frame (VBP v1):
 *   [3-byte magic "VDB"] [u32 payload_len] [u8 seq] [u8 op] [u8 flags] [body]
 *   payload_len = 2 + body.length   (op + flags + body)
 *
 * QUERY body (A.6):
 *   [u32 query_id] [u32 text_len] [text] [u16 param_count] [params...]
 *
 * Response chain (per QUERY, all frames share the same seq):
 *   OP_DATA_CHUNK  → 0..N rows
 *   OP_ROWS_FINISHED → rowsAffected + commandTag
 *   OP_COMMAND_COMPLETE → terminator (or OP_ERROR at any time)
 */

import { createConnection, Socket } from 'node:net';
import { randomBytes } from 'node:crypto';

// Opcodes (VBP v1)
const OP_CLIENT_HELLO = 0x01;
const OP_SERVER_READY = 0x02;
const OP_AUTH_OK = 0x05;
const OP_QUERY = 0x06;
const OP_DATA_CHUNK = 0x0a;
const OP_ROWS_FINISHED = 0x0b;
const OP_COMMAND_COMPLETE = 0x0c;
const OP_ERROR = 0x0d;
const OP_BEGIN = 0x0e;
const OP_COMMIT = 0x0f;
const OP_ROLLBACK = 0x10;
const OP_PING = 0x16;
const OP_PONG = 0x17;
const OP_CLOSE = 0x18;

// Type IDs
const T_BOOL = 16;
const T_INT2 = 21;
const T_INT4 = 23;
const T_INT8 = 20;
const T_FLOAT4 = 700;
const T_FLOAT8 = 701;
const T_TEXT = 25;
const T_VARCHAR = 1043;
const T_BYTEA = 17;
const T_UUID = 2950;
const T_DATE = 1082;
const T_TIMESTAMP = 1114;
const T_TIMESTAMPTZ = 1184;
const T_NUMERIC = 1700;
const T_JSONB = 3802;

const FIXED_WIDTH: Record<number, number> = {
  [T_BOOL]: 1, [T_INT2]: 2, [T_INT4]: 4, [T_INT8]: 8,
  [T_FLOAT4]: 4, [T_FLOAT8]: 8, [T_UUID]: 16, [T_TIMESTAMP]: 8, [T_TIMESTAMPTZ]: 8,
  [T_DATE]: 4, [T_NUMERIC]: 8,
};

export type VBPValue = string | number | boolean | bigint | Date | null | Uint8Array;
export interface VBPResult {
  rows: VBPValue[][];
  columnTypes: number[];
  commandTag: string;
  rowsAffected: number;
}
export class VBPError extends Error {
  sqlstate: string;
  constructor(sqlstate: string, message: string) {
    super(`[${sqlstate}] ${message}`);
    this.name = 'VBPError';
    this.sqlstate = sqlstate;
  }
}

interface VBPFrame { seq: number; op: number; flags: number; body: Buffer; }
interface PendingCall {
  resolve: (frames: VBPFrame[]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  frames: VBPFrame[];
  isAccumulating: boolean;  // true for QUERY (multi-frame), false for single-response ops
}

class VBPConn {
  private sock: Socket;
  private buf = Buffer.alloc(0);
  private seqCounter = 1;
  private pending = new Map<number, PendingCall>();
  private _closed = false;
  constructor(public host: string, public port: number) {
    this.sock = createConnection(port, host);
  }
  private nextSeq(): number {
    for (let i = 0; i < 256; i++) {
      const s = (this.seqCounter + i) & 0xff;
      if (s === 0) continue;
      if (!this.pending.has(s)) { this.seqCounter = (s + 1) & 0xff; return s; }
    }
    throw new VBPError('08006', 'no free sequence IDs (all 1..255 in use)');
  }
  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error) => { this.sock.off('connect', onOk); reject(e); };
      const onOk = () => { this.sock.off('error', onErr); this.sock.on('error', (e) => this._onSocketError(e)); this.sock.on('close', () => this._onSocketClose()); this.beginRead(); this.handshake().then(resolve, reject); };
      this.sock.once('error', onErr);
      this.sock.once('connect', onOk);
    });
  }
  private async handshake(): Promise<void> {
    // CLIENT_HELLO body: u32 version(0x000A0000=v1) + u8 proto(1) + u8 mech(0=NONE) + u16 reserved + u32 caps
    const body = Buffer.alloc(12);
    body.writeUInt32LE(0x000a0000, 0);
    body.writeUInt8(0x01, 4);
    body.writeUInt8(0x00, 5); // AUTH_MECH_NONE
    body.writeUInt16LE(0, 6);
    body.writeUInt32LE(0, 8);
    // HELLO uses seq 0 (server-bound) — no response routing
    await this._sendRaw(0, OP_CLIENT_HELLO, 0, body);
    // Wait for SERVER_READY + AUTH_OK (both with seq=0 from server)
    await this._awaitHello();
  }
  private _awaitHello(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new VBPError('08006', 'VBP handshake timeout')), 5000);
      const onFrame = (f: VBPFrame) => {
        if (f.op === OP_AUTH_OK) { clearTimeout(timer); this.off('frame', onFrame); resolve(); }
        else if (f.op === OP_ERROR) {
          clearTimeout(timer); this.off('frame', onFrame);
          const sqlstate = f.body.slice(0, 5).toString('ascii');
          const msgLen = f.body.readUInt32LE(5);
          const msg = f.body.slice(9, 9 + msgLen).toString('utf-8');
          reject(new VBPError(sqlstate, msg));
        }
      };
      this.on('frame', onFrame);
    });
  }
  // Event emitter (handshake-only)
  private listeners: Record<string, ((f: VBPFrame) => void)[]> = {};
  on(ev: string, fn: (f: VBPFrame) => void) { (this.listeners[ev] ||= []).push(fn); }
  off(ev: string, fn: (f: VBPFrame) => void) { this.listeners[ev] = (this.listeners[ev] || []).filter(f => f !== fn); }
  private emit(ev: string, f: VBPFrame) { for (const fn of (this.listeners[ev] || [])) fn(f); }

  private beginRead() {
    this.sock.on('data', (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      while (true) {
        if (this.buf.length < 8) return;
        if (this.buf[0] !== 0x56 || this.buf[1] !== 0x44 || this.buf[2] !== 0x42) {
          this.buf = this.buf.subarray(3);
          continue;
        }
        const payloadLen = this.buf.readUInt32LE(3);
        if (this.buf.length < 8 + payloadLen) return;
        const seq = this.buf[7];
        const op = this.buf[8];
        const flags = this.buf[9];
        const body = this.buf.subarray(10, 10 + payloadLen - 2);
        this.buf = this.buf.subarray(8 + payloadLen);
        const frame: VBPFrame = { seq, op, flags, body };
        this._routeFrame(frame);
      }
    });
  }
  private _onSocketError(e: Error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); }
    this.pending.clear();
  }
  private _onSocketClose() {
    this._closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new VBPError('08006', 'connection closed')); }
    this.pending.clear();
  }
  private _routeFrame(f: VBPFrame) {
    if (f.seq === 0) { this.emit('frame', f); return; }  // server-bound (handshake, push notifications)
    const p = this.pending.get(f.seq);
    if (!p) return;
    if (f.op === OP_ERROR) {
      this.pending.delete(f.seq);
      clearTimeout(p.timer);
      const sqlstate = f.body.slice(0, 5).toString('ascii');
      const msgLen = f.body.readUInt32LE(5);
      const msg = f.body.slice(9, 9 + msgLen).toString('utf-8');
      p.reject(new VBPError(sqlstate, msg));
      return;
    }
    p.frames.push(f);
    if (p.isAccumulating) {
      if (f.op === OP_COMMAND_COMPLETE) {
        this.pending.delete(f.seq);
        clearTimeout(p.timer);
        p.resolve(p.frames);
      }
    } else {
      // single-response op: PING→PONG, BEGIN/COMMIT/ROLLBACK→COMMAND_COMPLETE
      this.pending.delete(f.seq);
      clearTimeout(p.timer);
      p.resolve(p.frames);
    }
  }

  private _sendRaw(seq: number, op: number, flags: number, body: Buffer): Promise<void> {
    const payloadLen = 2 + body.length;
    const frame = Buffer.alloc(8 + payloadLen);
    frame[0] = 0x56; frame[1] = 0x44; frame[2] = 0x42;  // "VDB"
    frame.writeUInt32LE(payloadLen, 3);
    frame[7] = seq & 0xff;
    frame[8] = op;
    frame[9] = flags;
    body.copy(frame, 10);
    return new Promise((resolve, reject) => {
      this.sock.write(frame, (err) => err ? reject(err) : resolve());
    });
  }
  private _call<T>(seq: number, op: number, flags: number, body: Buffer, opts: { timeoutMs?: number; accumulating?: boolean } = {}): Promise<VBPFrame[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new VBPError('57014', 'VBP call timeout'));
      }, opts.timeoutMs ?? 15000);
      const p: PendingCall = { resolve, reject, timer, frames: [], isAccumulating: !!opts.accumulating };
      this.pending.set(seq, p);
      this._sendRaw(seq, op, flags, body).catch((e) => {
        clearTimeout(timer); this.pending.delete(seq); reject(e);
      });
    });
  }

  async query(sql: string): Promise<VBPResult> {
    const seq = this.nextSeq();
    const sqlBuf = Buffer.from(sql, 'utf-8');
    const body = Buffer.alloc(4 + 4 + sqlBuf.length + 2);
    let o = 0;
    body.writeUInt32LE(seq, o); o += 4;  // query_id = seq
    body.writeUInt32LE(sqlBuf.length, o); o += 4;
    sqlBuf.copy(body, o); o += sqlBuf.length;
    body.writeUInt16LE(0, o); o += 2;  // param_count = 0
    const frames = await this._call(seq, OP_QUERY, 0, body, { timeoutMs: 15000, accumulating: true });
    const result: VBPResult = { rows: [], columnTypes: [], commandTag: '', rowsAffected: 0 };
    for (const f of frames) {
      if (f.op === OP_DATA_CHUNK) {
        const { rows, colTypes } = this._decodeDataChunk(f.body);
        result.rows.push(...rows);
        if (colTypes.length) result.columnTypes = colTypes;
      } else if (f.op === OP_ROWS_FINISHED) {
        let off = 0;
        result.rowsAffected = Number(f.body.readBigUInt64LE(off)); off += 8;
        const tagLen = f.body.readUInt32LE(off); off += 4;
        result.commandTag = f.body.slice(off, off + tagLen).toString('utf-8');
      } else if (f.op === OP_COMMAND_COMPLETE) { /* terminator */ }
    }
    return result;
  }
  private _decodeDataChunk(body: Buffer): { rows: VBPValue[][]; colTypes: number[] } {
    if (body.length < 10) throw new Error(`DATA_CHUNK short: ${body.length}`);
    const rowCount = body.readUInt32LE(4);
    const colCount = body.readUInt16LE(8);
    const colTypes: number[] = [];
    const colBodies: Buffer[] = [];
    const colNulls: (Buffer | null)[] = [];
    const colWidths: number[] = [];
    let off = 10;
    for (let c = 0; c < colCount; c++) {
      if (off + 3 > body.length) throw new Error(`col ${c} header truncated`);
      const tid = body.readUInt16LE(off); off += 2;
      const bmpSize = body.readUInt8(off); off += 1;
      colTypes.push(tid);
      let nullBmp: Buffer | null = null;
      if (bmpSize > 0) { nullBmp = body.slice(off, off + bmpSize); off += bmpSize; }
      colNulls.push(nullBmp);
      colBodies.push(body.slice(off));
      const w = FIXED_WIDTH[tid] || 0;
      colWidths.push(w);
      if (w > 0) off += rowCount * w;
      else for (let r = 0; r < rowCount; r++) { const ln = body.readUInt32LE(off); off += 4 + ln; }
    }
    const rows: VBPValue[][] = [];
    for (let r = 0; r < rowCount; r++) {
      const row: VBPValue[] = [];
      for (let c = 0; c < colCount; c++) {
        const isNull = colNulls[c] && ((colNulls[c]![r >> 3] & (1 << (r & 7))) !== 0);
        if (isNull) { row.push(null); continue; }
        const b = colBodies[c];
        const w = colWidths[c];
        if (w > 0) {
          const o = r * w;
          row.push(this._decodeValue(colTypes[c], b.subarray(o, o + w)));
        } else {
          let o = 0;
          for (let pr = 0; pr < r; pr++) { const ln = b.readUInt32LE(o); o += 4 + ln; }
          const ln = b.readUInt32LE(o);
          const payload = b.subarray(o + 4, o + 4 + ln);
          row.push(this._decodeValue(colTypes[c], payload));
        }
      }
      rows.push(row);
    }
    return { rows, colTypes };
  }
  private _decodeValue(tid: number, b: Buffer): VBPValue {
    switch (tid) {
      case T_BOOL: return b.readUInt8(0) !== 0;
      case T_INT2: return b.readInt16LE(0);
      case T_INT4: return b.readInt32LE(0);
      case T_INT8: return Number(b.readBigInt64LE(0));
      case T_FLOAT4: return b.readFloatLE(0);
      case T_FLOAT8: return b.readDoubleLE(0);
      case T_TEXT:
      case T_VARCHAR: return b.toString('utf-8');
      case T_UUID: {
        const h = b.toString('hex');
        return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
      }
      case T_TIMESTAMP:
      case T_TIMESTAMPTZ: {
        const us = Number(b.readBigInt64LE(0));
        return new Date(us / 1000);
      }
      case T_DATE: {
        const days = b.readInt32LE(0);
        return new Date(Date.UTC(2000, 0, 1) + days * 86400000);
      }
      case T_BYTEA: return new Uint8Array(b);
      case T_NUMERIC: return parseFloat(b.toString('utf-8'));
      case T_JSONB: try { return JSON.parse(b.toString('utf-8')); } catch { return b.toString('utf-8'); }
      default: return b.toString('hex');
    }
  }

  async ping(): Promise<bigint> {
    const seq = this.nextSeq();
    const nonce = randomBytes(8);
    const frames = await this._call(seq, OP_PING, 0, nonce, { timeoutMs: 5000 });
    if (frames[0].op !== OP_PONG) throw new VBPError('08P01', 'expected PONG');
    return BigInt('0x' + frames[0].body.toString('hex'));
  }
  async begin(): Promise<void> {
    const seq = this.nextSeq();
    await this._call(seq, OP_BEGIN, 0, Buffer.alloc(0), { timeoutMs: 10000 });
  }
  async commit(): Promise<void> {
    const seq = this.nextSeq();
    await this._call(seq, OP_COMMIT, 0, Buffer.alloc(0), { timeoutMs: 10000 });
  }
  async rollback(): Promise<void> {
    const seq = this.nextSeq();
    await this._call(seq, OP_ROLLBACK, 0, Buffer.alloc(0), { timeoutMs: 10000 });
  }
  async close(): Promise<void> {
    if (this._closed) return;
    try { await this._sendRaw(this.nextSeq(), OP_CLOSE, 0, Buffer.alloc(0)); } catch { /* ignore */ }
    this.sock.end();
    this._closed = true;
  }
}

export class VBPClient {
  private conn: VBPConn | null = null;
  constructor(private host = '127.0.0.1', private port = 6381) {}
  async connect(): Promise<void> {
    this.conn = new VBPConn(this.host, this.port);
    await this.conn.connect();
  }
  async query<T = any>(sql: string): Promise<{ rows: T[]; rowCount: number; commandTag: string; rowsAffected: number }> {
    if (!this.conn) throw new VBPError('08006', 'not connected');
    const r = await this.conn.query(sql);
    return { rows: r.rows as T[], rowCount: r.rows.length, commandTag: r.commandTag, rowsAffected: r.rowsAffected };
  }
  async ping(): Promise<bigint> { if (!this.conn) throw new VBPError('08006', 'not connected'); return this.conn.ping(); }
  async withTx<T>(fn: (client: VBPClient) => Promise<T>): Promise<T> {
    if (!this.conn) throw new VBPError('08006', 'not connected');
    await this.conn.begin();
    try { const out = await fn(this); await this.conn.commit(); return out; }
    catch (e) { try { await this.conn.rollback(); } catch { /* ignore */ } throw e; }
  }
  async close(): Promise<void> { if (this.conn) await this.conn.close(); this.conn = null; }
}

export class VBPPool {
  private free: VBPClient[] = [];
  private busy = new Set<VBPClient>();
  constructor(private host = '127.0.0.1', private port = 6381, public max = 8) {}
  async acquire(): Promise<VBPClient> {
    if (this.free.length > 0) { const c = this.free.pop()!; this.busy.add(c); return c; }
    if (this.busy.size < this.max) {
      const c = new VBPClient(this.host, this.port);
      await c.connect();
      this.busy.add(c);
      return c;
    }
    await new Promise(r => setTimeout(r, 10));
    return this.acquire();
  }
  release(c: VBPClient) { this.busy.delete(c); this.free.push(c); }
  async query<T = any>(sql: string): Promise<{ rows: T[]; rowCount: number; commandTag: string; rowsAffected: number }> {
    const c = await this.acquire();
    try { return await c.query<T>(sql); }
    finally { this.release(c); }
  }
  async withTx<T>(fn: (c: VBPClient) => Promise<T>): Promise<T> {
    const c = await this.acquire();
    try { return await c.withTx(fn); }
    finally { this.release(c); }
  }
  async closeAll(): Promise<void> { for (const c of this.free) await c.close(); this.free = []; }
}
