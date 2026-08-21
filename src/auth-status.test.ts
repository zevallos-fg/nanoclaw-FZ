import { describe, it, expect } from 'vitest';

import {
  assess,
  formatStatus,
  legacyToken,
  parseStatus,
  describeAge,
  STALE_AFTER_MS,
  renderReport,
} from './auth-status.js';

const T0 = Date.parse('2026-08-21T06:00:00.000Z');

const fresh = (
  state: Parameters<typeof formatStatus>[0]['state'],
  detail?: string,
) =>
  formatStatus({
    state,
    observedAt: new Date(T0).toISOString(),
    observedBy: 'test',
    detail,
  });

describe('the legacy file is the bug, and it must not parse as evidence', () => {
  it('reads a bare "authenticated" as legacy, NOT as connected', () => {
    // This is the exact file that sat on disk from 2026-04-03 to 2026-08-21 saying `authenticated`
    // while the connection returned 401. If this test ever goes green the other way, the defect
    // is back.
    const o = parseStatus('authenticated');
    expect(o.state).toBe('legacy');
    expect(assess(o, T0).trustedConnected).toBe(false);
    expect(assess(o, T0).verdict).toBe('NOT-ESTABLISHED');
  });

  it('reports NOT-ESTABLISHED, not "down", when the file is absent', () => {
    // Nobody looked and the connection is broken are different facts.
    const a = assess(parseStatus(null), T0);
    expect(a.verdict).toBe('NOT-ESTABLISHED');
    expect(a.reason).toMatch(/not the same as it being down/);
  });

  it('does not promote an undated token even when that token is a success token', () => {
    for (const token of ['authenticated', 'already_authenticated']) {
      expect(assess(parseStatus(token), T0).trustedConnected).toBe(false);
    }
  });
});

describe('round trip', () => {
  it('preserves state, timestamp and detail', () => {
    const o = parseStatus(fresh('logged_out', 'disconnect reason 401'));
    expect(o.state).toBe('logged_out');
    expect(o.observedAt).toBe(new Date(T0).toISOString());
    expect(o.detail).toBe('disconnect reason 401');
  });

  it('keeps line 1 in the legacy vocabulary the setup handshake parses', () => {
    // setup/whatsapp-auth.ts compares line 1 with === against these exact strings. Changing the
    // vocabulary would break /setup, which is the one thing that recovers the transport.
    expect(fresh('connected').split('\n')[0]).toBe('authenticated');
    expect(fresh('already_connected').split('\n')[0]).toBe(
      'already_authenticated',
    );
    expect(fresh('logged_out').split('\n')[0]).toBe('failed:logged_out');
    expect(fresh('connection_failed', 'qr_timeout').split('\n')[0]).toBe(
      'failed:qr_timeout',
    );
  });

  it('lets a caller supply line 1 verbatim, for pairing_code:<code>', () => {
    const text = formatStatus({
      state: 'awaiting_pairing_code',
      observedAt: new Date(T0).toISOString(),
      observedBy: 'test',
      token: 'pairing_code:ABCD1234',
    });
    expect(text.split('\n')[0]).toBe('pairing_code:ABCD1234');
    expect(parseStatus(text).state).toBe('awaiting_pairing_code');
  });

  it('never lets a free-text detail smuggle itself into line 1', () => {
    // failed:<reason> is parsed by the setup harness; an arbitrary detail there would corrupt it.
    const t = legacyToken('connection_failed', 'timed out: host unreachable');
    expect(t).toBe('failed:unknown');
  });

  it('survives a CRLF smudge', () => {
    const o = parseStatus(fresh('connected').replace(/\n/g, '\r\n'));
    expect(o.state).toBe('connected');
    expect(o.token).toBe('authenticated');
  });
});

describe('staleness is computed at read time', () => {
  it('trusts a fresh observed connection', () => {
    const a = assess(parseStatus(fresh('connected')), T0 + 60_000);
    expect(a.trustedConnected).toBe(true);
    expect(a.verdict).toBe('CONNECTED');
  });

  it('marks an observation older than one scheduled run STALE, even a successful one', () => {
    const a = assess(parseStatus(fresh('connected')), T0 + STALE_AFTER_MS + 1);
    expect(a.stale).toBe(true);
    expect(a.trustedConnected).toBe(false);
    expect(a.verdict).toBe('STALE');
  });

  it('does not report a fresh failure as stale', () => {
    const a = assess(parseStatus(fresh('logged_out')), T0 + 1000);
    expect(a.stale).toBe(false);
    expect(a.verdict).toBe('LOGGED_OUT');
    expect(a.trustedConnected).toBe(false);
  });

  it('separates STALE from NOT-ESTABLISHED', () => {
    const staleOne = assess(
      parseStatus(fresh('connected')),
      T0 + STALE_AFTER_MS + 1,
    );
    const undated = assess(parseStatus('authenticated'), T0);
    expect(staleOne.verdict).not.toBe(undated.verdict);
  });

  it('refuses an unparseable observed_at rather than treating it as now', () => {
    const text = fresh('connected').replace(
      new Date(T0).toISOString(),
      'yesterday',
    );
    expect(assess(parseStatus(text), T0).verdict).toBe('NOT-ESTABLISHED');
  });

  it('names clock skew instead of silently reporting a negative age', () => {
    expect(describeAge(-5)).toMatch(/future/);
  });
});

describe('describeAge', () => {
  it('scales its unit', () => {
    expect(describeAge(30_000)).toBe('30s');
    expect(describeAge(30 * 60_000)).toBe('30m');
    expect(describeAge(5 * 3_600_000)).toBe('5h');
    expect(describeAge(6 * 86_400_000)).toBe('6d');
  });
});

describe('renderReport does not add a caveat that contradicts the verdict', () => {
  it('omits the "nothing observed it" line when something DID just observe a failure', () => {
    // Printing it under an observed LOGGED_OUT would be this module committing the exact sin it
    // exists to fix: a report that says something the evidence does not.
    const o = parseStatus(fresh('logged_out', 'disconnect reason 401'));
    const report = renderReport(o, assess(o, T0 + 1000));
    expect(report).toContain('LOGGED_OUT');
    expect(report).not.toContain('nothing recent observed it up');
  });

  it('keeps the caveat where absence of evidence IS the finding', () => {
    for (const text of ['authenticated', fresh('connected')]) {
      const o = parseStatus(text);
      const a = assess(o, T0 + STALE_AFTER_MS + 1);
      expect(renderReport(o, a)).toContain('nothing recent observed it up');
    }
  });
});
