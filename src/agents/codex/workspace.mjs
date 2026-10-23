import { stat } from 'node:fs/promises';

// One rule for the global Codex cwd and every per-group cwd: an existing
// directory owned by the bridge user and not writable by others. Returns an
// empty string when the directory is usable, otherwise a fixed reason code;
// the path itself is never reported.
export async function checkCodexWorkspace(path) {
  let info;
  try { info = await stat(path); }
  catch (error) { return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'missing' : 'unreadable'; }
  if (!info.isDirectory()) return 'not_directory';
  if (info.mode & 0o002) return 'world_writable';
  if (process.getuid && info.uid !== process.getuid()) return 'not_owned';
  return '';
}

// Startup and check-config preflight for routing.groups[].codex.cwd.
export async function checkGroupCodexWorkspaces(groups = []) {
  const problems = [];
  for (const group of groups) {
    if (!group?.codex?.cwd) continue;
    const reason = await checkCodexWorkspace(group.codex.cwd);
    if (reason) problems.push({ chatId: group.conversationId, reason });
  }
  return problems;
}
