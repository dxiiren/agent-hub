// Pre-push scan: fails if tracked files contain internal infra or secrets.
import { execFileSync } from 'node:child_process';

// Built from parts so this file does not match its own scan.
const pattern = [['192', '168'].join('\\.'), 'koll' + 'ect', 'akmal' + '@', 'credentials' + '\\.json', 'pass' + 'word=', 'tok' + 'en='].join('|');
try {
  const out = execFileSync('git', ['grep', '-nIiE', pattern, '--', '.', ':!.claude/settings.json', ':!CLAUDE.md', ':!.claude/skills/audit-skills/audit.py'], { encoding: 'utf8' });
  console.log(out);
  console.log('[FAIL] scan found matches above');
  process.exit(1);
} catch (e) {
  if (e.status === 1) { console.log('[OK] scan clean: no internal infra or secrets in tracked files'); process.exit(0); }
  throw e;
}
