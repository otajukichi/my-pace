import { copyFile, lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPublicFiles, PROJECT_ROOT } from './serve.mjs';

const REQUIRED = ['index.html', 'app.js', 'styles.css'];
export const LOCAL_BUILD_NOTICE = `PRIVATE LOCAL BUILD / 個人用ローカルビルド

This directory contains real, private running records and GPS routes.
Do not publish, deploy, upload, or share this directory as a public website.
Keep it on your own computer. Review and remove personal data before any future publication.

このフォルダには実際のランニング記録・GPS位置情報が含まれます。
公開・デプロイ・アップロードせず、自分の端末内だけで利用してください。
将来公開する場合は、個人データの除去と内容の確認が必要です。

This build contains only the new app's allowlisted public files.
Archived code, Google integration settings, credentials, tests, and documentation are excluded.
Run npm start from the project root for the private local preview.
`;

/** Copy the new app only. No network, bundler, install step, or deployment. */
export async function build({ root = PROJECT_ROOT, publicBuild = false } = {}) {
  const projectRoot = resolve(root);
  const output = join(projectRoot, 'dist');
  const files = (await listPublicFiles({ root: projectRoot }))
    .filter(file => !publicBuild || file.relativePath !== 'data/running.json');
  const present = new Set(files.map(file => file.relativePath));
  const missing = REQUIRED.filter(file => !present.has(file));
  if (missing.length) throw new Error('Build requires: ' + missing.join(', '));
  const privateData = present.has('data/running.json');
  // Do not replace a user-provided symlink or non-directory at dist.
  try {
    const stat = await lstat(output);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('dist must be a regular directory.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const staging = await mkdtemp(join(projectRoot, '.my-pace-build-'));
  try {
    for (const file of files) {
      const target = join(staging, file.relativePath);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(file.filePath, target);
    }
    if (!privateData) {
      await mkdir(join(staging, 'data'), { recursive: true });
      await writeFile(join(staging, 'data/running.json'), JSON.stringify({ days: [] }) + '\n', 'utf8');
    }
    if (privateData) await writeFile(join(staging, 'README-LOCAL.txt'), LOCAL_BUILD_NOTICE, 'utf8');
    // The existing build remains intact until every source file has copied successfully.
    await rm(output, { recursive: true, force: true });
    await rename(staging, output);
    return { output, privateData, files: [...new Set([...files.map(file => file.relativePath), 'data/running.json'])].sort() };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await build({ publicBuild: process.argv.includes('--public') });
    console.log(`Built ${result.files.length} public files into dist/.`);
    console.log(result.privateData
      ? 'LOCAL ONLY: dist includes private running records and GPS routes. Do not publish it.'
      : 'Empty running records. Private GPS is excluded from this build.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
