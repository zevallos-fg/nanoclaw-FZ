import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  capText,
  parseNotice,
  processOutboxOnce,
  resolveMainJid,
  TRUNCATION_NOTE,
} from './outbox.js';
import { RegisteredGroup } from './types.js';

const MAIN = 'main@s.whatsapp.net';
const group = (isMain: boolean): RegisteredGroup =>
  ({
    name: 'g',
    folder: isMain ? 'main' : 'other',
    trigger: '@a',
    added_at: '2026-01-01',
    isMain,
  }) as RegisteredGroup;

function notice(over: Record<string, unknown> = {}) {
  return {
    type: 'notify',
    text: 'hello',
    dedupe_key: 'k1',
    source: 'test',
    created_at: '2026-11-22T07:00:00Z',
    ...over,
  };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function drop(name: string, body: unknown) {
  fs.writeFileSync(
    path.join(dir, name),
    typeof body === 'string' ? body : JSON.stringify(body),
  );
}

function deps(
  over: Partial<{
    groups: Record<string, RegisteredGroup>;
    connected: boolean;
    send: (j: string, t: string) => Promise<void>;
  }> = {},
) {
  const send = vi.fn(over.send ?? (async () => {}));
  return {
    send,
    d: {
      sendMessage: send,
      registeredGroups: () =>
        over.groups ?? { [MAIN]: group(true), 'x@g.us': group(false) },
      isConnected: () => over.connected ?? true,
    },
  };
}

describe('parseNotice', () => {
  it('accepts the exact shape', () => {
    expect(parseNotice(notice()).ok).toBe(true);
  });
  it('refuses a recipient field', () => {
    const r = parseNotice(notice({ chatJid: 'someone@s.whatsapp.net' }));
    expect(r.ok).toBe(false);
  });
  it('refuses a wrong type, empty text and a bad dedupe key', () => {
    expect(parseNotice(notice({ type: 'message' })).ok).toBe(false);
    expect(parseNotice(notice({ text: '  ' })).ok).toBe(false);
    expect(parseNotice(notice({ dedupe_key: '../escape' })).ok).toBe(false);
  });
});

describe('resolveMainJid', () => {
  it('finds the single main group', () => {
    expect(
      resolveMainJid({ [MAIN]: group(true), 'x@g.us': group(false) }),
    ).toEqual({ ok: true, jid: MAIN });
  });
  it('refuses zero or two main groups', () => {
    expect(resolveMainJid({ 'x@g.us': group(false) }).ok).toBe(false);
    expect(resolveMainJid({ a: group(true), b: group(true) }).ok).toBe(false);
  });
});

describe('capText', () => {
  it('leaves short text alone and caps long text with a note', () => {
    expect(capText('abc', 10)).toBe('abc');
    const out = capText('x'.repeat(100), 60);
    expect(out.length).toBe(60);
    expect(out.endsWith(TRUNCATION_NOTE)).toBe(true);
  });
});

describe('processOutboxOnce', () => {
  it('sends a valid file to the main group, writes a receipt without the text, and deletes the file', async () => {
    drop('a.json', notice());
    const { send, d } = deps();
    const r = await processOutboxOnce(d, { dir, now: () => 1_000_000 });
    expect(send).toHaveBeenCalledWith(MAIN, 'hello');
    expect(r.sent).toEqual(['a.json']);
    expect(fs.existsSync(path.join(dir, 'a.json'))).toBe(false);
    const receipt = JSON.parse(
      fs.readFileSync(path.join(dir, 'sent', 'k1.json'), 'utf8'),
    );
    expect(receipt.text).toBeUndefined();
    expect(receipt.source).toBe('test');
  });
  it('holds the file while disconnected', async () => {
    drop('a.json', notice());
    const { send, d } = deps({ connected: false });
    const r = await processOutboxOnce(d, { dir, now: () => 1_000_000 });
    expect(send).not.toHaveBeenCalled();
    expect(r.held).toEqual(['a.json']);
    expect(fs.existsSync(path.join(dir, 'a.json'))).toBe(true);
  });
  it('holds the file when there is not exactly one main group', async () => {
    drop('a.json', notice());
    const { send, d } = deps({ groups: { a: group(true), b: group(true) } });
    const r = await processOutboxOnce(d, { dir, now: () => 1_000_000 });
    expect(send).not.toHaveBeenCalled();
    expect(r.held).toEqual(['a.json']);
  });
  it('keeps the file when the send fails', async () => {
    drop('a.json', notice());
    const { d } = deps({
      send: async () => {
        throw new Error('boom');
      },
    });
    const r = await processOutboxOnce(d, { dir, now: () => 1_000_000 });
    expect(r.held).toEqual(['a.json']);
    expect(fs.existsSync(path.join(dir, 'a.json'))).toBe(true);
  });
  it('moves a duplicate dedupe_key aside without sending', async () => {
    fs.mkdirSync(path.join(dir, 'sent'));
    fs.writeFileSync(path.join(dir, 'sent', 'k1.json'), '{}');
    drop('a.json', notice());
    const { send, d } = deps();
    const r = await processOutboxOnce(d, { dir, now: () => 1_000_000 });
    expect(send).not.toHaveBeenCalled();
    expect(r.duplicates).toEqual(['a.json']);
    expect(fs.existsSync(path.join(dir, 'duplicates', 'a.json'))).toBe(true);
  });
  it('moves bad shapes and bad JSON to errors with a reason', async () => {
    drop('a.json', notice({ chatJid: 'x' }));
    drop('b.json', '{not json');
    const { send, d } = deps();
    const r = await processOutboxOnce(d, { dir, now: () => 1_000_000 });
    expect(send).not.toHaveBeenCalled();
    expect(r.refused.sort()).toEqual(['a.json', 'b.json']);
    expect(fs.existsSync(path.join(dir, 'errors', 'a.json.reason.txt'))).toBe(
      true,
    );
  });
  it('ignores half-written .tmp files', async () => {
    drop('a.json.tmp', notice());
    const { send, d } = deps();
    const r = await processOutboxOnce(d, { dir, now: () => 1_000_000 });
    expect(send).not.toHaveBeenCalled();
    expect(r.sent).toEqual([]);
  });
  it('sends at most one file per pass and respects the gap since the last send', async () => {
    drop('a.json', notice({ dedupe_key: 'k1' }));
    drop('b.json', notice({ dedupe_key: 'k2' }));
    const { send, d } = deps();
    const r1 = await processOutboxOnce(d, { dir, now: () => 1_000_000 });
    expect(r1.sent).toEqual(['a.json']);
    expect(r1.held).toEqual(['b.json']);
    const r2 = await processOutboxOnce(d, {
      dir,
      now: () => 1_000_500,
      lastSentAt: r1.lastSentAt,
    });
    expect(r2.sent).toEqual([]);
    const r3 = await processOutboxOnce(d, {
      dir,
      now: () => 1_020_000,
      lastSentAt: r1.lastSentAt,
    });
    expect(r3.sent).toEqual(['b.json']);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
