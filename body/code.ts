import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

/**
 * Questions about code, answered the same way whatever the language: what is in a file, the body of
 * one symbol, where a name is defined, who uses it, where code of a given shape appears. The agent
 * asks through the `code` command (body/code-cli.ts, started by body/bin/code), which `bash` finds
 * on its PATH; it is not a tool, so it costs nothing in a request until it is used.
 *
 * Two tables carry everything particular: LANGUAGES says which files are which language and what
 * each backend calls it, and a list of backends (body/code-backends.ts, body/code-clangd.ts) says what can answer. For
 * each question the first backend that serves the language and is present answers, and the answer
 * says how sure it is. A new language is one entry in the first table; a new program that answers
 * is one entry in the second.
 */

/** How far an answer can be trusted: a language server resolved the name, a parser saw the shape, or the text matched. */
export type Grade = 'exact' | 'syntactic' | 'textual';

export interface Language {
  name: string;
  /** With the dot, lower case. */
  extensions: string[];
  /** What ast-grep calls it. */
  astGrep?: string;
  /** The language server that resolves its names, when there is one (body/code-clangd.ts). */
  server?: string;
  /**
   * The grammar is not one ast-grep carries. Its source is an organ the body pins (immune/organs.ts):
   * `organ` is the organ's name and `source` the generated parser in it, which the body compiles
   * once with the image's C compiler (body/code-backends.ts).
   */
  grammar?: { organ: string; source: string };
  /**
   * For a language where a statement or an expression is not code unless it stands in a function
   * (C: a bare `f($X)` parses as a declaration): how to put a pattern in one, and the kind of the
   * block its statements are then children of. A search that finds nothing as written is asked again this way.
   */
  inFunction?: { wrap: (pattern: string) => string; block: string };
  /**
   * How ast-grep finds what a file of this language defines. Each entry is one ast-grep rule and
   * the kind its matches are listed as. The name is what the rule binds to `$NAME`, or what `read`
   * makes of the matched text when it knows better; what the rule binds to `$PARAMS` is shown after the name.
   */
  definitions?: readonly Definition[];
}
export interface Definition {
  kind: string;
  rule: Record<string, unknown>;
  read?: (text: string) => { name: string; kind?: string; signature?: string } | null;
}

/** Rayfall binds a name with `(set name value)`; a value that begins `(fn` is a function. */
function rayfallSet(text: string): { name: string; kind: string; signature?: string } | null {
  const match = /^\(\s*set\s+([^\s()[\]{}]+)\s*(\(\s*fn\s*(\[[^\]]*\]))?/.exec(text);
  if (match === null) return null;
  return match[2] === undefined ? { name: match[1]!, kind: 'variable' } : { name: match[1]!, kind: 'function', signature: ' ' + match[3]!.replace(/\s+/g, ' ') };
}

/**
 * tree-sitter reads `static __attribute__((x)) int f(void) {` as a function named `__attribute__`.
 * The name is then the first word before a parenthesis once the attributes are taken out.
 */
function cFunction(text: string): { name: string; signature?: string } | null {
  const brace = text.indexOf('{');
  const head = brace === -1 ? text : text.slice(0, brace);
  if (!head.includes('__attribute__')) return null;
  const plain = head.replace(/__attribute__\s*\(\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)\)/g, ' ');
  const match = /([A-Za-z_]\w*)\s*(\((?:[^()]|\([^()]*\))*\))/.exec(plain);
  return match === null ? null : { name: match[1]!, signature: match[2]!.replace(/\s+/g, ' ') };
}

const withBody = (kind: string, body: string): Record<string, unknown> => ({ kind, all: [{ has: { field: 'name', pattern: '$NAME' } }, { has: { field: 'body', kind: body } }] });
/** C. A name is found under its declarator however it is wrapped: a pointer, an array, an initial value. */
const C: readonly Definition[] = [
  {
    kind: 'function', read: cFunction,
    rule: { kind: 'function_definition', has: { stopBy: 'end', kind: 'function_declarator', all: [{ has: { field: 'declarator', kind: 'identifier', pattern: '$NAME' } }, { has: { field: 'parameters', pattern: '$PARAMS' } }] } },
  },
  { kind: 'macro', rule: { any: [{ kind: 'preproc_def' }, { kind: 'preproc_function_def' }], has: { field: 'name', pattern: '$NAME' } } },
  { kind: 'struct', rule: withBody('struct_specifier', 'field_declaration_list') },
  { kind: 'union', rule: withBody('union_specifier', 'field_declaration_list') },
  { kind: 'enum', rule: withBody('enum_specifier', 'enumerator_list') },
  { kind: 'typedef', rule: { kind: 'type_definition', has: { field: 'declarator', any: [{ kind: 'type_identifier', pattern: '$NAME' }, { has: { stopBy: 'end', kind: 'type_identifier', pattern: '$NAME' } }] } } },
  {
    kind: 'variable',
    rule: {
      // At the top of the file, and not the declaration of a function.
      kind: 'declaration', inside: { kind: 'translation_unit' }, not: { has: { stopBy: 'end', kind: 'function_declarator' } },
      has: { field: 'declarator', any: [{ kind: 'identifier', pattern: '$NAME' }, { has: { stopBy: 'end', kind: 'identifier', pattern: '$NAME' } }] },
    },
  },
];
const PYTHON: readonly Definition[] = [
  { kind: 'function', rule: { kind: 'function_definition', all: [{ has: { field: 'name', pattern: '$NAME' } }, { has: { field: 'parameters', pattern: '$PARAMS' } }] } },
  { kind: 'class', rule: { kind: 'class_definition', has: { field: 'name', pattern: '$NAME' } } },
];

const named = (...kinds: string[]): Record<string, unknown> => ({ any: kinds.map((kind) => ({ kind })), has: { field: 'name', pattern: '$NAME' } });
const FUNCTION_VALUE = { has: { field: 'value', any: [{ kind: 'arrow_function' }, { kind: 'function_expression' }] } };
/** JavaScript, and what TypeScript shares with it. A `const` is listed as a function when its value is one, and otherwise only at the top of the file. */
const SCRIPT: readonly Definition[] = [
  { kind: 'function', rule: named('function_declaration', 'generator_function_declaration') },
  { kind: 'method', rule: named('method_definition') },
  { kind: 'function', rule: { kind: 'variable_declarator', all: [{ has: { field: 'name', pattern: '$NAME' } }, FUNCTION_VALUE] } },
  {
    kind: 'variable',
    rule: {
      kind: 'variable_declarator', has: { field: 'name', pattern: '$NAME' }, not: FUNCTION_VALUE,
      inside: { kind: 'lexical_declaration', inside: { any: [{ kind: 'program' }, { kind: 'export_statement' }] } },
    },
  },
];

export const LANGUAGES: readonly Language[] = [
  { name: 'c', extensions: ['.c', '.h', '.inc'], astGrep: 'c', server: 'clangd', definitions: C, inFunction: { wrap: (pattern) => `void f__() { ${pattern}; }`, block: 'compound_statement' } },
  { name: 'python', extensions: ['.py'], astGrep: 'python', definitions: PYTHON },
  { name: 'bash', extensions: ['.sh', '.bash'], astGrep: 'bash', definitions: [{ kind: 'function', rule: named('function_definition') }] },
  {
    name: 'javascript', extensions: ['.js', '.mjs', '.cjs', '.jsx'], astGrep: 'javascript',
    definitions: [...SCRIPT, { kind: 'class', rule: named('class_declaration') }],
  },
  {
    name: 'typescript', extensions: ['.ts', '.mts', '.cts'], astGrep: 'typescript',
    definitions: [
      ...SCRIPT, { kind: 'class', rule: named('class_declaration', 'abstract_class_declaration') },
      { kind: 'interface', rule: named('interface_declaration') }, { kind: 'type', rule: named('type_alias_declaration') }, { kind: 'enum', rule: named('enum_declaration') },
    ],
  },
  {
    name: 'rayfall', extensions: ['.rfl'], astGrep: 'rayfall', grammar: { organ: 'tree-sitter-rayfall', source: 'src/parser.c' },
    definitions: [{ kind: 'variable', rule: { kind: 'call', inside: { kind: 'source_file' }, has: { field: 'function', regex: '^set$' } }, read: rayfallSet }],
  },
];

export function languageOf(path: string, languages: readonly Language[] = LANGUAGES): Language | null {
  const extension = extname(path).toLowerCase();
  return languages.find((language) => language.extensions.includes(extension)) ?? null;
}
export function languageNamed(name: string, languages: readonly Language[] = LANGUAGES): Language | null {
  return languages.find((language) => language.name === name.toLowerCase()) ?? null;
}

/** Something a file defines. Lines count from one; `end` is the last line of its body, or `line` when the backend does not know. */
export interface Sym {
  name: string;
  kind: string;
  path: string;
  line: number;
  end: number;
  signature?: string;
  /** What it is inside: the struct of a member, the class of a method. */
  scope?: string;
}
/** One place in a file, with the text of its first line. */
export interface Hit {
  path: string;
  line: number;
  end?: number;
  text: string;
}

/** Something a compiler would say about a file. */
export interface Diagnostic {
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'note' | 'hint';
  message: string;
}

export type Op = 'outline' | 'grep' | 'search' | 'definition' | 'references' | 'diagnostics';

/**
 * Something that can answer. It has only the methods for what it can do. `outline` lists what the
 * given files (all of one language) define; `grep` finds a whole word as text; `search` finds code
 * by shape. The last three are for a backend that resolves names, a language server. It is asked
 * from a place in a file, which the layer finds: `definitionAt` from a use of the name, `references`
 * from the places the name is defined. Each may answer null (it cannot tell this time: no index, no
 * compile commands), and the question then goes on to `grep` and `outline`, whose answer says it is less sure.
 */
export interface Backend {
  name: string;
  grade: Grade;
  /** Whether this backend answers `op` for `language` (null: any text), given what the image holds. */
  serves(op: Op, language: Language | null): Promise<boolean>;
  outline?(files: string[], language: Language): Promise<Sym[]>;
  grep?(word: string, root: string, extensions: string[]): Promise<Hit[]>;
  search?(pattern: string, language: Language, paths: string[]): Promise<Hit[]>;
  definitionAt?(file: string, line: number, name: string, root: string, language: Language): Promise<Sym[] | null>;
  references?(name: string, at: Sym[], root: string, language: Language): Promise<Hit[] | null>;
  diagnostics?(file: string, root: string, language: Language): Promise<Diagnostic[] | null>;
}

export class CodeError extends Error {}

/** The nearest directory at or above `path` that is a checkout (it has `.git`, a file in a worktree), or `path`'s own directory. */
export function projectRoot(path: string): string {
  const start = existsSync(path) && statSync(path).isDirectory() ? path : dirname(path);
  for (let at = start; ; at = dirname(at)) {
    if (existsSync(join(at, '.git'))) return at;
    if (dirname(at) === at) return start;
  }
}

/** Kinds that crowd an outline without saying what the file is about; `--all` shows them. */
const MINOR = new Set(['member', 'enumerator', 'local', 'parameter', 'label', 'property', 'field', 'header', 'externvar', 'prototype']);
/** What comes first when a name has several definitions. */
const RANK = ['function', 'method', 'class', 'struct', 'union', 'enum', 'interface', 'typedef', 'type', 'macro', 'variable'];
const rank = (kind: string): number => { const at = RANK.indexOf(kind); return at === -1 ? RANK.length : at; };

export interface Options {
  /** Where relative paths start and what paths are shown relative to. */
  cwd: string;
  all?: boolean;
  /** A regular expression the name must match. */
  match?: string;
  kind?: string;
  lang?: string;
  limit?: number;
}

export interface Answer {
  /** Zero when something was found, one when nothing was. */
  status: 0 | 1;
  text: string;
}

const LIMITS = { outline: 300, definition: 20, references: 80, search: 50, body: 300, files: 400, diagnostics: 60 } as const;

export class Code {
  constructor(private readonly backends: readonly Backend[], private readonly languages: readonly Language[] = LANGUAGES) {}

  private async pick(op: Op, language: Language | null): Promise<Backend | null> {
    for (const backend of this.backends) if (await backend.serves(op, language)) return backend;
    return null;
  }
  private show(path: string, options: Options): string {
    const shown = relative(options.cwd, path);
    return shown === '' ? '.' : shown.startsWith('..') ? path : shown;
  }
  private language(path: string, options: Options): Language {
    const language = options.lang !== undefined ? languageNamed(options.lang, this.languages) : languageOf(path, this.languages);
    if (language === null) {
      throw new CodeError(options.lang !== undefined
        ? `unknown language: ${options.lang}. Known: ${this.languages.map((one) => one.name).join(', ')}`
        : `${path}: no known language has this extension; \`code languages\` lists them, --lang names one`);
    }
    return language;
  }
  private limit(options: Options, usual: number): number {
    return options.limit !== undefined && Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : usual;
  }
  private row(sym: Sym): string {
    const span = sym.end > sym.line ? `${sym.line}-${sym.end}` : `${sym.line}`;
    const name = (sym.scope !== undefined ? `${sym.scope}::` : '') + sym.name + (sym.signature ?? '');
    return `${span.padStart(11)}  ${sym.kind.padEnd(9)} ${name}`;
  }
  private async symbolsOf(file: string, options: Options): Promise<{ symbols: Sym[]; backend: Backend }> {
    if (!existsSync(file) || !statSync(file).isFile()) throw new CodeError(`${file}: no such file`);
    const language = this.language(file, options);
    const backend = await this.pick('outline', language);
    if (backend === null) throw new CodeError(`nothing here can list the symbols of ${language.name}; \`code languages\` says what is missing`);
    const symbols = (await backend.outline!([file], language)).sort((a, b) => a.line - b.line);
    return { symbols, backend };
  }

  /** What a file defines, one line each, in the order of the file. */
  async outline(path: string, options: Options): Promise<Answer> {
    const file = resolve(options.cwd, path);
    const { symbols, backend } = await this.symbolsOf(file, options);
    let wanted = options.all === true || options.kind !== undefined ? symbols : symbols.filter((sym) => !MINOR.has(sym.kind));
    if (options.kind !== undefined) wanted = wanted.filter((sym) => sym.kind === options.kind);
    if (options.match !== undefined) { const pattern = new RegExp(options.match); wanted = wanted.filter((sym) => pattern.test(sym.name)); }
    const limit = this.limit(options, LIMITS.outline);
    const hidden = symbols.length - wanted.length;
    const notes = [
      `${backend.grade} (${backend.name})`,
      `${Math.min(wanted.length, limit)} of ${wanted.length} symbols`,
      ...(hidden > 0 && options.all !== true && options.kind === undefined && options.match === undefined ? [`${hidden} members and the like hidden, --all shows them`] : []),
      ...(wanted.length > limit ? ['narrow with --match <regex> or --kind <kind>, or raise --limit'] : []),
    ];
    return { status: wanted.length === 0 ? 1 : 0, text: [`${this.show(file, options)}: ${notes.join('; ')}`, ...wanted.slice(0, limit).map((sym) => this.row(sym))].join('\n') + '\n' };
  }

  /** Definitions of `name` by its name alone: in one file, or under a directory by listing the symbols of the files that mention it. */
  private async definitions(name: string, path: string, options: Options): Promise<{ symbols: Sym[]; grade: string; partial: boolean }> {
    const target = resolve(options.cwd, path);
    if (!existsSync(target)) throw new CodeError(`${target}: no such file or directory`);
    if (statSync(target).isFile()) {
      const { symbols, backend } = await this.symbolsOf(target, options);
      return { symbols: symbols.filter((sym) => sym.name === name), grade: `${backend.grade} (${backend.name})`, partial: false };
    }
    const rest = options.lang !== undefined ? [this.language('', options)] : [...this.languages];
    const found: Sym[] = []; const grades = new Set<string>(); let partial = false;
    const text = await this.pick('grep', null);
    if (rest.length > 0 && text !== null) {
      const mentions = await text.grep!(name, target, rest.flatMap((language) => language.extensions));
      const files = [...new Set(mentions.map((hit) => hit.path))];
      if (files.length > LIMITS.files) partial = true;
      for (const language of rest) {
        const mine = files.slice(0, LIMITS.files).filter((file) => languageOf(file, this.languages) === language);
        if (mine.length === 0) continue;
        const backend = await this.pick('outline', language);
        if (backend === null) continue;
        const symbols = (await backend.outline!(mine, language)).filter((sym) => sym.name === name);
        if (symbols.length > 0) grades.add(`${backend.grade} (${backend.name})`);
        found.push(...symbols);
      }
    }
    found.sort((a, b) => rank(a.kind) - rank(b.kind) || a.path.localeCompare(b.path) || a.line - b.line);
    return { symbols: found, grade: [...grades].join(', '), partial };
  }

  /**
   * Where a name is defined. With `path` as `file:line`, the name as it is used on that line is
   * resolved by the language server, which tells apart two things of one name; else, or when no
   * server can, every definition of the name is listed.
   */
  async definition(name: string, path: string, options: Options): Promise<Answer> {
    const use = /^(.+):(\d+)$/.exec(path);
    const file = use === null ? null : resolve(options.cwd, use[1]!);
    if (use !== null && file !== null && existsSync(file) && statSync(file).isFile()) {
      const language = this.language(file, options);
      const server = await this.pick('definition', language);
      const exact = server === null ? null : await server.definitionAt!(file, Number(use[2]), name, projectRoot(file), language);
      if (server !== null && exact !== null && exact.length > 0) {
        return { status: 0, text: [`${name} as used at ${this.show(file, options)}:${use[2]}: ${server.grade} (${server.name})`, ...exact.map((sym) => `${this.show(sym.path, options)}:${sym.line}`)].join('\n') + '\n' };
      }
      path = projectRoot(file);
    }
    const { symbols, grade, partial } = await this.definitions(name, path, options);
    if (symbols.length === 0) return { status: 1, text: `no definition of ${name} found${partial ? ' in the files looked at (too many mention it; give a narrower path)' : ''}\n` };
    const limit = this.limit(options, LIMITS.definition);
    const lines = [`${name}: ${grade}; ${Math.min(symbols.length, limit)} of ${symbols.length} definitions${partial ? '; too many files mention it, so not all were looked at' : ''}`];
    for (const sym of symbols.slice(0, limit)) lines.push(`${this.show(sym.path, options)}:${this.row(sym).trimStart()}`);
    return { status: 0, text: lines.join('\n') + '\n' };
  }

  /** The body of a symbol, with its line numbers: from one file when `path` is a file, else from wherever the name is defined. */
  async symbol(name: string, path: string, options: Options): Promise<Answer> {
    const { symbols, grade } = await this.definitions(name, path, options);
    if (symbols.length === 0) return { status: 1, text: `no symbol named ${name} found\n` };
    const limit = this.limit(options, LIMITS.body);
    const out: string[] = []; let room = limit;
    for (const [at, sym] of symbols.entries()) {
      if (room <= 0) { out.push(`${symbols.length - at} more definitions not shown: \`code definition ${name}\` lists them`); break; }
      const all = readFileSync(sym.path, 'utf8').split('\n');
      const body = all.slice(sym.line - 1, sym.end);
      out.push(`${this.show(sym.path, options)}:${sym.end > sym.line ? `${sym.line}-${sym.end}` : sym.line}  ${sym.kind} ${sym.name}${sym.signature ?? ''}  [${grade}]`);
      const width = String(sym.end).length;
      for (const [offset, line] of body.slice(0, room).entries()) out.push(`${String(sym.line + offset).padStart(width)}  ${line}`);
      if (body.length > room) out.push(`[${body.length - room} more lines, to ${sym.end}: sed -n '${sym.line + room},${sym.end}p' ${this.show(sym.path, options)}]`);
      room -= body.length;
    }
    return { status: 0, text: out.join('\n') + '\n' };
  }

  /** Every use of a name, by file, each with the symbol it is inside when that can be told. */
  async references(name: string, path: string, options: Options): Promise<Answer> {
    const target = resolve(options.cwd, path);
    if (!existsSync(target)) throw new CodeError(`${target}: no such file or directory`);
    const root = statSync(target).isFile() ? projectRoot(target) : target;
    const wanted = options.lang !== undefined ? [this.language('', options)] : [...this.languages];
    // What a language server resolved and what only matched as text are kept apart: the second may name something else.
    const sure: Hit[] = []; const loose: Hit[] = []; let server: Backend | null = null; const rest: Language[] = [];
    const within = (hit: Hit): boolean => hit.path === target || hit.path.startsWith(target + '/');
    for (const language of wanted) {
      const mine = await this.pick('references', language);
      // A language server is asked from where the name is defined, so those places are found first.
      const from = mine === null ? [] : (await this.definitions(name, projectRoot(target), { ...options, lang: language.name })).symbols.filter((sym) => !MINOR.has(sym.kind));
      const exact = mine === null || from.length === 0 ? null : await mine.references!(name, from, projectRoot(target), language);
      if (mine !== null && exact !== null) { sure.push(...exact.filter(within)); server = mine; } else rest.push(language);
    }
    const text = await this.pick('grep', null);
    if (rest.length > 0) {
      if (text === null) throw new CodeError('nothing here can search text: neither rg nor grep was found');
      loose.push(...await text.grep!(name, statSync(target).isFile() ? target : root, rest.flatMap((language) => language.extensions)));
    }
    if (sure.length + loose.length === 0) return { status: 1, text: `no use of ${name} found\n` };
    const limit = this.limit(options, LIMITS.references);
    const lines: string[] = []; let room = limit;
    const list = async (hits: Hit[], heading: string): Promise<void> => {
      if (hits.length === 0) return;
      const byFile = new Map<string, Hit[]>();
      for (const hit of hits) byFile.set(hit.path, [...(byFile.get(hit.path) ?? []), hit]);
      const shown = Math.min(hits.length, room);
      lines.push(`${heading}; ${shown} of ${hits.length} places in ${byFile.size} files`);
      let left = shown;
      for (const [file, mine] of byFile) {
        if (left <= 0) break;
        const inside = await this.enclosing(file);
        lines.push(this.show(file, options));
        for (const hit of mine.slice(0, left)) {
          const around = inside(hit.line);
          lines.push(`${String(hit.line).padStart(7)}  ${around === null ? '' : `[${around}] `}${hit.text.trim().slice(0, 160)}`);
        }
        left -= mine.length;
      }
      room -= shown;
      if (hits.length > shown) lines.push(`[${hits.length - shown} more: give a narrower path, or raise --limit]`);
    };
    if (server !== null) await list(sure, `${name}: ${server.grade} (${server.name})`);
    const others = server !== null && sure.length > 0;
    await list(loose, `${others ? `${name} in other languages` : name}: ${text?.grade} (${text?.name}): every place the word appears, whatever it names there`);
    return { status: 0, text: lines.join('\n') + '\n' };
  }
  /** For one file, a function from a line to the name of the function or type around it. Without a backend for the file, it knows nothing. */
  private async enclosing(file: string): Promise<(line: number) => string | null> {
    const language = languageOf(file, this.languages);
    const backend = language === null ? null : await this.pick('outline', language);
    if (language === null || backend === null) return () => null;
    let symbols: Sym[];
    try { symbols = (await backend.outline!([file], language)).filter((sym) => sym.end > sym.line && !MINOR.has(sym.kind)); } catch { return () => null; }
    return (line) => {
      let best: Sym | null = null;
      for (const sym of symbols) if (sym.line <= line && line <= sym.end && (best === null || sym.line >= best.line)) best = sym;
      return best === null ? null : best.name;
    };
  }

  /** Code of a given shape: a pattern in the language's own syntax, where `$NAME` stands for one node and `$$$NAME` for any number. */
  async search(pattern: string, paths: string[], options: Options): Promise<Answer> {
    const targets = (paths.length === 0 ? ['.'] : paths).map((path) => resolve(options.cwd, path));
    for (const target of targets) if (!existsSync(target)) throw new CodeError(`${target}: no such file or directory`);
    const single = targets.find((target) => statSync(target).isFile());
    if (options.lang === undefined && single === undefined) throw new CodeError('a search in a directory needs --lang <language>: a pattern is written in one language');
    const language = this.language(single ?? '', options);
    const backend = await this.pick('search', language);
    if (backend === null) throw new CodeError(`nothing here can search ${language.name} by shape; \`code languages\` says what is missing. \`rg\` searches text`);
    const hits = await backend.search!(pattern, language, targets);
    if (hits.length === 0) return { status: 1, text: `no ${language.name} code matches the pattern\n` };
    const limit = this.limit(options, LIMITS.search);
    const lines = [`${backend.grade} (${backend.name}); ${Math.min(hits.length, limit)} of ${hits.length} matches`];
    for (const hit of hits.slice(0, limit)) {
      const span = hit.end !== undefined && hit.end > hit.line ? `${hit.line}-${hit.end}` : `${hit.line}`;
      lines.push(`${this.show(hit.path, options)}:${span}  ${hit.text.split('\n')[0]!.trim().slice(0, 160)}`);
    }
    if (hits.length > limit) lines.push(`[${hits.length - limit} more: give a narrower path or pattern, or raise --limit]`);
    return { status: 0, text: lines.join('\n') + '\n' };
  }

  /** What a compiler says about one file, by the language server. */
  async diagnostics(path: string, options: Options): Promise<Answer> {
    const file = resolve(options.cwd, path);
    if (!existsSync(file) || !statSync(file).isFile()) throw new CodeError(`${file}: no such file`);
    const language = this.language(file, options);
    const server = await this.pick('diagnostics', language);
    if (server === null) throw new CodeError(`nothing here checks ${language.name}; \`code languages\` says what is there`);
    const found = await server.diagnostics!(file, projectRoot(file), language);
    if (found === null) throw new CodeError(`${server.name} could not check ${this.show(file, options)}: it has no compile commands for this project (a Makefile or compile_commands.json at its root), or did not finish in time`);
    const limit = this.limit(options, LIMITS.diagnostics);
    const lines = [`${this.show(file, options)}: ${server.grade} (${server.name}); ${found.length === 0 ? 'no problems' : `${Math.min(found.length, limit)} of ${found.length} problems`}`];
    for (const one of found.slice(0, limit)) lines.push(`${`${one.line}:${one.column}`.padStart(9)}  ${one.severity.padEnd(7)} ${one.message.slice(0, 200)}`);
    return { status: 0, text: lines.join('\n') + '\n' };
  }

  /** What is supported here, and by what: one line for each language. */
  async supported(): Promise<Answer> {
    const lines = [['language'.padEnd(11), 'files'.padEnd(22), 'outline'.padEnd(21), 'search'.padEnd(21), 'definition'.padEnd(21), 'references'.padEnd(21), 'diagnostics'].join(' ')];
    for (const language of this.languages) {
      // A name is resolved by a language server when there is one; without, a definition comes from the outline and a use from the text.
      const cell = async (op: Op, without?: Op): Promise<string> => {
        const backend = (await this.pick(op, language)) ?? (without === undefined ? null : await this.pick(without, without === 'grep' ? null : language));
        return (backend === null ? '-' : `${backend.name} (${backend.grade})`).padEnd(21);
      };
      lines.push([
        language.name.padEnd(11), language.extensions.join(' ').padEnd(22),
        await cell('outline'), await cell('search'), await cell('outline'), await cell('references', 'grep'), await cell('diagnostics'),
      ].join(' ').trimEnd());
    }
    lines.push('A dash means nothing here answers that: the program is not among the body\'s packages and organs, nor in the image.');
    return { status: 0, text: lines.join('\n') + '\n' };
  }
}

export const USAGE = `code: questions about source code, answered the same way in every language.

  code outline <file>              what the file defines, with line ranges
  code symbol <name> [path]        the body of a function or type, with line numbers
  code definition <name> [path]    where a name is defined; with file:line as the path,
                                   the name as it is used on that line
  code references <name> [path]    every use of a name, by file, with the function it is in
  code search <pattern> [path...]  code of a given shape; $X is one node, $$$X any number
  code diagnostics <file>          what a compiler says about the file
  code languages                   what is supported in this container, and how well

[path] is a file or a directory, the current directory when left out.
Options: --lang <language>  --match <regex>  --kind <kind>  --all  --limit <n>
Each answer begins with how sure it is: exact (a language server resolved the name),
syntactic (a parser saw the shape) or textual (the word matched).
Exit status: 0 found, 1 nothing found, 2 the question could not be asked.
`;
