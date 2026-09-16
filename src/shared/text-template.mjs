// Literal, single-pass substitution: values are never parsed as new templates.
export const formatText = (template, values) => template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (token, key) => Object.hasOwn(values, key) ? String(values[key]) : token);
export const escapeMarkdown = text => text.replace(/[\\`*_{}[\]()<>!#|~]/g, '\\$&');
