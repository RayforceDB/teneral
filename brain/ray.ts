import { CString, dlopen, ptr, toArrayBuffer, type Pointer } from 'bun:ffi';
import { join } from 'node:path';

// RayforceDB inside the agent's own process. The database is a shared library; a query is a
// function call, and a column of its result is memory that is read where it lies. Nothing is
// turned into the text of a query or the bytes of a protocol on the way in or out: columns go in
// as typed arrays, with one copy, and come back as typed arrays, with one copy.
//
// Three things follow from sharing a process with it.
//   A fault in the library takes the agent down with it, so everything that comes from this side
//   is checked here, in TypeScript, before any call: types, lengths, names.
//   A call blocks this thread for as long as the query runs. Queries here take micro- to
//   milliseconds; anything long has to be done in portions.
//   The library has one runtime for a process, and it belongs to the thread that made it. There
//   is one `Ray`, and it is used from the thread the agent runs on.
//
// What is read at fixed places in a value is its 32-byte header, as include/rayforce.h of the
// pinned build declares it: the length at byte 24, an atom's value there too. That file promises
// no stability from one build to the next, which is why the build is pinned by its hash, and why
// `openRay` can be told the commit it expects and refuses any other.
//
// Only source text written in this repository is ever evaluated. Rayfall can end the process
// (`exit`) and run commands (`.sys.exec`); nothing a model or a message wrote may reach `run` or
// `query` as source. Data goes in through `bind`, never by being pasted into source.

/** Where the pinned library lies: TENERAL_ORGANS holds one entry for each thing the brain or the body pins. */
export function libraryAt(organsDir: string): string {
  return join(organsDir, 'rayforce', 'librayforce.so');
}

/** An error the database answered a query with: a short code (`type`, `domain`, `io`, ...) and what it said. */
export class RayError extends Error {
  constructor(readonly code: string, detail: string) {
    super(detail === '' ? `rayforce: ${code}` : `rayforce: ${code}: ${detail}`);
    this.name = 'RayError';
  }
}

// Type tags of include/rayforce.h. A vector has the positive tag, an atom of the same type the negative one.
const LIST = 0, BOOL = 1, U8 = 2, I16 = 3, I32 = 4, I64 = 5, F32 = 6, F64 = 7, DATE = 8, TIME = 9, TIMESTAMP = 10, SYM = 12, STR = 13, TIMESPAN = 16;
const TABLE = 98, DICT = 99, LAZY = 104, NULL = 126;
/** Columns of a partitioned table as they lie on disk, one segment a partition, and its virtual key column. They are the library's own forms. */
const PARTED_FROM = 32, PARTED_TO = 64;
/** Byte offsets in a value's header: its length or an atom's value; for a slice, the vector it is a slice of; for a symbol vector, its dictionary. */
const AT_VALUE = 24, AT_PARENT = 0, AT_DOMAIN = 8;
/** The attribute bit of a vector that is a slice of another. */
const SLICE = 0x10;

/** A column as it comes back: numbers in the array of their width, text as strings, anything else as values. */
export type Cells = Uint8Array | Int16Array | Int32Array | BigInt64Array | Float32Array | Float64Array | string[] | Value[];
export interface Table {
  names: string[];
  rows: number;
  columns: Record<string, Cells>;
}
export interface Dict {
  keys: Value;
  values: Value;
}
/** 64-bit integers, timestamps among them, are `bigint`: a count of nanoseconds does not fit a `number`. Everything narrower is a `number`. */
export type Value = null | boolean | number | bigint | string | Cells | Table | Dict;

/** A column to hand over. Timestamps are nanoseconds since 2000-01-01 UTC, dates are days since then: see `toRayNs` and `toRayDay`. */
export type Column =
  | { type: 'i64' | 'timestamp'; data: BigInt64Array }
  | { type: 'f64'; data: Float64Array }
  | { type: 'date'; data: Int32Array }
  | { type: 'bool'; data: Uint8Array }
  | { type: 'sym'; data: string[] }
  | { type: 'str'; data: string[] };

type Fixed = Exclude<Column['type'], 'sym' | 'str'>;
const FIXED: Record<Fixed, number> = { i64: I64, timestamp: TIMESTAMP, f64: F64, date: DATE, bool: BOOL };
/** The array each fixed-width column is handed over as: its cells have exactly the width the database stores. */
const ARRAYS: Record<Fixed, { name: string; new (length: number): unknown }> = {
  i64: BigInt64Array, timestamp: BigInt64Array, f64: Float64Array, date: Int32Array, bool: Uint8Array,
};

/** The database counts time from here. */
const EPOCH_MS = Date.UTC(2000, 0, 1);
const DAY_MS = 86_400_000;
/** A journal time (ISO 8601) as the database's nanoseconds. Throws for what is not a time. */
export function toRayNs(iso: string): bigint {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`not a time: ${iso}`);
  return BigInt(ms - EPOCH_MS) * 1_000_000n;
}
/** The database's nanoseconds as ISO 8601, to the millisecond. */
export function fromRayNs(ns: bigint): string {
  return new Date(Number(ns / 1_000_000n) + EPOCH_MS).toISOString();
}
/** The day of a journal time as the database counts days, and as it writes them (`2026.11.14`). */
export function toRayDay(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`not a time: ${iso}`);
  return Math.floor((ms - EPOCH_MS) / DAY_MS);
}
export function dayName(day: number): string {
  return new Date(day * DAY_MS + EPOCH_MS).toISOString().slice(0, 10).replaceAll('-', '.');
}

/** A name that can be bound and used in source: Rayfall would read anything else as something other than one name. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** The most rows one `bind` hands over. Far above what the memory writes at once; a number past it is a mistake on this side. */
const MAX_ROWS = 50_000_000;

const SYMBOLS = {
  ray_runtime_create: { args: ['i32', 'ptr'], returns: 'ptr' },
  ray_runtime_destroy: { args: ['ptr'], returns: 'void' },
  ray_pool_init_total: { args: ['u32'], returns: 'i32' },
  ray_git_commit: { args: [], returns: 'ptr' },
  ray_eval_str: { args: ['ptr'], returns: 'ptr' },
  ray_lazy_materialize: { args: ['ptr'], returns: 'ptr' },
  ray_release: { args: ['ptr'], returns: 'void' },
  ray_err_code: { args: ['ptr'], returns: 'ptr' },
  ray_error_msg: { args: [], returns: 'ptr' },
  ray_error_clear: { args: [], returns: 'void' },
  ray_error_free: { args: ['ptr'], returns: 'void' },
  ray_obj_type: { args: ['ptr'], returns: 'i8' },
  ray_obj_attrs: { args: ['ptr'], returns: 'u8' },
  ray_sym_domain_runtime_lut: { args: ['ptr'], returns: 'ptr' },
  ray_sym_domain_count: { args: ['ptr'], returns: 'i64' },
  ray_vec_get: { args: ['ptr', 'i64'], returns: 'ptr' },
  ray_vec_get_sym_id: { args: ['ptr', 'i64'], returns: 'i64' },
  ray_str_vec_get: { args: ['ptr', 'i64', 'ptr'], returns: 'ptr' },
  ray_str_ptr: { args: ['ptr'], returns: 'ptr' },
  ray_str_len: { args: ['ptr'], returns: 'u64' },
  ray_sym_str: { args: ['i64'], returns: 'ptr' },
  ray_sym_intern: { args: ['ptr', 'u64'], returns: 'i64' },
  ray_list_get: { args: ['ptr', 'i64'], returns: 'ptr' },
  ray_table_ncols: { args: ['ptr'], returns: 'i64' },
  ray_table_nrows: { args: ['ptr'], returns: 'i64' },
  ray_table_col_idx: { args: ['ptr', 'i64'], returns: 'ptr' },
  ray_table_col_name: { args: ['ptr', 'i64'], returns: 'i64' },
  ray_dict_keys: { args: ['ptr'], returns: 'ptr' },
  ray_dict_vals: { args: ['ptr'], returns: 'ptr' },
  ray_vec_from_raw: { args: ['i8', 'ptr', 'i64'], returns: 'ptr' },
  ray_str_vec_from_parts: { args: ['ptr', 'ptr', 'ptr', 'i64'], returns: 'ptr' },
  ray_table_new: { args: ['i64'], returns: 'ptr' },
  ray_table_add_col: { args: ['ptr', 'i64', 'ptr'], returns: 'ptr' },
  ray_env_set: { args: ['i64', 'ptr'], returns: 'i32' },
} as const;

export interface RayOptions {
  /** The shared library: see `libraryAt`. */
  library: string;
  /** Threads a query may use. The agent is one of many things on its machine, and its queries are small: two unless told otherwise. */
  cores?: number;
  /** The commit the library must have been built from, as much of its hash as the caller knows. Any other build is refused. */
  commit?: string;
}

export interface Ray {
  /** Evaluates source for what it does; whatever it returns is dropped. */
  run(source: string): void;
  /** Evaluates source and gives back its result, copied out of the database. */
  query(source: string): Value;
  /** The same for a result that is a table; anything else is an error of this side. */
  table(source: string): Table;
  /** Makes a table of these columns and binds it to `name` in the database, for source to use. */
  bind(name: string, columns: Record<string, Column>): void;
  /** The commit the library was built from. */
  commit: string;
  /** Ends the runtime. Nothing may be called after it. */
  close(): void;
}

/** Bun's types give a returned pointer as a number or a bigint depending on the signature; at run time it is one pointer. */
const at = (pointer: unknown): Pointer => pointer as Pointer;
const orNull = (pointer: unknown): Pointer | null => pointer as Pointer | null;

let live = false;

/**
 * Loads the library and starts its runtime. Throws when the library cannot be loaded, is another
 * build than `commit` says, or when a runtime is already live in this process.
 */
export function openRay(options: RayOptions): Ray {
  if (live) throw new Error('rayforce is already open in this process, and the library has one runtime for a process');
  const lib = dlopen(options.library, SYMBOLS);
  const c = lib.symbols;
  const built = new CString(at(c.ray_git_commit())).toString();
  if (options.commit !== undefined && !(built.startsWith(options.commit) || options.commit.startsWith(built))) {
    lib.close();
    throw new Error(`rayforce at ${options.library} was built from ${built}, not from ${options.commit}`);
  }
  const runtime = orNull(c.ray_runtime_create(0, null));
  if (runtime === null) {
    lib.close();
    throw new Error('rayforce could not start its runtime');
  }
  c.ray_pool_init_total(Math.max(1, Math.floor(options.cores ?? 2)));
  live = true;
  let open = true;

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const encoder = new TextEncoder();
  /** Text at `at`, `length` bytes of it. The bytes are copied before they are decoded: they are the database's and may move. */
  const text = (from: Pointer, length: number): string => (length === 0 ? '' : decoder.decode(new Uint8Array(toArrayBuffer(from, 0, length)).slice()));
  /** A symbol's text by its id. Ids never change while the runtime lives, so each is asked for once. */
  const names = new Map<bigint, string>();
  const symbol = (id: bigint): string => {
    let name = names.get(id);
    if (name === undefined) {
      const held = id < 0n ? null : orNull(c.ray_sym_str(id));
      name = held === null ? '' : text(at(c.ray_str_ptr(held)), Number(c.ray_str_len(held)));
      names.set(id, name);
    }
    return name;
  };
  const ids = new Map<string, bigint>();
  const intern = (name: string): bigint => {
    let id = ids.get(name);
    if (id === undefined) {
      const bytes = encoder.encode(name);
      // An empty symbol is the database's null symbol; it has the id 0 without being asked for.
      id = bytes.length === 0 ? 0n : BigInt(c.ray_sym_intern(bytes, bytes.length));
      if (id < 0n) throw new RayError('oom', `could not intern the symbol ${name}`);
      ids.set(name, id);
    }
    return id;
  };

  /** The error `value` is, or null. An error is not released like other values: `fail` frees it. */
  const errorOf = (value: Pointer): string | null => {
    const code = orNull(c.ray_err_code(value));
    return code === null ? null : new CString(code).toString();
  };
  /** Throws what the error at `value` says, and frees it. */
  const fail = (value: Pointer, code: string): never => {
    const said = orNull(c.ray_error_msg());
    const detail = said === null ? '' : new CString(said).toString();
    c.ray_error_free(value);
    c.ray_error_clear();
    throw new RayError(code, detail);
  };

  const length = (value: Pointer): number => Number(new DataView(toArrayBuffer(value, AT_VALUE, 8)).getBigInt64(0, true));
  /** `count` cells of `size` bytes of the vector at `vec`, copied. `ray_vec_get` finds the first cell also when the vector is a slice of another. */
  const cells = (vec: Pointer, count: number, size: number): ArrayBuffer =>
    (count === 0 ? new ArrayBuffer(0) : toArrayBuffer(at(c.ray_vec_get(vec, 0)), 0, count * size).slice(0));
  const atom = (value: Pointer): DataView => new DataView(toArrayBuffer(value, AT_VALUE, 8));
  const lengthOut = new BigUint64Array(1);
  const pointerAt = (value: Pointer, offset: number): Pointer | null => {
    const address = new DataView(toArrayBuffer(value, offset, 8)).getBigUint64(0, true);
    return address === 0n ? null : (Number(address) as Pointer);
  };

  /**
   * The symbols of the vector at `vec` as text. A cell holds a position in the vector's own
   * dictionary. For a vector made in this runtime that is the runtime's table of symbols and the
   * position is the symbol's id; for a column read from disk it is the file's dictionary, and the
   * library gives a list that turns positions into ids. Text is always found by id, so the names
   * remembered above are right whatever dictionary a vector came with.
   */
  function symbols(vec: Pointer, count: number): string[] {
    const out = new Array<string>(count);
    if (count === 0) return out;
    // A slice has no dictionary of its own; the vector it was cut from has it.
    const owner = (c.ray_obj_attrs(vec) & SLICE) !== 0 ? pointerAt(vec, AT_PARENT) : vec;
    const domain = owner === null ? null : pointerAt(owner, AT_DOMAIN);
    const list = domain === null ? null : orNull(c.ray_sym_domain_runtime_lut(domain));
    const idOf = list === null ? null : new BigInt64Array(toArrayBuffer(list, 0, Number(c.ray_sym_domain_count(domain!)) * 8));
    for (let i = 0; i < count; i++) {
      const position = BigInt(c.ray_vec_get_sym_id(vec, i));
      const id = idOf === null ? position : position >= 0n && position < BigInt(idOf.length) ? idOf[Number(position)]! : -1n;
      out[i] = symbol(id);
    }
    return out;
  }

  /** A value of the database as one of TypeScript, copied: nothing in the result points into the database's memory. */
  function read(value: Pointer): Value {
    const type = c.ray_obj_type(value);
    if (type === NULL) return null;
    if (type < 0) {
      switch (-type) {
        case BOOL: return atom(value).getUint8(0) !== 0;
        case U8: return atom(value).getUint8(0);
        case I16: return atom(value).getInt16(0, true);
        case I32: case DATE: case TIME: return atom(value).getInt32(0, true);
        case I64: case TIMESTAMP: case TIMESPAN: return atom(value).getBigInt64(0, true);
        case F64: case F32: return atom(value).getFloat64(0, true);
        case SYM: return symbol(atom(value).getBigInt64(0, true));
        case STR: return text(at(c.ray_str_ptr(value)), Number(c.ray_str_len(value)));
        default: throw new RayError('type', `an atom of type ${type} cannot be read here`);
      }
    }
    if (type === TABLE) {
      const rows = Number(c.ray_table_nrows(value));
      const table: Table = { names: [], rows, columns: {} };
      for (let i = 0n, n = c.ray_table_ncols(value); i < n; i++) {
        const name = symbol(BigInt(c.ray_table_col_name(value, i)));
        const column = orNull(c.ray_table_col_idx(value, i));
        if (column === null) throw new RayError('type', `the column ${name} could not be read`);
        const problem = errorOf(column);
        if (problem !== null) fail(column, problem);
        table.names.push(name);
        table.columns[name] = read(column) as Cells;
      }
      return table;
    }
    if (type === DICT) return { keys: read(at(c.ray_dict_keys(value))), values: read(at(c.ray_dict_vals(value))) };
    const count = length(value);
    switch (type) {
      case BOOL: case U8: return new Uint8Array(cells(value, count, 1));
      case I16: return new Int16Array(cells(value, count, 2));
      case I32: case DATE: case TIME: return new Int32Array(cells(value, count, 4));
      case I64: case TIMESTAMP: case TIMESPAN: return new BigInt64Array(cells(value, count, 8));
      case F32: return new Float32Array(cells(value, count, 4));
      case F64: return new Float64Array(cells(value, count, 8));
      case SYM: return symbols(value, count);
      case STR: {
        const out = new Array<string>(count);
        for (let i = 0; i < count; i++) {
          const cell = orNull(c.ray_str_vec_get(value, i, lengthOut));
          out[i] = cell === null ? '' : text(cell, Number(lengthOut[0]));
        }
        return out;
      }
      case LIST: {
        const out = new Array<Value>(count);
        for (let i = 0; i < count; i++) out[i] = read(at(c.ray_list_get(value, i)));
        return out;
      }
      default:
        if (type >= PARTED_FROM && type <= PARTED_TO) {
          throw new RayError('type', 'a column of a partitioned table cannot be read as it lies on disk; name the columns in the select, with a filter or a limit');
        }
        throw new RayError('type', `a value of type ${type} cannot be read here`);
    }
  }

  /** Evaluates `source` and gives the result to `use`, releasing it afterwards whatever happens. */
  function evaluate<T>(source: string, use: (value: Pointer) => T): T {
    if (!open) throw new Error('rayforce was closed');
    if (source.includes('\0')) throw new Error('source may not hold a NUL character');
    // C reads the source up to its first NUL.
    let value = orNull(c.ray_eval_str(encoder.encode(`${source}\0`)));
    if (value === null) throw new RayError('null', 'the database returned no value');
    let problem = errorOf(value);
    if (problem !== null) fail(value, problem);
    // A query may answer with a plan that has not run yet; this runs it, and gives any other value back as it is.
    if (c.ray_obj_type(value) === LAZY) {
      value = at(c.ray_lazy_materialize(value));
      problem = errorOf(value);
      if (problem !== null) fail(value, problem);
    }
    try {
      return use(value);
    } finally {
      c.ray_release(value);
    }
  }

  /** A vector of the database holding `column`, owned by the caller. */
  function vector(name: string, column: Column, rows: number): Pointer {
    let made: Pointer | null;
    if (column.type === 'sym' || column.type === 'str') {
      // Checked here because the library would read whatever it was handed as text.
      if (!Array.isArray(column.data) || column.data.some((cell) => typeof cell !== 'string')) throw new Error(`column ${name}: every cell must be a string`);
    } else if (!(column.data instanceof ARRAYS[column.type])) {
      // The library copies `rows` cells of the type's width from this buffer; an array of another width would be read past its end.
      throw new Error(`column ${name}: a ${column.type} column is handed over as a ${ARRAYS[column.type].name}`);
    }
    if (column.type === 'sym') {
      const cellIds = BigInt64Array.from(column.data, intern);
      made = orNull(c.ray_vec_from_raw(SYM, rows === 0 ? null : cellIds, rows));
    } else if (column.type === 'str') {
      // All the text in one buffer, and for each cell where it starts and how long it is.
      const parts = column.data.map((cell) => encoder.encode(cell));
      const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0) + 1);
      const starts = new BigUint64Array(rows);
      const lengths = new Uint32Array(rows);
      const base = BigInt(ptr(all));
      let filled = 0;
      parts.forEach((part, i) => {
        all.set(part, filled);
        starts[i] = base + BigInt(filled);
        lengths[i] = part.length;
        filled += part.length;
      });
      made = orNull(c.ray_str_vec_from_parts(rows === 0 ? null : starts, rows === 0 ? null : lengths, null, rows));
    } else {
      made = orNull(c.ray_vec_from_raw(FIXED[column.type], rows === 0 ? null : column.data, rows));
    }
    if (made === null) throw new RayError('oom', `column ${name} could not be made`);
    const problem = errorOf(made);
    if (problem !== null) fail(made, problem);
    return made;
  }

  return {
    commit: built,
    run(source) {
      evaluate(source, () => undefined);
    },
    query(source) {
      return evaluate(source, read);
    },
    table(source) {
      const result = evaluate(source, read);
      if (result === null || typeof result !== 'object' || !('rows' in result)) throw new RayError('type', 'the query did not return a table');
      return result;
    },
    bind(name, columns) {
      if (!open) throw new Error('rayforce was closed');
      if (!NAME.test(name)) throw new Error(`not a name that can be bound: ${name}`);
      const entries = Object.entries(columns);
      if (entries.length === 0) throw new Error('a table needs a column');
      const rows = entries[0]![1].data.length;
      if (rows > MAX_ROWS) throw new Error(`${rows} rows at once is more than this side ever hands over`);
      for (const [column, cellsOf] of entries) {
        if (!NAME.test(column)) throw new Error(`not a name for a column: ${column}`);
        if (cellsOf.data.length !== rows) throw new Error(`column ${column} has ${cellsOf.data.length} cells, the first one has ${rows}`);
      }
      let table = orNull(c.ray_table_new(entries.length));
      if (table === null) throw new RayError('oom', 'the table could not be made');
      for (const [column, cellsOf] of entries) {
        let made: Pointer;
        try {
          made = vector(column, cellsOf, rows);
        } catch (err) {
          c.ray_release(table);
          throw err;
        }
        // The table keeps the column for itself; the reference made above is this side's to give up. It takes the table's own in every case.
        table = at(c.ray_table_add_col(table, intern(column), made));
        c.ray_release(made);
        const problem = errorOf(table);
        if (problem !== null) fail(table, problem);
      }
      // The binding keeps the table; the reference made here is given up.
      const status = c.ray_env_set(intern(name), table);
      c.ray_release(table);
      if (status !== 0) throw new RayError('env', `the table could not be bound to ${name}`);
    },
    close() {
      if (!open) return;
      open = false;
      live = false;
      c.ray_runtime_destroy(runtime);
      lib.close();
    },
  };
}
