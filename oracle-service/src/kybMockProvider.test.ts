import { describe, expect, it } from 'vitest';

import { MockKYBProvider } from './kyb/mockProvider';

/**
 * The reference KYB adapter ships in `index.ts` re-exports and example wiring,
 * so its defaults (risk score and signal fallbacks) are part of the public
 * behaviour integrators depend on.
 */

const PAYER = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57';

describe('MockKYBProvider', () => {
  it('marks itself as a mock so production wiring can refuse it (#1234)', () => {
    // The marker travels with the instance however it was constructed —
    // including with a custom name — which is what the boot guard keys on.
    expect(new MockKYBProvider().isMock).toBe(true);
    expect(new MockKYBProvider({ name: 'acme' }).isMock).toBe(true);
  });

  it('verifies an unknown entity by default, deriving names from the address', async () => {
    const provider = new MockKYBProvider();
    const result = await provider.verifyPayer(PAYER);

    expect(result).toMatchObject({
      provider: 'MockKYBProvider',
      isVerified: true,
      businessName: `Verified Entity (${PAYER.slice(0, 8)})`,
      registrationNumber: `REG-${PAYER.slice(0, 6).toUpperCase()}-2026`,
      jurisdiction: 'US-DE',
      riskScore: 15,
      signals: [],
    });
    expect(result.rawDetails?.matchedKnownEntity).toBe(false);
  });

  it('uses metadata businessName when the entity is unknown', async () => {
    const provider = new MockKYBProvider({ name: 'acme' });
    const result = await provider.verifyPayer(PAYER, { businessName: 'Acme Ltd' });

    expect(result.provider).toBe('acme');
    expect(result.businessName).toBe('Acme Ltd');
  });

  it('fails unknown entities when configured to default unverified', async () => {
    const provider = new MockKYBProvider({
      defaultVerified: false,
      defaultJurisdiction: 'NG-CAC',
    });
    const result = await provider.verifyPayer(PAYER);

    expect(result.isVerified).toBe(false);
    expect(result.jurisdiction).toBe('NG-CAC');
    expect(result.riskScore).toBe(90);
    expect(result.signals).toEqual(['Entity not found in official registry']);
  });

  it('returns registered entity details verbatim', async () => {
    const provider = new MockKYBProvider({
      knownBusinesses: {
        [PAYER]: {
          isVerified: true,
          businessName: 'Known Co',
          registrationNumber: 'R-1',
          jurisdiction: 'GB',
          riskScore: 4,
          signals: ['fast'],
        },
      },
    });
    const result = await provider.verifyPayer(PAYER);

    expect(result.businessName).toBe('Known Co');
    expect(result.riskScore).toBe(4);
    expect(result.signals).toEqual(['fast']);
    expect(result.rawDetails?.matchedKnownEntity).toBe(true);
  });

  it('derives risk score and signal fallbacks for registered entities that omit them', async () => {
    const provider = new MockKYBProvider();
    provider.registerBusiness(PAYER, {
      isVerified: false,
      businessName: 'Shadow Co',
      registrationNumber: 'R-2',
      jurisdiction: 'US-NY',
    });

    const unverified = await provider.verifyPayer(PAYER);
    expect(unverified.riskScore).toBe(85);
    expect(unverified.signals).toEqual(['Unverified entity']);

    provider.registerBusiness(PAYER, {
      isVerified: true,
      businessName: 'Bright Co',
      registrationNumber: 'R-3',
      jurisdiction: 'US-NY',
    });
    const verified = await provider.verifyPayer(PAYER);
    expect(verified.riskScore).toBe(10);
    expect(verified.signals).toEqual([]);
  });
});
