import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, readdir, readFile, realpath, rename, rm, rmdir, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

export class MediaError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const digest = value => createHash('sha256').update(value).digest('hex');
const directoryName = runId => {
  if (typeof runId !== 'string' || !runId || runId.length > 255) throw new MediaError('invalid_media_run');
  return digest(runId);
};
const inside = (root, path) => { const rel = relative(root, path); return rel && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel); };

// This is a controlled workspace, not a sandbox against another process running
// as the same UID. Reject existing symlinks and never accept caller file paths.
export async function createMediaFiles({ workspace, inboxDir, maxTotalBytes }) {
  if (!isAbsolute(workspace || '') || !isAbsolute(inboxDir || '')) throw new MediaError('invalid_media_directory');
  const workspacePath = await realpath(workspace);
  if (!inside(resolve(workspace), resolve(inboxDir))) throw new MediaError('invalid_media_directory');
  const root = resolve(workspacePath, relative(resolve(workspace), resolve(inboxDir)));
  if (!inside(workspacePath, root)) throw new MediaError('invalid_media_directory');
  async function checkedDirectory(path, create = false) {
    const rel = relative(workspacePath, path);
    let cursor = workspacePath;
    for (const segment of rel.split('/')) {
      cursor = join(cursor, segment);
      if (create) await mkdir(cursor, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const info = await lstat(cursor);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & (cursor === root || inside(root, cursor) ? 0o077 : 0o022))) {
        throw new MediaError('unsafe_media_directory');
      }
    }
    if (await realpath(path) !== path) throw new MediaError('unsafe_media_directory');
  }
  await checkedDirectory(root, true);
  let queue = Promise.resolve();
  const exclusive = (task, signal) => {
    const pending = queue.then(() => {
      if (signal?.aborted) throw new MediaError('media_cancelled');
      return task();
    });
    queue = pending.catch(() => {});
    if (!signal) return pending;
    let abort;
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(new MediaError('media_cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    return Promise.race([pending, cancelled]).finally(() => signal.removeEventListener('abort', abort));
  };
  async function usage() {
    let total = 0, count = 0;
    for await (const entry of await opendir(root)) {
      const name = entry.name;
      if (++count > 2048) throw new MediaError('media_storage_limit');
      if (!/^[a-f0-9]{64}$/.test(name)) throw new MediaError('unexpected_media_entry');
      const dir = join(root, name);
      await checkedDirectory(dir);
      for (const file of await readdir(dir)) {
        if (++count > 2048) throw new MediaError('media_storage_limit');
        const info = await lstat(join(dir, file));
        if (!info.isFile() || info.isSymbolicLink()) throw new MediaError('unsafe_media_file');
        total += info.size;
      }
    }
    return total;
  }
  async function regular(path) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new MediaError('unsafe_media_file');
    return info;
  }
  return {
    async prepare({ runId, identity, resources, download, maxBytes, signal }) {
      return exclusive(async () => {
        await checkedDirectory(root);
        const dir = join(root, directoryName(runId));
        await checkedDirectory(dir, true);
        const manifestPath = join(dir, 'manifest.json');
        let manifest;
        try {
          const info = await regular(manifestPath);
          if (info.size > 65536) throw new MediaError('invalid_media_manifest');
          manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (manifest) {
          if (manifest.identity !== identity || !Array.isArray(manifest.files) || manifest.files.length !== resources.length) throw new MediaError('media_run_conflict');
          for (const file of manifest.files) {
            if (!/^[a-f0-9]{64}\.[a-z]+$/.test(file.name)) throw new MediaError('invalid_media_manifest');
            const path = join(dir, file.name);
            const info = await regular(path);
            if (info.size > maxBytes || info.size !== file.bytes || digest(await readFile(path)) !== file.sha256) throw new MediaError('media_integrity_failed');
          }
          return manifest.files.map(file => join(dir, file.name));
        }
        let used = await usage();
        const created = [];
        const files = [];
        let partial;
        try {
          for (const key of resources) {
            if (signal?.aborted) throw new MediaError('media_cancelled');
            const { stream, extension } = await download(key);
            const name = `${digest(key)}${extension}`;
            const finalPath = join(dir, name);
            let handle;
            let bytes = 0;
            const hash = createHash('sha256');
            const abort = () => stream.destroy(new MediaError('media_cancelled'));
            // A cancellation may happen between download resolution and listener
            // registration. Attach first, then check, and always destroy the stream.
            stream.on('error', () => {});
            signal?.addEventListener('abort', abort, { once: true });
            try {
              if (signal?.aborted) throw new MediaError('media_cancelled');
              // Preserve any prior complete resource without a committed manifest.
              try { await lstat(finalPath); throw new MediaError('media_incomplete_recovery'); }
              catch (error) { if (error.code !== 'ENOENT') throw error; }
              partial = join(dir, `${digest(key)}.${randomUUID()}.part`);
              handle = await open(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
              if (signal?.aborted) throw new MediaError('media_cancelled');
              for await (const chunk of stream) {
                bytes += chunk.length;
                if (bytes > maxBytes) throw new MediaError('media_too_large');
                if (used + bytes > maxTotalBytes) throw new MediaError('media_storage_full');
                hash.update(chunk);
                await handle.writeFile(chunk);
              }
              if (signal?.aborted) throw new MediaError('media_cancelled');
              if (!bytes) throw new MediaError('media_empty');
              await handle.sync();
            } finally {
              signal?.removeEventListener('abort', abort);
              stream.destroy();
              if (handle) await handle.close();
            }
            await checkedDirectory(dir);
            if (signal?.aborted) throw new MediaError('media_cancelled');
            await rename(partial, finalPath);
            partial = undefined;
            created.push(finalPath);
            used += bytes;
            files.push({ name, bytes, sha256: hash.digest('hex') });
          }
          if (signal?.aborted) throw new MediaError('media_cancelled');
          const encoded = JSON.stringify({ version: 1, identity, files });
          if (used + Buffer.byteLength(encoded) > maxTotalBytes) throw new MediaError('media_storage_full');
          partial = join(dir, `${randomUUID()}.part`);
          const handle = await open(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await handle.writeFile(encoded); await handle.sync(); } finally { await handle.close(); }
          await checkedDirectory(dir);
          if (signal?.aborted) throw new MediaError('media_cancelled');
          await rename(partial, manifestPath);
          partial = undefined;
          return files.map(file => join(dir, file.name));
        } catch (error) {
          if (partial) await unlink(partial).catch(() => {});
          for (const path of created) await unlink(path).catch(() => {});
          await rmdir(dir).catch(() => {}); // Only an empty directory; never removes retained resources.
          throw error;
        }
      }, signal);
    },
    release(runId) {
      return exclusive(async () => {
        await checkedDirectory(root);
        const dir = join(root, directoryName(runId));
        try { await checkedDirectory(dir); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
        // Validate every entry before recursive removal. No symlink traversal.
        for (const file of await readdir(dir)) await regular(join(dir, file));
        await rm(dir, { recursive: true });
      });
    },
  };
}
