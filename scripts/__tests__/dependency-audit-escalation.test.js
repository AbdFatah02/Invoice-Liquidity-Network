const test = require('node:test');
const assert = require('node:assert/strict');
const { POLICY, normalizeFindings, triage } = require('../dependency-audit-escalation.js');

const report = {
  vulnerabilities: {
    dangerous: {
      severity: 'critical',
      range: '<2.0.0',
      via: [{ title: 'RCE', severity: 'critical', url: 'https://example.test/1' }],
    },
    risky: { severity: 'high', range: '<3.0.0', via: [{ title: 'SSRF', severity: 'high' }] },
    transitive: { severity: 'moderate', range: '*', via: ['risky'] },
  },
};

test('normalizes only concrete advisories', () => {
  const findings = normalizeFindings(report);
  assert.equal(findings.length, 3);
  assert.equal(findings[0].dependency, 'dangerous');
});

test('critical and high findings block releases with explicit SLAs', () => {
  const findings = triage(report);
  assert.equal(findings.find((f) => f.severity === 'critical').policy.pageOnCall, true);
  assert.equal(findings.find((f) => f.severity === 'high').policy.slaHours, 24);
  assert.equal(POLICY.moderate.blockRelease, false);
  assert.match(findings[0].fingerprint, /^[a-f0-9]{16}$/);
});

test('normalizes pnpm advisory reports used by CI', () => {
  const findings = normalizeFindings({
    advisories: {
      42: {
        module_name: 'parser',
        title: 'Prototype pollution',
        severity: 'high',
        vulnerable_versions: '<2',
        url: 'https://example.test/42',
      },
    },
  });
  assert.deepEqual(findings, [
    {
      dependency: 'parser',
      title: 'Prototype pollution',
      severity: 'high',
      url: 'https://example.test/42',
      range: '<2',
    },
  ]);
});
