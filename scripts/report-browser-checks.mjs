import { existsSync, readFileSync, appendFileSync } from 'node:fs';
const path = 'artifacts/playwright/results.json';
if (!existsSync(path)) {
  console.log('::warning::Browser checks did not produce a JSON report. See the preceding step for startup errors.');
  process.exit(0);
}
const report = JSON.parse(readFileSync(path, 'utf8'));
const clean = text => String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '');
const failures = [];
function visit(suite) {
  for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
    if (test.status !== 'unexpected') continue;
    const errors = test.results.flatMap(result => result.errors ?? (result.error ? [result.error] : []));
    failures.push({ title: spec.title, message: errors.map(error => clean(error.message)).join('\n') });
  }
  for (const child of suite.suites ?? []) visit(child);
}
for (const suite of report.suites ?? []) visit(suite);
for (const error of report.errors ?? []) failures.push({ title: 'Browser test runner', message: clean(error.message) });
for (const failure of failures) {
  const message = `${failure.title}: ${failure.message}`.slice(0, 6000).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::error title=Browser check failed::${message}`);
}
const summary = `## Browser checks\n\nPassed: ${report.stats?.expected ?? 0}; failed: ${report.stats?.unexpected ?? 0}; flaky: ${report.stats?.flaky ?? 0}.\n\n` + failures.map(failure => `### ${failure.title}\n\n\`\`\`text\n${failure.message.slice(0, 10000)}\n\`\`\`\n`).join('\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(`Browser checks: ${report.stats?.expected ?? 0} passed, ${report.stats?.unexpected ?? 0} failed.`);
