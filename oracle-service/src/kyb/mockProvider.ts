import type { KYBVerificationResult, VerificationProvider } from '../types';

export interface MockKYBProviderOptions {
  name?: string;
  defaultVerified?: boolean;
  defaultJurisdiction?: string;
  unavailable?: boolean;
  unavailableError?: string;
  knownBusinesses?: Record<
    string,
    {
      isVerified: boolean;
      businessName: string;
      registrationNumber: string;
      jurisdiction: string;
      riskScore?: number;
      signals?: string[];
    }
  >;
}

/**
 * Reference / Mock KYB Verification Provider Adapter
 *
 * Implements the pluggable `VerificationProvider` interface to demonstrate external
 * business entity verification integration alongside in-house fraud heuristics.
 */
export class MockKYBProvider implements VerificationProvider {
  /**
   * Marks this adapter as a fixture. Production wiring refuses any provider
   * carrying this flag (issue #1234), so the marker travels with the instance
   * however it was constructed — including with a custom `name`.
   */
  public readonly isMock = true;
  public readonly name: string;
  private readonly defaultVerified: boolean;
  private readonly defaultJurisdiction: string;
  private unavailable: boolean;
  private unavailableError?: string;
  private readonly knownBusinesses: Map<
    string,
    {
      isVerified: boolean;
      businessName: string;
      registrationNumber: string;
      jurisdiction: string;
      riskScore?: number;
      signals?: string[];
    }
  >;

  constructor(options: MockKYBProviderOptions = {}) {
    this.name = options.name ?? 'MockKYBProvider';
    this.defaultVerified = options.defaultVerified ?? true;
    this.defaultJurisdiction = options.defaultJurisdiction ?? 'US-DE';
    this.unavailable = options.unavailable ?? false;
    this.unavailableError = options.unavailableError;
    this.knownBusinesses = new Map(Object.entries(options.knownBusinesses ?? {}));
  }

  public setUnavailable(unavailable: boolean, errorMessage?: string): void {
    this.unavailable = unavailable;
    if (errorMessage !== undefined) {
      this.unavailableError = errorMessage;
    }
  }

  public isUnavailable(): boolean {
    return this.unavailable;
  }

  public registerBusiness(
    payerAddress: string,
    details: {
      isVerified: boolean;
      businessName: string;
      registrationNumber: string;
      jurisdiction: string;
      riskScore?: number;
      signals?: string[];
    }
  ): void {
    this.knownBusinesses.set(payerAddress, details);
  }

  public async verifyPayer(
    payerAddress: string,
    metadata?: Record<string, unknown>
  ): Promise<KYBVerificationResult> {
    if (this.unavailable) {
      throw new Error(this.unavailableError ?? `KYB provider (${this.name}) is unavailable`);
    }

    const known = this.knownBusinesses.get(payerAddress);
    const verifiedAt = new Date().toISOString();

    if (known) {
      return {
        provider: this.name,
        isVerified: known.isVerified,
        businessName: known.businessName,
        registrationNumber: known.registrationNumber,
        jurisdiction: known.jurisdiction,
        riskScore: known.riskScore ?? (known.isVerified ? 10 : 85),
        verifiedAt,
        signals: known.signals ?? (known.isVerified ? [] : ['Unverified entity']),
        rawDetails: {
          matchedKnownEntity: true,
          metadata,
        },
      };
    }

    return {
      provider: this.name,
      isVerified: this.defaultVerified,
      businessName: metadata?.businessName
        ? String(metadata.businessName)
        : `Verified Entity (${payerAddress.slice(0, 8)})`,
      registrationNumber: `REG-${payerAddress.slice(0, 6).toUpperCase()}-2026`,
      jurisdiction: this.defaultJurisdiction,
      riskScore: this.defaultVerified ? 15 : 90,
      verifiedAt,
      signals: this.defaultVerified ? [] : ['Entity not found in official registry'],
      rawDetails: {
        matchedKnownEntity: false,
        metadata,
      },
    };
  }
}
