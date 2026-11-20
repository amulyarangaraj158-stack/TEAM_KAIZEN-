import test from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import {
  isPrivateOrReservedIp,
  sanitizeArchiveEntryPath,
  safelyExtractZipBuffer,
  validateUrlSyntax,
} from './security';
import {
  analyzeProjectFiles,
  buildDependencyGraph,
  calculateProjectHealthScore,
  evaluatePatchConfidenceAndRisk,
} from './analyzer';
import { detectMagicFormat, scanProjectMediaReferences } from './multimediaDebugger';

test('SSRF protection blocks localhost, private IPs, metadata IPs, and non-HTTP protocols', () => {
  assert.equal(isPrivateOrReservedIp('127.0.0.1'), true);
  assert.equal(isPrivateOrReservedIp('10.0.1.5'), true);
  assert.equal(isPrivateOrReservedIp('172.16.0.1'), true);
  assert.equal(isPrivateOrReservedIp('192.168.1.10'), true);
  assert.equal(isPrivateOrReservedIp('169.254.169.254'), true);
  assert.equal(isPrivateOrReservedIp('::1'), true);
  assert.equal(isPrivateOrReservedIp('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateOrReservedIp('93.184.216.34'), false);

  assert.equal(validateUrlSyntax('http://localhost:3000').valid, false);
  assert.equal(validateUrlSyntax('http://127.0.0.1/admin').valid, false);
  assert.equal(validateUrlSyntax('http://169.254.169.254/latest/meta-data').valid, false);
  assert.equal(validateUrlSyntax('file:///etc/passwd').valid, false);
  assert.equal(validateUrlSyntax('https://user:pass@example.com').valid, false);
  assert.equal(validateUrlSyntax('https://example.com/health').valid, true);
});

test('Safe ZIP extraction prevents path traversal while extracting valid source files', () => {
  assert.equal(sanitizeArchiveEntryPath('../etc/passwd').safe, false);
  assert.equal(sanitizeArchiveEntryPath('/etc/shadow').safe, false);
  assert.equal(sanitizeArchiveEntryPath('src/app.ts').safe, true);

  const zip = new AdmZip();
  zip.addFile('src/index.ts', Buffer.from('export const ok = true;\n'));
  zip.addFile('escape.py', Buffer.from('print("nope")\n'));
  const entries = zip.getEntries();
  entries[1].entryName = '../../escape.py';
  const result = safelyExtractZipBuffer(zip.toBuffer());

  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].relativePath, 'src/index.ts');
  assert.equal(result.rejectedSecurityEntries.length, 1);
});

test('Multi-language static analyzer detects real TypeScript, Python, JSON, and SQL bugs', async () => {
  const issues = await analyzeProjectFiles([
    {
      relativePath: 'app.ts',
      content: `export function run(q: string, id: string) {\n  const sql = \`SELECT * FROM users WHERE id = \${id}\`;\n  return eval(q);\n}\n`,
    },
    {
      relativePath: 'calc.py',
      content: `def bad(items=[]):\n    x = 10 / 0\n    return items\n`,
    },
    {
      relativePath: 'broken.json',
      content: `{ "valid": true, }`,
    },
    {
      relativePath: 'wipe.sql',
      content: `DELETE FROM sessions;`,
    },
  ]);

  assert.ok(issues.some((i) => i.filePath === 'app.ts' && i.category === 'SQL Injection'));
  assert.ok(issues.some((i) => i.filePath === 'app.ts' && i.category === 'Security Vulnerability'));
  assert.ok(issues.some((i) => i.filePath === 'calc.py' && i.category === 'Logic Bug'));
  assert.ok(issues.some((i) => i.filePath === 'calc.py' && i.category === 'Runtime Crash'));
  assert.ok(issues.some((i) => i.filePath === 'broken.json' && i.category === 'Syntax Error'));
  assert.ok(issues.some((i) => i.filePath === 'wipe.sql' && i.category === 'Data Integrity Risk'));
});

test('Dependency graph extractor maps actual imports and computes impact scores', () => {
  const files = [
    { id: '1', relativePath: 'src/index.ts', language: 'TypeScript', content: `import { pay } from './billing';\nexport const start = () => pay();\n` },
    { id: '2', relativePath: 'src/billing.ts', language: 'TypeScript', content: `export function pay() { return 1; }\n` },
  ];
  const bugsByFile = new Map([['src/billing.ts', { count: 2, maxSeverity: 'critical' as const }]]);
  const graph = buildDependencyGraph(files, bugsByFile);

  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].sourceKey, 'src/index.ts');
  assert.equal(graph.edges[0].targetKey, 'src/billing.ts');

  const billingNode = graph.nodes.find((n) => n.filePath === 'src/billing.ts')!;
  assert.equal(billingNode.inDegree, 1);
  assert.ok(billingNode.impactScore > 50);
});

test('Smart Fix Confidence and Change Risk scoring differentiates safe vs high-risk patches', () => {
  const safeEval = evaluatePatchConfidenceAndRisk({
    filePath: 'src/utils/format.ts',
    language: 'TypeScript',
    bugCategory: 'Syntax Error',
    bugSeverity: 'low',
    originalCode: 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n',
    proposedCode: 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 5;\n',
    validationStatus: 'passed',
    validationDetails: 'Passed AST verification.',
    dependentFilesCount: 0,
    hasTestsInProject: true,
    hasAiRootCause: true,
  });

  const riskyEval = evaluatePatchConfidenceAndRisk({
    filePath: 'src/auth/paymentSecurity.ts',
    language: 'TypeScript',
    bugCategory: 'Logic Bug',
    bugSeverity: 'critical',
    originalCode: 'const x = 1;\n',
    proposedCode: 'const x = 2;\nconst y = 3;\n',
    validationStatus: 'failed',
    validationDetails: 'Syntax error.',
    dependentFilesCount: 5,
    hasTestsInProject: false,
    hasAiRootCause: false,
  });

  assert.ok(safeEval.confidenceScore > riskyEval.confidenceScore);
  assert.ok(riskyEval.riskScore > safeEval.riskScore);
  assert.equal(safeEval.riskLevel, 'Low');
  assert.equal(riskyEval.riskLevel, 'Critical');
  assert.equal(calculateProjectHealthScore([{ severity: 'critical', status: 'resolved' }]), 100);
  assert.ok(calculateProjectHealthScore([{ severity: 'critical', status: 'open' }]) < 90);
});

test('Multimedia magic byte detector and project broken media ref scanner work accurately', () => {
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const garbage = Buffer.from('not-a-real-video-file');
  assert.equal(detectMagicFormat(pngHeader).detected, 'png');
  assert.equal(detectMagicFormat(garbage).detected, 'unrecognized');

  const refs = scanProjectMediaReferences([
    { relativePath: 'index.html', content: '<img src="hero.png" /><video src="demo.mp4"></video>' },
    { relativePath: 'hero.png', content: '' },
  ]);
  assert.equal(refs.length, 2);
  assert.equal(refs.find((r) => r.referencedAsset === 'hero.png')?.status, 'present');
  assert.equal(refs.find((r) => r.referencedAsset === 'demo.mp4')?.status, 'missing');
});
