export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(";")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    const k = pair.slice(0, eqIdx).trim();
    const v = pair.slice(eqIdx + 1).trim();
    if (k) cookies[k] = v;
  }
  return cookies;
}
