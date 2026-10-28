import type { FileRow } from "./files";

/** RFC 5987 value: percent-encode everything but the attr-chars, including ' ( ) * ! which encodeURIComponent leaves. */
function rfc5987(value: string): string {
  const wellFormed = (value as string & { toWellFormed(): string }).toWellFormed();
  return encodeURIComponent(wellFormed).replace(/['()*!]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Headers for every file download. The bytes are always served as an opaque attachment: never
 * rendered by the browser, never sniffed, never cached, and sandboxed even if something tries to
 * open them inline. The name only appears in Content-Disposition, encoded (RFC 6266 / 5987).
 */
export function downloadHeaders(file: FileRow): Headers {
  const ascii = file.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\;]/g, "_");
  return new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Length": String(file.size),
    "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${rfc5987(file.name)}`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Bab-File-Id": file.id,
    "X-Bab-File-Sha256": file.sha256,
  });
}
