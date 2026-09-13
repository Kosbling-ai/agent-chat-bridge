import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export async function checkVersion(root = new URL('../', import.meta.url)) {
  const read = name => readFile(new URL(name, root), 'utf8');
  const [versionFile, packageText, lockText, changes, migrations, readme] = await Promise.all(
    ['VERSION','package.json','package-lock.json','CHANGELOG.md','MIGRATIONS.md','README.md'].map(read),
  );
  const version = versionFile.trim();
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('invalid_release_version');
  const pkg = JSON.parse(packageText), lock = JSON.parse(lockText);
  if ([pkg.version,lock.version,lock.packages?.['']?.version].some(value => value !== version)) throw new Error('release_version_mismatch');
  if (!changes.includes(`## [${version}]`) || !migrations.includes(`Application version: \`${version}\``)
      || !readme.includes(`Version: \`${version}\``)) throw new Error('release_notes_missing');
  if (pkg.private !== true) throw new Error('npm_publishing_not_authorized');
  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(`Version ${await checkVersion()} is consistent.`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
