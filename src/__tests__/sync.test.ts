/**
 * Tests for the sync queue.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { makeMutationId } from '../sync/queue';

describe('makeMutationId', () => {
  it('generates deterministic IDs', () => {
    const id1 = makeMutationId('user-1', '2026-05-01', 'upsert');
    const id2 = makeMutationId('user-1', '2026-05-01', 'upsert');
    expect(id1).toBe(id2);
  });

  it('generates different IDs for different inputs', () => {
    const id1 = makeMutationId('user-1', '2026-05-01', 'upsert');
    const id2 = makeMutationId('user-1', '2026-05-02', 'upsert');
    const id3 = makeMutationId('user-2', '2026-05-01', 'upsert');
    const id4 = makeMutationId('user-1', '2026-05-01', 'delete');

    expect(id1).not.toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1).not.toBe(id4);
  });

  it('encodes userId:entryDate:action', () => {
    const id = makeMutationId('abc', '2026-05-01', 'upsert');
    expect(id).toBe('abc:2026-05-01:upsert');
  });
});

// Note: Full sync queue tests require IndexedDB mocking (via fake-indexeddb).
// The structure is here for expansion. Integration tests should use:
//   npm install -D fake-indexeddb
// and then:
//   import 'fake-indexeddb/auto';
// at the top of the test file to polyfill IDB in Node.
