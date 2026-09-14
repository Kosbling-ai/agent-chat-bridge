import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromMarkdown } from 'mdast-util-from-markdown';

function images(markdown) {
  const found = []; const stack = [fromMarkdown(String(markdown || ''))];
  while (stack.length) {
    const node = stack.pop();
    if (node?.type === 'image' && Number.isSafeInteger(node.position?.start?.offset) && Number.isSafeInteger(node.position?.end?.offset)) {
      found.push({ start: node.position.start.offset, end: node.position.end.offset, alt: node.alt || '', destination: node.url || '' });
    }
    if (Array.isArray(node?.children)) stack.push(...node.children);
  }
  return found.sort((a, b) => a.start - b.start);
}

function localPath(destination, workspace) {
  const value = String(destination || '').trim();
  if (!value || value.startsWith('//') || (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^file:/i.test(value))) return '';
  try {
    if (/^file:/i.test(value)) return resolve(fileURLToPath(value));
    if (isAbsolute(value)) return resolve(value);
    return workspace ? resolve(workspace, value) : value;
  } catch { return ''; }
}

function collectedPaths(attachments) {
  return new Set((attachments || []).filter(value => typeof value === 'string' && value).map(value => resolve(value)));
}

export function adaptLocalMarkdownImages(markdown, attachments = [], { workspace } = {}) {
  const text = String(markdown || ''); const collected = collectedPaths(attachments); let output = text;
  for (const image of images(text).reverse()) {
    const path = localPath(image.destination, workspace);
    if (!path) continue;
    const label = image.alt.trim();
    const replacement = collected.has(path) ? label || '图片' : label ? `图片“${label}”未能发送。` : '图片未能发送。';
    output = output.slice(0, image.start) + replacement + output.slice(image.end);
  }
  return output;
}

export function referencedCollectedLocalImages(markdown, attachments = [], { workspace } = {}) {
  const collected = collectedPaths(attachments); const referenced = new Set();
  for (const image of images(markdown)) {
    const path = localPath(image.destination, workspace);
    if (path && collected.has(path)) referenced.add(path);
  }
  return referenced;
}
