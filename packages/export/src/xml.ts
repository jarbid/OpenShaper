/** Escape text for an XML/HTML text node (`&`, `<`, `>`). */
export const escapeXml = (s: unknown): string =>
  String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
