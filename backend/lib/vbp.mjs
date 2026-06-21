// VBP client wrapper — uses SDK's multiplexer.call() for proper response routing
// Pure VBP wire protocol, port 6381. NO PG-wire.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const vbpSdk = require('/Users/shubhammehta/Desktop/vbp-php-wt/node/src/wire/vbp');
const opcodes = require('/Users/shubhammehta/Desktop/vbp-php-wt/node/src/wire/vbp/opcodes');
const { VBPConnection, VBPError } = vbpSdk;
const {
  OP_QUERY, OP_DATA_CHUNK, OP_ROWS_FINISHED, OP_COMMAND_COMPLETE, OP_ERROR,
  T_BOOL, T_INT2, T_INT4, T_INT8, T_FLOAT4, T_FLOAT8,
  T_TEXT, T_VARCHAR, T_UUID, T_DATE, T_TIMESTAMP, T_TIMESTAMPTZ, T_NUMERIC, T_JSONB,
} = opcodes;

const FIXED_WIDTH = {
  [T_BOOL]: 1, [T_INT2]: 2, [T_INT4]: 4, [T_INT8]: 8,
  [T_FLOAT4]: 4, [T_FLOAT8]: 8, [T_UUID]: 16, [T_TIMESTAMP]: 8, [T_TIMESTAMPTZ]: 8,
  [T_DATE]: 4, [T_NUMERIC]: 8,
};

function decodeValue(tid, b) {
  if (b == null) return null;
  switch (tid) {
    case T_BOOL: return b.readUInt8(0) !== 0;
    case T_INT2: return b.readInt16LE(0);
    case T_INT4: return b.readInt32LE(0);
    case T_INT8: return Number(b.readBigInt64LE(0));
    case T_FLOAT4: return b.readFloatLE(0);
    case T_FLOAT8: return b.readDoubleLE(0);
    case T_TEXT:
    case T_VARCHAR: return b.toString('utf-8');
    case T_UUID: { const h = b.toString('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`; }
    case T_TIMESTAMP:
    case T_TIMESTAMPTZ: return new Date(Number(b.readBigInt64LE(0)) / 1000);
    case T_DATE: return new Date(Date.UTC(2000, 0, 1) + b.readInt32LE(0) * 86400000);
    case T_NUMERIC: return parseFloat(b.toString('utf-8'));
    case T_JSONB: try { return JSON.parse(b.toString('utf-8')); } catch { return b.toString('utf-8'); }
    default: return b.toString('hex');
  }
}

function decodeDataChunk(body) {
  // vedadb-engine v1 DATA_CHUNK format:
  //   [u32 chunkId] [u32 rowCount] [u16 colCount]
  //   for each col: [u16 typeId] [u8 nullBmpSize] [nullBmp if size>0]
  //     then per-row data:
  //       fixed-width types: rowCount × FixedWidth(typeId) bytes
  //       variable-width: rowCount × (u32 len + bytes)
  //
  // After the engine bug fixes (2026-06-21), typeIds are now correct
  // for all TEXT columns. The decoder trusts the typeId's fixed/variable
  // classification (via FIXED_WIDTH lookup) and dispatches accordingly.
  if (!body || body.length < 10) return { rows: [], colTypes: [] };
  const rowCount = body.readUInt32LE(4);
  const colCount = body.readUInt16LE(8);
  const colTypes = [];
  const colWidths = [];
  const colIsVar = [];
  const colNulls = [];
  const colDataStart = [];
  let off = 10;
  for (let c = 0; c < colCount; c++) {
    if (off + 3 > body.length) break;
    const tid = body.readUInt16LE(off); off += 2;
    const bmpSize = body.readUInt8(off); off += 1;
    colTypes.push(tid);
    let nullBmp = null;
    if (bmpSize > 0) { nullBmp = body.slice(off, off + bmpSize); off += bmpSize; }
    colNulls.push(nullBmp);
    colDataStart.push(off);
    const w = (FIXED_WIDTH[tid] !== undefined) ? FIXED_WIDTH[tid] : 0;
    colWidths.push(w);
    colIsVar.push(w === 0);
    if (w > 0) {
      off += rowCount * w;
    } else {
      for (let r = 0; r < rowCount; r++) {
        if (off + 4 > body.length) { off = body.length; break; }
        const ln = body.readUInt32LE(off);
        if (off + 4 + ln > body.length) { off = body.length; break; }
        off += 4 + ln;
      }
    }
  }
  // Reassemble rows
  const rows = [];
  for (let r = 0; r < rowCount; r++) {
    const row = [];
    for (let c = 0; c < colCount; c++) {
      const isNull = colNulls[c] && ((colNulls[c][r >> 3] & (1 << (r & 7))) !== 0);
      if (isNull) { row.push(null); continue; }
      const start = colDataStart[c];
      const tid = colTypes[c];
      if (colIsVar[c]) {
        // variable-width: walk to row r
        let o = start;
        for (let pr = 0; pr < r; pr++) {
          if (o + 4 > body.length) { o = body.length; break; }
          const ln = body.readUInt32LE(o);
          o += 4 + ln;
        }
        if (o + 4 > body.length) { row.push(null); continue; }
        const ln = body.readUInt32LE(o);
        const payload = body.subarray(o + 4, o + 4 + ln);
        // Decode based on typeId
        if (tid === 16) {  // BOOL — 1 byte 0/1
          row.push(payload[0] === 1);
        } else if (tid === 20 || tid === 21 || tid === 23 || tid === 700 || tid === 701) {
          // INT/FLOAT — wire is just the bytes (no length prefix in body, but we read with prefix)
          // Actually the wire format puts u32 length before, so payload is the raw bytes
          const txt = payload.toString('utf-8').trim();
          const n = Number(txt);
          row.push(Number.isFinite(n) && txt.length < 30 ? n : txt);
        } else {
          // TEXT / VARCHAR / JSONB / etc.
          row.push(payload.toString('utf-8'));
        }
      } else {
        // fixed-width
        const w = colWidths[c];
        const o = start + r * w;
        const payload = body.subarray(o, o + w);
        row.push(decodeValue(tid, payload));
      }
    }
    rows.push(row);
  }
  return { rows, colTypes };
}

function encodeQueryBody(seq, sql) {
  const sqlBuf = Buffer.from(sql, 'utf-8');
  const body = Buffer.alloc(4 + 4 + sqlBuf.length + 2);
  let o = 0;
  body.writeUInt32LE(seq, o); o += 4;
  body.writeUInt32LE(sqlBuf.length, o); o += 4;
  sqlBuf.copy(body, o); o += sqlBuf.length;
  body.writeUInt16LE(0, o);  // param_count
  return body;
}

export class VBP {
  constructor(host = '127.0.0.1', port = 6381) { this.host = host; this.port = port; this.conn = null; }
  async connect() {
    this.conn = new VBPConnection({ host: this.host, port: this.port });
    await this.conn.connect();
  }
  async query(sql) {
    if (!this.conn) throw new Error('VBP not connected');
    const mux = this.conn._mux;
    if (!mux) throw new Error('VBP multiplexer not available');
    const seq = mux._alloc();
    const body = encodeQueryBody(seq, sql);
    const frames = await mux.call(OP_QUERY, body, { timeout: 15000 });
    // Note: mux.call() sends with the allocated seq, but we encoded the queryId = seq too
    // (engine uses queryId for tracking; for now we use the same seq)
    // Wait — mux.call() doesn't take a seq arg, it allocates internally.
    // The engine's queryId in the body can be anything; seq is allocated by mux.
    // So our body has queryId=our_chosen_seq but mux uses its own seq. Mismatch is fine
    // because the engine doesn't echo the queryId back — it just echoes the wire seq.
    const result = { rows: [], columnTypes: [], commandTag: '', rowsAffected: 0 };
    for (const f of frames) {
      if (f.op === OP_DATA_CHUNK) {
        const { rows, colTypes } = decodeDataChunk(f.body);
        result.rows.push(...rows);
        if (colTypes.length) result.columnTypes = colTypes;
      } else if (f.op === OP_ROWS_FINISHED) {
        let off = 0;
        result.rowsAffected = Number(f.body.readBigUInt64LE(off)); off += 8;
        const tagLen = f.body.readUInt32LE(off); off += 4;
        result.commandTag = f.body.slice(off, off + tagLen).toString('utf-8');
      } else if (f.op === OP_ERROR) {
        const sqlstate = f.body.slice(0, 5).toString('ascii');
        const msgLen = f.body.readUInt32LE(5);
        const msg = f.body.slice(9, 9 + msgLen).toString('utf-8');
        throw new VBPError(sqlstate, msg);
      }
    }
    return result;
  }
  async ping() { return this.conn.ping(); }
  async close() { return this.conn.close(); }
  static errorClass() { return VBPError; }
}

export class VBPPool {
  constructor(host = '127.0.0.1', port = 6381, max = 8) { this.host = host; this.port = port; this.max = max; this.free = []; this.busy = new Set(); }
  async acquire() {
    while (true) {
      if (this.free.length > 0) { const c = this.free.pop(); this.busy.add(c); return c; }
      if (this.busy.size < this.max) {
        const c = new VBP(this.host, this.port);
        await c.connect();
        this.busy.add(c);
        return c;
      }
      await new Promise(r => setTimeout(r, 5));
    }
  }
  release(c) { this.busy.delete(c); this.free.push(c); }
  async query(sql) {
    const c = await this.acquire();
    try { return await c.query(sql); }
    finally { this.release(c); }
  }
  async closeAll() { for (const c of this.free) await c.close(); this.free = []; }
}
