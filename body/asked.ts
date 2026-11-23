import { journalPast, type Past } from '../brain/past';
import type { ToolContext } from './tools';

/**
 * The past a tool asks: the one the body opened, which answers from the database; or, where a
 * tool is run with none (a test, a script), the journal read through, which answers the same.
 * A tool reads nothing of the journal for itself.
 */
export function pastOf(ctx: ToolContext): Past {
  return ctx.past ??= journalPast(ctx.journal);
}
