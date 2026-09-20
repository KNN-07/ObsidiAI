/** Validate a visible, vault-relative path without normalizing away unsafe input. */
export function validateVaultPath(path: string, configDir: string): string {
  if (typeof path !== 'string' || !path || /[\\\0]/.test(path) || path.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(path)) {
    throw new Error('Use a visible vault-relative slash-separated path.');
  }
  const segments = path.split('/');
  if (segments.some(segment => !segment || segment.startsWith('.') || segment.includes(':'))) {
    throw new Error('Hidden, empty, traversal, and URI path segments are not allowed.');
  }
  const config = configDir.replace(/^\/+|\/+$/g, '');
  if (config && (path === config || path.startsWith(`${config}/`))) {
    throw new Error('The vault configuration folder is not accessible.');
  }
  return path;
}
