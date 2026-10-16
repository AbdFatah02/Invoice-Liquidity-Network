#!/usr/bin/env node

const fs = require('node:fs');
const crypto = require('node:crypto');

const POLICY = Object.freeze({
  critical: { slaHours: 4, blockRelease: true, pageOnCall: true, fileIssue: true },
  high: { slaHours: 24, blockRelease: true, pageOnCall: false, fileIssue: true },
  moderate: { slaHours: 168, blockRelease: false, pageOnCall: false, fileIssue: false },
  low: { slaHours: 720, blockRelease: false, pageOnCall: false, fileIssue: false },
});

function normalizeFindings(report) {
  if (
    !report ||
    (typeof report.vulnerabilities !== 'object' && typeof report.advisories !== 'object')
  ) {
    throw new Error('Invalid dependency audit report: vulnerability data is missing');
  }
  if (report.advisories) {
    return Object.values(report.advisories).map((advisory) => ({
      dependency: advisory.module_name,
      title: advisory.title,
      severity: String(advisory.severity ?? 'low').toLowerCase(),
      url: advisory.url ?? null,
      range: advisory.vulnerable_versions ?? null,
    }));
  }
  return Object.entries(report.vulnerabilities).flatMap(([dependency, value]) => {
    const via = Array.isArray(value.via) ? value.via : [];
    const advisories = via.filter((item) => item && typeof item === 'object');
    if (advisories.length === 0 && value.severity) {
      advisories.push({
        title: `${dependency} dependency vulnerability`,
        severity: value.severity,
      });
    }
    return advisories.map((advisory) => ({
      dependency,
      title: advisory.title ?? advisory.name ?? 'Dependency vulnerability',
      severity: String(advisory.severity ?? value.severity ?? 'low').toLowerCase(),
      url: advisory.url ?? null,
      range: value.range ?? null,
    }));
  });
}

function triage(report) {
  return normalizeFindings(report).map((finding) => ({
    ...finding,
    policy: POLICY[finding.severity] ?? POLICY.low,
    fingerprint: crypto
      .createHash('sha256')
      .update(`${finding.dependency}:${finding.title}:${finding.url ?? ''}`)
      .digest('hex')
      .slice(0, 16),
  }));
}

async function githubRequest(path, options = {}) {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token || !repository) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required');
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

async function fileTrackedIssue(severity, findings) {
  const marker = `<!-- dependency-audit:${severity} -->`;
  const existing = await githubRequest('/issues?state=open&per_page=100');
  const tracked = existing.find((issue) => issue.body?.includes(marker));
  const policy = findings[0].policy;
  const deadline = new Date(Date.now() + policy.slaHours * 3_600_000).toISOString();
  const list = findings
    .map(
      (finding) =>
        `- [ ] **${finding.dependency}**: ${finding.title} (${finding.range ?? 'unknown range'})${
          finding.url ? ` — ${finding.url}` : ''
        }`
    )
    .join('\n');
  const payload = {
    title: `[${severity.toUpperCase()}] Remediate dependency-audit findings`,
    body: `${marker}\nAutomated dependency audit escalation.\n\n- Findings: ${findings.length}\n- Remediation SLA: ${policy.slaHours} hours\n- Deadline: ${deadline}\n\n${list}\n`,
  };
  await githubRequest(tracked ? `/issues/${tracked.number}` : '/issues', {
    method: tracked ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function pageOnCall(findings) {
  if (findings.length === 0) return;
  if (!process.env.SECURITY_PAGER_WEBHOOK) {
    throw new Error('SECURITY_PAGER_WEBHOOK is required for critical dependency escalation');
  }
  const response = await fetch(process.env.SECURITY_PAGER_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'critical_dependency_vulnerability', findings }),
  });
  if (!response.ok) throw new Error(`Pager returned ${response.status}`);
}

async function escalate(report) {
  const findings = triage(report);
  const groups = new Map();
  for (const finding of findings.filter((item) => item.policy.fileIssue)) {
    groups.set(finding.severity, [...(groups.get(finding.severity) ?? []), finding]);
  }
  for (const [severity, group] of groups) {
    await fileTrackedIssue(severity, group);
  }
  await pageOnCall(findings.filter((item) => item.policy.pageOnCall));
  return { findings, releaseBlocked: findings.some((item) => item.policy.blockRelease) };
}

async function main() {
  const reportPath = process.argv[2];
  if (!reportPath) throw new Error('Usage: dependency-audit-escalation.js <npm-audit-report.json>');
  const result = await escalate(JSON.parse(fs.readFileSync(reportPath, 'utf8')));
  console.log(JSON.stringify(result, null, 2));
  if (result.releaseBlocked) process.exitCode = 1;
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exit(2);
  });

module.exports = { POLICY, normalizeFindings, triage, escalate };
