import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { safeObserver } from '../../logger.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const fail = code => Object.assign(new Error(code), { code, outcome: 'failed' });
const images = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const fileTypes = { '.pdf': 'pdf', '.doc': 'doc', '.xls': 'xls', '.ppt': 'ppt', '.mp4': 'mp4', '.opus': 'opus' };
const inside = (root, path) => { const rel = relative(root, path); return rel && !rel.startsWith('../') && rel !== '..' && !isAbsolute(rel); };
const identity = scope => JSON.stringify([scope.connectionId, scope.conversationId, scope.runId]);
function validScope(scope) {
  if (!scope || ['connectionId', 'conversationId', 'runId'].some(key => typeof scope[key] !== 'string' || !scope[key] || scope[key].length > 255)) throw fail('invalid_artifact_scope');
}
function validName(name) {
  return typeof name === 'string' && name && name === basename(name) && name !== '.' && name !== '..'
    && !/[\\/\x00-\x1f]/.test(name) && Buffer.byteLength(name) <= 255;
}
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

// This protects against unsafe paths and detects changed artifacts; it is not a
// filesystem sandbox against another process with the same operating-system UID.
export async function createOutboundMedia({ workspace, outboxDir, spoolDir, chat,
  maxBytes = 28 * 1024 * 1024, maxTotalBytes = 512 * 1024 * 1024, log = () => {} }) {
  if (![workspace, outboxDir, spoolDir].every(value => typeof value === 'string' && isAbsolute(value))
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 28 * 1024 * 1024
      || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < maxBytes || maxTotalBytes > 1024 * 1024 * 1024
      || !chat?.uploadImage || !chat?.uploadFile || !chat?.sendMessage) throw fail('invalid_outbound_media_config');
  const base = await realpath(workspace);
  const sourceRoot = resolve(base, relative(resolve(workspace), resolve(outboxDir)));
  const spoolRoot = resolve(base, relative(resolve(workspace), resolve(spoolDir)));
  if (!inside(base, sourceRoot) || !inside(base, spoolRoot) || sourceRoot === spoolRoot
    || inside(sourceRoot, spoolRoot) || inside(spoolRoot, sourceRoot)) throw fail('invalid_artifact_directories');
  log = safeObserver(log);
  async function directory(path, create = false) {
    if (!inside(base, path)) throw fail('unsafe_artifact_directory');
    let current = base;
    for (const segment of relative(base, path).split('/')) {
      current = join(current, segment);
      if (create) await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o022)) throw fail('unsafe_artifact_directory');
    }
    if (await realpath(path) !== path) throw fail('unsafe_artifact_directory');
  }
  await directory(sourceRoot, true); await directory(spoolRoot, true);
  async function syncDirectory(path) {
    const handle = await open(path, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  const runDir = scope => join(spoolRoot, digest(identity(scope)));
  const chatDir = scope => join(sourceRoot, digest(JSON.stringify([scope.connectionId, scope.conversationId])));
  async function readBounded(path, limit) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid() || (before.mode & 0o022)) throw fail('unsafe_artifact_file');
      if (before.size > limit) throw fail('artifact_too_large');
      const chunks = []; let bytes = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
        bytes += chunk.length;
        if (bytes > limit) throw fail('artifact_too_large');
        chunks.push(chunk);
      }
      if (!sameFile(before, await handle.stat())) throw fail('artifact_changed');
      return { bytes: Buffer.concat(chunks), info: { dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs } };
    } finally { await handle.close(); }
  }
  async function load(scope) {
    validScope(scope);
    const dir = runDir(scope); await directory(dir);
    const { bytes } = await readBounded(join(dir, 'manifest.json'), 65536);
    const manifest = JSON.parse(bytes.toString('utf8'));
    if (manifest.version !== 1 || manifest.identity !== identity(scope) || !Array.isArray(manifest.artifacts) || manifest.artifacts.length > 9
      || manifest.artifacts.some(item => !/^[a-f0-9]{64}$/.test(item.artifactId) || !validName(item.fileName)
        || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > maxBytes
        || !['image', 'file'].includes(item.kind) || !['stream', 'pdf', 'doc', 'xls', 'ppt', 'mp4', 'opus'].includes(item.fileType))) {
      throw fail('invalid_artifact_manifest');
    }
    return manifest;
  }
  async function usage() {
    let total = 0, count = 0;
    for await (const entry of await opendir(spoolRoot)) {
      if (++count > 4096 || !/^[a-f0-9]{64}$/.test(entry.name)) throw fail('artifact_storage_limit');
      const dir = join(spoolRoot, entry.name); await directory(dir);
      for await (const file of await opendir(dir)) {
        if (++count > 4096) throw fail('artifact_storage_limit');
        const stat = await lstat(join(dir, file.name));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail('unsafe_artifact_file');
        total += stat.size;
      }
    }
    return total;
  }
  let queue = Promise.resolve();
  const exclusive = operation => { const next = queue.then(operation); queue = next.catch(() => {}); return next; };
  async function resolveRef(scope, ref) {
    validScope(scope);
    if (!ref || ref.runId !== scope.runId || ref.connectionId !== scope.connectionId || ref.conversationId !== scope.conversationId) throw fail('artifact_scope_mismatch');
    const manifest = await load(scope);
    const artifact = manifest.artifacts.find(item => item.artifactId === ref.artifactId);
    if (!artifact) throw fail('artifact_not_found');
    return artifact;
  }
  const reference = (scope, artifactId) => ({ connectionId: scope.connectionId, conversationId: scope.conversationId, runId: scope.runId, artifactId });
  function result(scope, manifest) {
    return { artifacts: manifest.artifacts.map(artifact => ({ ref: reference(scope, artifact.artifactId),
      kind: artifact.kind, fileType: artifact.fileType, fileName: artifact.fileName, size: artifact.size })),
    failures: manifest.failures ?? [], omitted: manifest.omitted ?? 0 };
  }
  return {
    async directory(scope) { validScope(scope); const path = chatDir(scope); await directory(path, true); return path; },
    prepare(scope) {
      return exclusive(async () => {
        validScope(scope);
        if (scope.conversationType !== 'p2p') return { artifacts: [], failures: [], omitted: 0 };
        if (!Number.isFinite(scope.sinceMs) || scope.sinceMs <= 0) throw fail('invalid_artifact_turn_time');
        const dir = runDir(scope);
        try { return result(scope, await load(scope)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const source = chatDir(scope); await directory(source, true); await directory(dir, true);
        let count = 0;
        const candidates = [];
        for await (const entry of await opendir(source)) {
          if (++count > 4096) throw fail('artifact_scan_limit');
          if (!entry.isFile() || !validName(entry.name)) continue;
          const info = await lstat(join(source, entry.name));
          if (info.mtimeMs >= scope.sinceMs - 1000) candidates.push({ name: entry.name, time: info.mtimeMs });
        }
        candidates.sort((a, b) => a.time - b.time || a.name.localeCompare(b.name));
        const selected = candidates.slice(-9), artifacts = [], failures = [];
        const omitted = Math.max(0, candidates.length - 9);
        let used = await usage();
        for (const item of selected) {
          try {
            const { bytes, info } = await readBounded(join(source, item.name), maxBytes);
            const sha256 = digest(bytes), artifactId = digest(JSON.stringify([identity(scope), item.name, sha256]));
            const path = join(dir, artifactId);
            if (used + bytes.length + 65536 > maxTotalBytes) throw fail('artifact_storage_full');
            // A pre-manifest crash may leave this content-addressed snapshot.
            try {
              const existing = await readBounded(path, maxBytes);
              if (digest(existing.bytes) !== sha256) throw fail('artifact_integrity_failed');
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
              const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
              try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
              used += bytes.length;
            }
            const extension = extname(item.name).toLowerCase();
            artifacts.push({ artifactId, fileName: item.name, size: bytes.length, sha256, source: info,
              kind: images.has(extension) ? 'image' : 'file', fileType: fileTypes[extension] || 'stream' });
          } catch (error) {
            const code = ['artifact_too_large', 'artifact_storage_full', 'artifact_changed', 'unsafe_artifact_file'].includes(error.code) ? error.code : 'artifact_snapshot_failed';
            failures.push({ fileName: item.name, code });
            log('error', 'artifact_prepare', 'failed', { code });
          }
        }
        const manifest = { version: 1, identity: identity(scope), artifacts, failures, omitted };
        const temporary = join(dir, `${randomUUID()}.part`);
        const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(JSON.stringify(manifest)); await handle.sync(); } finally { await handle.close(); }
        await directory(dir); await rename(temporary, join(dir, 'manifest.json'));
        await syncDirectory(dir); await syncDirectory(spoolRoot);
        return result(scope, manifest);
      });
    },
    async upload({ scope, ref }) {
      let artifact, bytes;
      try {
        artifact = await resolveRef(scope, ref);
        ({ bytes } = await readBounded(join(runDir(scope), artifact.artifactId), maxBytes));
        if (bytes.length !== artifact.size || digest(bytes) !== artifact.sha256) throw fail('artifact_integrity_failed');
      } catch (error) { throw error.outcome === 'failed' ? error : fail('artifact_unavailable'); }
      // One call only: an upload has no platform UUID and unknown is held by core.
      return artifact.kind === 'image' ? chat.uploadImage({ bytes })
        : chat.uploadFile({ bytes, fileName: artifact.fileName, fileType: artifact.fileType });
    },
    async send({ scope, ref, uploadResult, uuid }) {
      let artifact;
      try { artifact = await resolveRef(scope, ref); }
      catch (error) { throw error.outcome === 'failed' ? error : fail('artifact_unavailable'); }
      const key = artifact.kind === 'image' ? 'image_key' : 'file_key';
      if (typeof uploadResult?.[key] !== 'string' || !uploadResult[key] || uploadResult[key].length > 512) throw fail('invalid_artifact_upload_result');
      return chat.sendMessage({ conversationId: scope.conversationId, kind: artifact.kind, content: { [key]: uploadResult[key] }, uuid });
    },
    cleanup({ scope, ref, confirmedSent }) {
      return exclusive(async () => {
        if (confirmedSent !== true) throw fail('artifact_send_unconfirmed');
        const artifact = await resolveRef(scope, ref);
        const source = join(chatDir(scope), artifact.fileName);
        await directory(chatDir(scope));
        let sourceChanged = false;
        let removeSource = false;
        try {
          const current = await readBounded(source, maxBytes);
          if (sameFile(current.info, artifact.source) && digest(current.bytes) === artifact.sha256) removeSource = true;
          else sourceChanged = true;
        } catch (error) {
          if (['unsafe_artifact_file', 'artifact_too_large', 'artifact_changed', 'ELOOP'].includes(error.code)) sourceChanged = true;
          else if (error.code !== 'ENOENT') throw fail('artifact_cleanup_failed');
        }
        if (removeSource) await unlink(source).catch(error => { if (error.code !== 'ENOENT') throw fail('artifact_cleanup_failed'); });
        await directory(runDir(scope));
        await unlink(join(runDir(scope), artifact.artifactId)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        // Keep the small manifest for replay/audit. Do not rescan completed runs.
        if (sourceChanged) log('warning', 'artifact_cleanup', 'source_retained', { code: 'artifact_source_changed' });
        return { cleaned: true, sourceChanged };
      });
    },
  };
}
