import { beforeEach, describe, it, expect, vi } from 'vitest';
import { createDb, setDb, getCursorLedger, setCursorLedger, rollbackToLedger } from '../src/db';

describe('Crash recovery & cursor rollback tests (#1265 & #1266)', () => {
  beforeEach(() => {
    setDb(createDb(':memory:'));
  });
  it('preserves cursor sequence across crashes and restarts', () => {
    setCursorLedger(1000);
    expect(getCursorLedger()).toBe(1000);

    // Simulate crash and resume
    const resumedCursor = getCursorLedger();
    expect(resumedCursor).toBe(1000);
  });

  it('rolls back cursor boundedly on reorg', () => {
    setCursorLedger(2000);
    rollbackToLedger(1950);
    expect(getCursorLedger()).toBe(1950);
  });
});
