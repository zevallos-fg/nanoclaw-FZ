// BankForge HQ3.H.44 (GO b63f4f39, D-HQ3-64). libsignal (pulled in by Baileys) prints whole session
// objects with console.info: "Closing session:", "Opening session:" and "Removing old closed session:".
// Each object carries the ratchet's private key and root key, and stdout is redirected to
// logs/nanoclaw.log, so key material landed in a plain-text file. Fernando chose "stop logging keys".
//
// This wraps the console methods once. A call is redacted when its first argument is one of those
// session messages, or when any argument is a Signal session object. The redacted line keeps the
// event name so the log still shows that a session opened or closed, without any key bytes.

const SESSION_MESSAGE =
  /^(Closing session|Opening session|Removing old closed session)\b/;
const SESSION_CLASS_NAMES = new Set(['SessionEntry', 'SessionRecord']);

function isSessionObject(arg: unknown): boolean {
  if (!arg || typeof arg !== 'object') return false;
  const name = (arg as { constructor?: { name?: string } }).constructor?.name;
  if (name && SESSION_CLASS_NAMES.has(name)) return true;
  // Shape check for a plain object carrying the same fields.
  const o = arg as Record<string, unknown>;
  return 'currentRatchet' in o || 'indexInfo' in o || '_chains' in o;
}

export function redactSignalArgs(args: unknown[]): unknown[] | null {
  const first = args[0];
  const namedEvent =
    typeof first === 'string' && SESSION_MESSAGE.test(first.trim());
  if (!namedEvent && !args.some(isSessionObject)) return null;
  const label = namedEvent ? first.trim().replace(/:$/, '') : 'signal session';
  return [`${label}: [session object redacted]`];
}

const METHODS = ['log', 'info', 'debug', 'warn', 'error'] as const;
const INSTALLED = Symbol.for('bankforge.signalLogRedact');

export function installSignalLogRedaction(target: Console = console): void {
  const t = target as Console & { [INSTALLED]?: boolean };
  if (t[INSTALLED]) return;
  for (const m of METHODS) {
    const original = t[m].bind(t);
    t[m] = (...args: unknown[]) => {
      const redacted = redactSignalArgs(args);
      original(...(redacted ?? args));
    };
  }
  t[INSTALLED] = true;
}

installSignalLogRedaction();
