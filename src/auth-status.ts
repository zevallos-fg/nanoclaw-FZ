/**
 * auth-status — what the WhatsApp connection was OBSERVED to be, and when.
 *
 * ============================================================================================
 * THE DEFECT THIS EXISTS TO FIX.
 *
 * `store/auth-status.txt` held the single word `authenticated`, written 2026-04-03 11:40 and never
 * touched again. On 2026-08-21 the connection returned 401 loggedOut — and the file still said
 * `authenticated`, because nothing in the RUNTIME ever wrote to it. Both producers
 * (`src/whatsapp-auth.ts` and `setup/whatsapp-auth.ts`) run only during setup; the runtime handler in
 * `src/channels/whatsapp.ts` sees every connection event and wrote nothing.
 *
 * A status written once is a claim about the past wearing the tense of the present. It is worse than
 * no file at all, because it will be believed: nothing cross-checks it, and its only reader is a
 * human who has no way to tell a fresh observation from a four-month-old one.
 *
 * ============================================================================================
 * THE TWO RULES THIS MODULE ENFORCES.
 *
 * 1. NEVER INFER `authenticated` FROM THE ABSENCE OF A FAILURE. Every record is written by code that
 *    just watched a connection event. There is no code path that writes a success state on a guess.
 *
 * 2. AN OBSERVATION WITHOUT A TIMESTAMP IS NOT AN OBSERVATION. Every record carries `observed_at`,
 *    and a reader marks it STALE once it is older than one scheduled run. A legacy bare-token file —
 *    exactly the one that lied — parses as `legacy` and is reported NOT-ESTABLISHED, because a value
 *    that cannot be dated cannot be trusted, whatever it says.
 *
 * ============================================================================================
 * WHY LINE 1 IS STILL THE OLD VOCABULARY.
 *
 * `setup/whatsapp-auth.ts` POLLS this file during `/setup` and compares it with `===` against
 * `authenticated` / `already_authenticated`, and with `startsWith` against `failed:` / `pairing_code:`.
 * Changing that vocabulary would break the setup handshake — the very thing Fernando has to run to
 * recover the transport. So line 1 stays byte-compatible with the legacy tokens and the observation
 * metadata goes on the lines below it. The consumers were made first-line-tolerant in the same
 * commit; for a legacy single-line file, the first line IS the whole file, so old files still read
 * correctly.
 */
import fs from 'fs';
import path from 'path';

/** What was actually observed. `legacy` and `unreadable` are read-side outcomes, never written. */
export type AuthState =
  | 'connected'
  | 'already_connected'
  | 'logged_out'
  | 'connection_failed'
  | 'awaiting_qr'
  | 'awaiting_pairing_code'
  | 'legacy'
  | 'unreadable'
  | 'absent';

export interface AuthObservation {
  state: AuthState;
  observedAt: string | null;
  observedBy: string | null;
  detail: string | null;
  /** The raw first line, kept so a reader can always see what the setup handshake will see. */
  token: string;
}

/**
 * One scheduled run. The morning brief fires daily, so an observation older than a day has survived
 * a delivery window without being refreshed and cannot speak for the present.
 * Overridable so a different cadence does not require a code change.
 */
export const STALE_AFTER_MS =
  Number(process.env.AUTH_STATUS_STALE_AFTER_MS) || 24 * 60 * 60 * 1000;

/**
 * PURE. The legacy token for a state — line 1, which `setup/whatsapp-auth.ts` still parses.
 * `pairing_code:` carries its code, so it is built by the caller rather than mapped here.
 */
export function legacyToken(state: AuthState, detail?: string): string {
  switch (state) {
    case 'connected':
      return 'authenticated';
    case 'already_connected':
      return 'already_authenticated';
    case 'logged_out':
      return 'failed:logged_out';
    case 'connection_failed':
      return `failed:${detail && /^[a-z0-9_]+$/i.test(detail) ? detail : 'unknown'}`;
    case 'awaiting_qr':
      return 'awaiting_qr';
    case 'awaiting_pairing_code':
      return 'awaiting_pairing_code';
    default:
      return 'unknown';
  }
}

/** PURE. Render an observation to the file format. Line 1 is the legacy token; the rest is new. */
export function formatStatus(o: {
  state: AuthState;
  observedAt: string;
  observedBy: string;
  detail?: string;
  token?: string;
}): string {
  const lines = [
    o.token ?? legacyToken(o.state, o.detail),
    `state: ${o.state}`,
    `observed_at: ${o.observedAt}`,
    `observed_by: ${o.observedBy}`,
  ];
  if (o.detail) lines.push(`detail: ${o.detail}`);
  lines.push(`stale_after_ms: ${STALE_AFTER_MS}`);
  lines.push(
    '# Line 1 is the legacy token the setup handshake parses. The lines below are the observation.',
  );
  lines.push(
    '# No line here is ever written on a guess: each one follows a connection event this process saw.',
  );
  return lines.join('\n') + '\n';
}

/**
 * PURE. Parse the file back.
 * A file with no `observed_at` is `legacy` NO MATTER WHAT ITS FIRST LINE SAYS — that is the whole
 * point. The old file said `authenticated` and was four months stale; an undated claim is not
 * evidence, so it is not promoted to one.
 */
export function parseStatus(text: string | null): AuthObservation {
  if (text === null) {
    return {
      state: 'absent',
      observedAt: null,
      observedBy: null,
      detail: null,
      token: '',
    };
  }
  const lines = text.split(/\r?\n/);
  const token = (lines[0] ?? '').trim();
  const field = (name: string): string | null => {
    for (const l of lines.slice(1)) {
      const m = new RegExp(`^${name}:\\s*(.+?)\\s*$`).exec(l);
      if (m) return m[1];
    }
    return null;
  };
  const observedAt = field('observed_at');
  if (!observedAt) {
    return {
      state: token === '' ? 'unreadable' : 'legacy',
      observedAt: null,
      observedBy: null,
      detail: null,
      token,
    };
  }
  const rawState = field('state');
  const known: AuthState[] = [
    'connected',
    'already_connected',
    'logged_out',
    'connection_failed',
    'awaiting_qr',
    'awaiting_pairing_code',
  ];
  const state = known.includes(rawState as AuthState)
    ? (rawState as AuthState)
    : 'unreadable';
  return {
    state,
    observedAt,
    observedBy: field('observed_by'),
    detail: field('detail'),
    token,
  };
}

export interface Assessment {
  /** True only when a dated observation says the connection was up AND it is not stale. */
  trustedConnected: boolean;
  stale: boolean;
  ageMs: number | null;
  verdict: string;
  reason: string;
}

/**
 * PURE. Turn an observation into a verdict at a point in time.
 * NOT-ESTABLISHED is a correct answer here and is used freely. `authenticated` is not: it is only
 * ever reported from a dated, fresh, observed `connected`.
 */
export function assess(
  o: AuthObservation,
  nowMs: number,
  staleAfterMs = STALE_AFTER_MS,
): Assessment {
  if (o.state === 'absent') {
    return {
      trustedConnected: false,
      stale: false,
      ageMs: null,
      verdict: 'NOT-ESTABLISHED',
      reason:
        'no status file exists. Nothing has observed the connection, which is not the same as it being down.',
    };
  }
  if (o.state === 'legacy') {
    return {
      trustedConnected: false,
      stale: true,
      ageMs: null,
      verdict: 'NOT-ESTABLISHED',
      reason: `the file carries a bare token (${JSON.stringify(o.token)}) with no observation timestamp. An undated claim cannot be dated after the fact, so it is not evidence of anything — this is the exact shape of the file that read "authenticated" through a 401.`,
    };
  }
  if (o.state === 'unreadable') {
    return {
      trustedConnected: false,
      stale: true,
      ageMs: null,
      verdict: 'NOT-ESTABLISHED',
      reason: 'the file exists but does not parse as an observation.',
    };
  }

  const ts = Date.parse(o.observedAt ?? '');
  if (!Number.isFinite(ts)) {
    return {
      trustedConnected: false,
      stale: true,
      ageMs: null,
      verdict: 'NOT-ESTABLISHED',
      reason: `observed_at is not a parseable timestamp (${JSON.stringify(o.observedAt)}).`,
    };
  }
  const ageMs = nowMs - ts;
  const stale = ageMs > staleAfterMs;
  const up = o.state === 'connected' || o.state === 'already_connected';

  if (stale) {
    return {
      trustedConnected: false,
      stale: true,
      ageMs,
      verdict: 'STALE',
      reason: `last observation was ${o.state} ${describeAge(ageMs)} ago, which is longer than one scheduled run. It describes a past connection, not the current one.`,
    };
  }
  return {
    trustedConnected: up,
    stale: false,
    ageMs,
    verdict: up ? 'CONNECTED' : o.state.toUpperCase(),
    reason: `observed ${o.state} ${describeAge(ageMs)} ago${o.detail ? ` (${o.detail})` : ''}.`,
  };
}

/** PURE. */
export function describeAge(ms: number): string {
  if (ms < 0) return 'in the future (clock skew)';
  const s = Math.floor(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// --------------------------------------------------------------------------------------------
// Impure edges.
// --------------------------------------------------------------------------------------------

function statusPath(storeDir: string): string {
  return path.join(storeDir, 'auth-status.txt');
}

/**
 * Record what was just observed. Atomic (write temp, then rename) so a crash mid-write cannot leave
 * a truncated file — a half-written status is indistinguishable from a confident one.
 * Never throws: a status file that cannot be written must not take the connection down with it.
 */
export function recordObservation(
  storeDir: string,
  o: { state: AuthState; observedBy: string; detail?: string; token?: string },
  now: Date = new Date(),
): void {
  const file = statusPath(storeDir);
  const text = formatStatus({ ...o, observedAt: now.toISOString() });
  try {
    fs.mkdirSync(storeDir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch {
    /* non-fatal by design — see above */
  }
}

export function readObservation(storeDir: string): AuthObservation {
  try {
    return parseStatus(fs.readFileSync(statusPath(storeDir), 'utf-8'));
  } catch {
    return parseStatus(null);
  }
}

/**
 * PURE. Render the human report.
 *
 * The "nothing observed it" caveat prints ONLY for NOT-ESTABLISHED and STALE, because those are the
 * verdicts where absence of evidence is the whole finding. Printing it under an observed
 * LOGGED_OUT would be its own small lie: something DID just observe the connection, and it is down.
 */
export function renderReport(o: AuthObservation, a: Assessment): string {
  const noEvidence = a.verdict === 'NOT-ESTABLISHED' || a.verdict === 'STALE';
  return [
    `whatsapp: ${a.verdict}`,
    `  ${a.reason}`,
    `  observed_at : ${o.observedAt ?? '(none recorded)'}`,
    `  observed_by : ${o.observedBy ?? '(unknown)'}`,
    `  line 1      : ${JSON.stringify(o.token)}   <- what /setup parses`,
    noEvidence
      ? '  This is NOT a claim that the connection is down. It is a claim that nothing recent observed it up.'
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}
