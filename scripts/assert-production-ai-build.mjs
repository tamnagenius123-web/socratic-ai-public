import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const viteEnvironmentFiles = ['.env', '.env.local', '.env.production', '.env.production.local'];

function enablesLocalHarness(contents) {
  return contents.split(/\r?\n/).some((line) => {
    const match = /^\s*(?:export\s+)?VITE_LOCAL_E2E_HARNESS\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) return false;
    const value = match[1].replace(/^(['"])(.*)\1$/, '$2');
    return value === '1';
  });
}

const enabledByViteFile = viteEnvironmentFiles.some((name) => {
  const path = resolve(repositoryRoot, name);
  return existsSync(path) && enablesLocalHarness(readFileSync(path, 'utf8'));
});

if (process.env.VITE_LOCAL_E2E_HARNESS === '1' || enabledByViteFile) {
  process.stderr.write('Production deployment is disabled while VITE_LOCAL_E2E_HARNESS=1.\n');
  process.exit(1);
}
