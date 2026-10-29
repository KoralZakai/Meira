/**
 * Every value the app stores goes through EncryptedStorage (7.10). A raw
 * AsyncStorage import anywhere else would write plaintext again — silently.
 *
 *   npx tsx tests/run-no-raw-asyncstorage.ts
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '..');
const allowed = new Set([join(root, 'src/services/EncryptedStorage.ts')]);
const offenders: string[] = [];
function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') walk(p); continue; }
    if (!/\.(ts|tsx|js|jsx)$/.test(name) || allowed.has(p)) continue;
    if (/@react-native-async-storage\/async-storage/.test(readFileSync(p, 'utf8'))) offenders.push(p.slice(root.length + 1));
  }
}
walk(join(root, 'src'));
for (const f of ['App.tsx', 'index.ts']) {
  try { if (/async-storage/.test(readFileSync(join(root, f), 'utf8'))) offenders.push(f); } catch { /* absent */ }
}
if (offenders.length) {
  console.log(`✗ raw AsyncStorage outside EncryptedStorage:\n  ${offenders.join('\n  ')}`);
  process.exit(1);
}
console.log('✓ every store goes through EncryptedStorage');
