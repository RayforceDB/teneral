import { Code, CodeError, USAGE, type Options } from './code';
import { backends } from './code-backends';

/**
 * The `code` command: body/bin/code starts this file, and `bash` has that directory on its PATH
 * (body/tools.ts). What it prints is the whole answer, short enough to read, and its exit status
 * says whether anything was found.
 */

const FLAGS_WITH_VALUE = new Set(['--lang', '--match', '--kind', '--limit']);

export function parse(argv: string[]): { words: string[]; flags: Record<string, string | true> } {
  const words: string[] = []; const flags: Record<string, string | true> = {};
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at]!;
    if (arg === '--') { words.push(...argv.slice(at + 1)); break; }
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (FLAGS_WITH_VALUE.has(name)) {
      const value = equals === -1 ? argv[++at] : arg.slice(equals + 1);
      if (value === undefined) throw new CodeError(`${name} needs a value`);
      flags[name] = value;
    } else if (name === '--all' || name === '--help' || name === '-h') flags[name === '-h' ? '--help' : name] = true;
    else if (arg.startsWith('--')) throw new CodeError(`unknown option: ${arg}`);
    // A pattern may begin with a dash or a dollar; only what begins with two dashes is an option.
    else words.push(arg);
  }
  return { words, flags };
}

export async function answer(argv: string[], cwd: string, code: Code = new Code(backends())): Promise<{ status: 0 | 1 | 2; text: string }> {
  try {
    const { words, flags } = parse(argv);
    const [operation, first, ...rest] = words;
    if (operation === undefined || flags['--help'] === true || operation === 'help') return { status: operation === undefined && flags['--help'] !== true ? 2 : 0, text: USAGE };
    const options: Options = {
      cwd, all: flags['--all'] === true,
      ...(typeof flags['--lang'] === 'string' ? { lang: flags['--lang'] } : {}), ...(typeof flags['--match'] === 'string' ? { match: flags['--match'] } : {}),
      ...(typeof flags['--kind'] === 'string' ? { kind: flags['--kind'] } : {}), ...(typeof flags['--limit'] === 'string' ? { limit: Number(flags['--limit']) } : {}),
    };
    const need = (what: string): string => { if (first === undefined) throw new CodeError(`code ${operation} needs ${what}; \`code --help\` shows the forms`); return first; };
    switch (operation) {
      case 'outline': return await code.outline(need('a file'), options);
      case 'symbol': return await code.symbol(need('a name'), rest[0] ?? '.', options);
      case 'definition': case 'def': return await code.definition(need('a name'), rest[0] ?? '.', options);
      case 'references': case 'refs': return await code.references(need('a name'), rest[0] ?? '.', options);
      case 'search': return await code.search(need('a pattern'), rest, options);
      case 'languages': return await code.supported();
      default: throw new CodeError(`unknown question: ${operation}; \`code --help\` shows what can be asked`);
    }
  } catch (error) {
    if (error instanceof CodeError || error instanceof SyntaxError) return { status: 2, text: `code: ${error.message}\n` };
    throw error;
  }
}

if (import.meta.main) {
  const result = await answer(process.argv.slice(2), process.cwd());
  (result.status === 2 ? process.stderr : process.stdout).write(result.text);
  process.exit(result.status);
}
