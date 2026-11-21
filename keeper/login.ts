import { authDir } from '../brain/providers';
import { saveToken } from '../species/github';
import { storedAccount, type DeviceSignIn, type GithubAccount, type GithubStep } from './github';
import { GITHUB_OWN, accountFacts, githubLine } from './setup';

// `/login` in the talk client: the agent's own accounts, as `/owner` is the owner's. `/login`
// says who the agent is on GitHub; `/login github` signs it in by a one-time code, the same
// sign-in the setup ends with (keeper/github.ts), without leaving the conversation: the code is
// shown, the talk goes on, and the client says so when GitHub answers. Nothing is stored until
// the owner has read whose account came back and confirmed it by its name.

const HOW = 'To sign the agent in to its own account: /login github gives a one-time code, which you type in a browser where you are logged in as the agent\'s account, not your own.';
const SERVICES = ['github'];

export class Logins {
  /** The sign-in whose code is out. */
  private under: DeviceSignIn | null = null;
  /** A token GitHub gave, waiting for the owner to say that its account is the agent's. It lives in this client's memory only. */
  private pending: { token: string; account: GithubAccount } | null = null;

  /** `later`: what to show when something asked earlier has an answer. */
  constructor(private readonly root: string, private readonly gh: GithubStep, private readonly later: (lines: string[]) => void) {}

  /** Carries out `/login`, `/login github`, `/login github <account>` and `/login github no`, and answers with what to show now. */
  async command(arg: string): Promise<string[]> {
    const words = arg.trim().split(/\s+/).filter((w) => w !== '');
    const auth = authDir(this.root);
    if (words.length === 0) return [githubLine({ account: await storedAccount(auth, this.gh.who), changed: false }), HOW];
    if (words[0]!.toLowerCase() !== 'github' || words.length > 2) return [`The agent can be signed in at: ${SERVICES.join(', ')}.`];
    if (words.length === 2) {
      const held = this.pending;
      if (held === null) return ['No sign-in is waiting for your word. /login github gives a code.'];
      const said = words[1]!.toLowerCase();
      if (said === 'no') {
        this.pending = null;
        return ['Dropped: nothing was stored. /login github gives a new code.'];
      }
      if (said !== held.account.login.toLowerCase()) return [`The code was typed by ${held.account.login}. /login github ${held.account.login} stores that account as the agent's; /login github no drops it.`];
      saveToken(auth, held.token);
      this.pending = null;
      return [githubLine({ account: held.account, changed: true })];
    }
    // A new code replaces one that is out, and anything that waited for a word.
    this.under?.cancel();
    this.pending = null;
    let started: DeviceSignIn;
    try {
      started = await this.gh.signIn();
    } catch (err) {
      return [`The sign-in at GitHub could not be started: ${err instanceof Error ? err.message : String(err)}`];
    }
    this.under = started;
    void started.done.then(async (token) => {
      if (this.under !== started) return;
      this.under = null;
      const account = await this.gh.who(token);
      this.pending = { token, account };
      this.later([
        `GitHub says the code was typed by ${accountFacts(account)}.`,
        GITHUB_OWN,
        `/login github ${account.login} stores it as the agent's account; /login github no drops it.`,
      ]);
    }).catch((err: unknown) => {
      if (this.under !== started) return;
      this.under = null;
      this.later([`The sign-in at GitHub did not work: ${err instanceof Error ? err.message : String(err)}. /login github gives a new code.`]);
    });
    return [
      `Open ${started.url} in a browser where you are logged in as the agent's account, not your own, and type this code:`,
      `    ${started.code}`,
      'It is good for a quarter of an hour. The conversation goes on meanwhile, and you are told here when GitHub answers.',
    ];
  }

  /** The client is leaving: a code that is out is given up, and a token not confirmed is forgotten. */
  close(): void {
    const under = this.under;
    this.under = null;
    this.pending = null;
    under?.cancel();
  }
}
