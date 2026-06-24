// TatvaCare SQL escape helpers — single source of truth.
//
// Why this exists:
//   The Vedadb VBP wire protocol currently takes SQL as a single string
//   (no parameter binding — see lib/vbp.mjs `async query(sql)`). Until
//   that ships, every literal that goes into a SQL string MUST be escaped
//   in one place so we can't drift. Scattered `.replace(/'/g, "''")` calls
//   were the source of (a) subtle double-escape bugs and (b) bypass of
//   backslash characters in non-ASCII inputs.
//
// What we escape:
//   - String literals (quoted with single quotes): ' → '' AND \ → \\
//     (backslash too because some engines treat backslash as escape).
//   - Identifiers (unquoted, used for column/table names we control): we
//     whitelist [a-zA-Z0-9_] only — anything else is rejected.
//   - Integers / floats: coerce to Number and reject NaN / Infinity.
//   - Booleans: emit literal '1' / '0' (the engine's idiom).
//   - NULL / undefined: emit literal NULL (unquoted).
//
// What we do NOT do:
//   - We do NOT attempt to escape full SQL fragments. If you need a
//     dynamic column or table, use one of the named helpers below that
//     takes a whitelist.
//   - We do NOT try to detect "is this already escaped". Escape once,
//     at the boundary, and use string concat with quotes from the helper.
//
// Functions:
//   sqlStr(value)         — produce a SQL string literal (with quotes) or NULL
//   sqlInt(value)         — produce an integer literal or NULL
//   sqlNum(value)         — produce a finite number literal or NULL
//   sqlBool(value)        — produce '1' / '0' / NULL
//   sqlIdent(name, allowed)
//                         — produce a quoted identifier; throw if not in the
//                           allowed set (use this when caller-supplied input
//                           would otherwise be concatenated as a column name)
//   sqlIn(value, list)    — value IN (sqlStr(a), sqlStr(b), ...) helper
//
// All helpers throw on inputs they cannot safely escape. The intent is:
//   "if the helper ran, the literal is safe to drop into a SQL string".

// --------- string literal ---------
// Single-quoted, with both ' and \ escaped. Handles non-finite strings safely.
export function sqlStr(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`sqlStr: non-finite number ${value}`);
    // Numeric string literal — still quoted for consistency with column types.
    return `'${String(value)}'`;
  }
  if (typeof value === 'boolean') return value ? "'1'" : "'0'";
  if (typeof value !== 'string') {
    throw new Error(`sqlStr: unsupported type ${typeof value}`);
  }
  if (value.length > 65_000) {
    // Defensive cap — most columns are well under 4KB; anything bigger is
    // almost certainly user-supplied free text being abused.
    throw new Error(`sqlStr: string too long (${value.length} > 65500)`);
  }
  // Order matters: escape backslash first, then single-quote.
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

// --------- integer literal ---------
export function sqlInt(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`sqlInt: not an integer: ${value}`);
  }
  return String(n);
}

// --------- finite number literal ---------
export function sqlNum(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  const n = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isFinite(n)) {
    throw new Error(`sqlNum: not a finite number: ${value}`);
  }
  return String(n);
}

// --------- boolean literal ---------
export function sqlBool(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? "'1'" : "'0'";
  if (typeof value === 'number') return value ? "'1'" : "'0'";
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(t)) return "'1'";
    if (['0', 'false', 'no', 'off', ''].includes(t)) return "'0'";
  }
  return 'NULL';
}

// --------- identifier whitelist ---------
// Use when caller input becomes a column or table name. `allowed` is the
// set of acceptable identifier strings; anything else throws.
export function sqlIdent(name, allowed) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`sqlIdent: empty identifier`);
  }
  if (allowed && !allowed.includes(name)) {
    throw new Error(`sqlIdent: '${name}' not in allow-list`);
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`sqlIdent: unsafe identifier '${name}'`);
  }
  return `"${name.replace(/"/g, '""')}"`;
}

// --------- convenience: render a SQL value (dispatches by type) ---------
export function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return sqlBool(value);
  if (typeof value === 'number') {
    return Number.isInteger(value) ? sqlInt(value) : sqlNum(value);
  }
  return sqlStr(value);
}

// --------- IN (list) helper ---------
// `list` is an array of values. Renders as: sqlStr(a), sqlStr(b), ... or NULL.
// Throws if the list is empty (caller probably meant to filter, not match all).
export function sqlIn(value, list) {
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`sqlIn: empty list for column '${value}'`);
  }
  const colIdent = sqlIdent(value); // no allow-list — assume column name is dev-controlled
  return `${colIdent} IN (${list.map((v) => sqlValue(v)).join(', ')})`;
}