// BankForge HQ3.H.44 (GO b63f4f39, D-HQ3-64): outbox-only mode and the Signal key-log redaction.
import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { isOutboxOnly } from './config.js';
import {
  AgentsDisabledError,
  assertAgentsAllowed,
} from './container-runner.js';
import {
  installSignalLogRedaction,
  redactSignalArgs,
} from './signal-log-redact.js';

describe('outbox-only is the default and fails closed', () => {
  it('only an explicit 1/true/yes allows agents', () => {
    for (const v of [undefined, '', ' ', 'false', '0', 'no', 'ture', 'enabled'])
      expect(isOutboxOnly(v), String(v)).toBe(true);
    for (const v of ['1', 'true', 'TRUE', 'yes', ' yes '])
      expect(isOutboxOnly(v), v).toBe(false);
  });

  it('the container spawn point refuses in outbox-only mode', () => {
    expect(() => assertAgentsAllowed(true)).toThrow(AgentsDisabledError);
    expect(() => assertAgentsAllowed(false)).not.toThrow();
  });

  it('runContainerAgent calls the guard before it mounts or spawns anything', () => {
    const src = fs.readFileSync(
      path.join(__dirname, 'container-runner.ts'),
      'utf8',
    );
    const body = src.slice(
      src.indexOf('export async function runContainerAgent('),
    );
    const guard = body.indexOf('assertAgentsAllowed(OUTBOX_ONLY)');
    expect(guard).toBeGreaterThan(0);
    for (const later of [
      'buildVolumeMounts(',
      'spawn(',
      'resolveGroupFolderPath(',
    ])
      expect(body.indexOf(later), later).toBeGreaterThan(guard);
  });

  it('main() starts no message loop, recovery or scheduler in outbox-only mode', () => {
    const src = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8');
    expect(src).toMatch(/if \(!OUTBOX_ONLY\) startSchedulerLoop\(/);
    const early = src.indexOf('if (OUTBOX_ONLY) {');
    expect(early).toBeGreaterThan(0);
    expect(src.indexOf('startMessageLoop().catch', early)).toBeGreaterThan(
      early,
    );
    expect(src.indexOf('recoverPendingMessages();', early)).toBeGreaterThan(
      early,
    );
    expect(src.slice(early, src.indexOf('}', early))).toMatch(/return;/);
  });
});

describe('Signal session objects never reach the log', () => {
  const fakeSession = () => {
    class SessionEntry {
      currentRatchet = {
        ephemeralKeyPair: { privKey: Buffer.from('secret-bytes') },
      };
    }
    return new SessionEntry();
  };

  it('redacts the three libsignal session messages and any session object', () => {
    for (const msg of [
      'Closing session:',
      'Opening session:',
      'Removing old closed session:',
    ]) {
      const out = redactSignalArgs([msg, fakeSession()]);
      expect(out).not.toBeNull();
      expect(JSON.stringify(out)).not.toMatch(/privKey|secret/);
    }
    expect(redactSignalArgs(['something else', fakeSession()])).toEqual([
      'signal session: [session object redacted]',
    ]);
  });

  it('leaves ordinary log lines untouched', () => {
    expect(
      redactSignalArgs(['Failed to decrypt message with any known session...']),
    ).toBeNull();
    expect(redactSignalArgs(['Outbox notice sent', { count: 1 }])).toBeNull();
  });

  it('the installed console writes no key bytes', () => {
    const written: unknown[][] = [];
    const fake = {
      log: (...a: unknown[]) => written.push(a),
      info: (...a: unknown[]) => written.push(a),
      debug: (...a: unknown[]) => written.push(a),
      warn: (...a: unknown[]) => written.push(a),
      error: (...a: unknown[]) => written.push(a),
    } as unknown as Console;
    installSignalLogRedaction(fake);
    fake.info('Closing session:', fakeSession());
    fake.info('normal line');
    expect(JSON.stringify(written)).not.toMatch(/privKey|secret/);
    expect(written[1]).toEqual(['normal line']);
    vi.restoreAllMocks();
  });
});
