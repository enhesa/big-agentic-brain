/**
 * Content checks for the file store (lib/files.ts): executables by name and by their bytes, and
 * secrets in text files. Every check reads only small, bounded parts of the staged file.
 */
import { inflateRawSync } from "node:zlib";
import { ValidationError } from "./errors";
import { redact } from "./redact";
import { readRange } from "./file-store";

/**
 * Extensions refused as executables, installers, scripts Windows runs on a double click, disk
 * images and shortcuts. Source code (.sh, .py, .js) is allowed: it is text.
 */
const EXECUTABLE_EXTENSIONS = new Set([
  // Windows programs, libraries and installers
  "exe", "dll", "sys", "scr", "com", "pif", "cpl", "ocx", "drv", "efi", "msi", "msp", "mst", "msu", "msix", "msixbundle", "appx", "appxbundle",
  "application", "appref-ms", "vsto", "xbap", "gadget", "xll", "xlam", "ppam",
  // Windows scripts and shortcuts that run on a double click
  "bat", "cmd", "ps1", "psm1", "psd1", "ps1xml", "psc1", "vb", "vbs", "vbe", "js_", "jse", "ws", "wsf", "wsc", "wsh", "hta", "sct",
  "lnk", "url", "scf", "library-ms", "searchconnector-ms", "settingcontent-ms", "inf", "reg", "chm", "hlp", "cab", "diagcab", "mof",
  // Office files with macros, and OneNote (a common carrier for scripts)
  "docm", "dotm", "xlsm", "xltm", "xlsb", "pptm", "potm", "ppsm", "sldm", "one", "onepkg",
  // Disk images that mount as a drive
  "iso", "img", "vhd", "vhdx", "udf",
  // Java, Android, Apple, Linux
  "jar", "jnlp", "class", "apk", "aab", "xapk", "ipa", "app", "dmg", "pkg", "mpkg", "command", "deb", "rpm", "elf", "so", "dylib", "bundle", "run", "appimage",
]);

/** First bytes of native programs: ELF, Mach-O (both byte orders, 32 and 64 bit), fat Mach-O or Java class. */
const EXECUTABLE_MAGIC: Buffer[] = [
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  Buffer.from([0xfe, 0xed, 0xfa, 0xce]),
  Buffer.from([0xfe, 0xed, 0xfa, 0xcf]),
  Buffer.from([0xce, 0xfa, 0xed, 0xfe]),
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
];

const EXECUTABLE_REFUSAL = "this looks like an executable program, and BAB does not store executables";

function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

/** Refuses executables by extension (from the name alone, so before any upload). */
export function assertNotExecutableName(name: string): void {
  const ext = extensionOf(name);
  if (EXECUTABLE_EXTENSIONS.has(ext)) throw new ValidationError(`.${ext} files are refused: BAB does not store executables`);
}

/**
 * True for a Windows program: "MZ", then at 0x3C the offset of a "PE\0\0" header. Plain text that
 * happens to start with "MZ" has no such header and is allowed.
 */
function isPortableExecutable(filePath: string, size: number, head: Buffer): boolean {
  if (head.length < 2 || head[0] !== 0x4d || head[1] !== 0x5a || size < 0x40) return false;
  const at = readRange(filePath, 0x3c, 4);
  if (at.length < 4) return false;
  const offset = at.readUInt32LE(0);
  if (offset < 0x40 || offset > size - 4) return false;
  return readRange(filePath, offset, 4).equals(Buffer.from([0x50, 0x45, 0, 0]));
}

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;
/** The central directory is read only up to this size; a bigger one is not inspected. */
const ZIP_CENTRAL_MAX = 4 * 1024 * 1024;
/** META-INF/MANIFEST.MF is read only up to this size, compressed and inflated. */
const ZIP_MANIFEST_MAX = 64 * 1024;

const PACKAGE_MANIFESTS = new Set(["androidmanifest.xml", "appxmanifest.xml", "appxmetadata/appxbundlemanifest.xml"]);

/**
 * The kind of program a zip file is, or null: an Android app (AndroidManifest.xml), a Windows app
 * package (AppxManifest.xml), or a runnable Java archive (META-INF/MANIFEST.MF with Main-Class).
 * Reads only the end of the file, the central directory and that one small entry, so bytes put in
 * front of the zip (a self-extracting stub) do not hide it. A manifest it cannot read counts as
 * runnable. A zip whose directory it cannot read at all (zip64, a directory over 4 MB) is not refused.
 * Every end-of-directory record in the last 64 KB is tried (at most ZIP_END_CANDIDATES), not only the
 * last one, so a fake record hidden in the zip comment cannot point the check at a harmless directory.
 */
function zipProgramKind(filePath: string, size: number): string | null {
  if (size < 22) return null;
  const tailLen = Math.min(size, 22 + 0xffff);
  const tail = readRange(filePath, size - tailLen, tailLen);
  let tried = 0;
  for (let i = tail.length - 22; i >= 0 && tried < ZIP_END_CANDIDATES; i--) {
    if (tail.readUInt32LE(i) !== ZIP_END) continue;
    tried += 1;
    let kind: string | null = null;
    try {
      kind = directoryProgramKind(filePath, size, tail, tailLen, i);
    } catch {
      kind = null;
    }
    if (kind) return kind;
  }
  return null;
}

const ZIP_END_CANDIDATES = 16;

/** zipProgramKind for one end-of-directory record at `end` in `tail`. */
function directoryProgramKind(filePath: string, size: number, tail: Buffer, tailLen: number, end: number): string | null {
  const cdSize = tail.readUInt32LE(end + 12);
  const cdOffset = tail.readUInt32LE(end + 16);
  if (cdSize === 0xffffffff || cdOffset === 0xffffffff || cdSize > ZIP_CENTRAL_MAX) return null;
  // Offsets in the directory count from the start of the zip; bytes in front of it shift them all.
  const cdStart = size - tailLen + end - cdSize;
  const shift = cdStart - cdOffset;
  if (cdStart < 0 || shift < 0) return null;
  const cd = readRange(filePath, cdStart, cdSize);
  for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === ZIP_CENTRAL; ) {
    const method = cd.readUInt16LE(p + 10);
    const compressed = cd.readUInt32LE(p + 20);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOffset = cd.readUInt32LE(p + 42) + shift;
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8").toLowerCase();
    if (PACKAGE_MANIFESTS.has(name)) return name.startsWith("android") ? "an Android app" : "a Windows app package";
    if (name === "meta-inf/manifest.mf") {
      // A real manifest is small and stored or deflated. Anything else (too big, another method, a
      // broken entry, or one that inflates past the cap) cannot be checked, so it counts as runnable.
      const unreadable = "a Java archive whose manifest BAB cannot check";
      if (compressed > ZIP_MANIFEST_MAX || (method !== 0 && method !== 8)) return unreadable;
      const local = readRange(filePath, localOffset, 30);
      if (local.length !== 30 || local.readUInt32LE(0) !== ZIP_LOCAL) return unreadable;
      const dataAt = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const raw = readRange(filePath, dataAt, compressed);
      let text: string;
      try {
        text = (method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: ZIP_MANIFEST_MAX * 4 })).toString("utf8");
      } catch {
        return unreadable;
      }
      if (/^Main-Class\s*:/im.test(text)) return "a runnable Java program";
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** Refuses executables by their bytes: the staged file at `filePath`, `size` bytes, starting with `head`. */
export function assertNotExecutableFile(filePath: string, size: number, head: Buffer): void {
  if (EXECUTABLE_MAGIC.some((m) => head.length >= m.length && head.subarray(0, m.length).equals(m))) throw new ValidationError(EXECUTABLE_REFUSAL);
  if (isPortableExecutable(filePath, size, head)) throw new ValidationError(EXECUTABLE_REFUSAL);
  // Every file, not only those starting with "PK": a zip read from its end may have bytes in front.
  let kind: string | null = null;
  try {
    kind = zipProgramKind(filePath, size);
  } catch {
    kind = null;
  }
  if (kind) throw new ValidationError(`this zip file is ${kind}, and BAB does not store executables`);
}

/** Text files up to this size are checked for secrets before they are stored. */
export const SECRET_SCAN_MAX_BYTES = 1024 * 1024;

const SECRET_KINDS: [string, string][] = [
  ["[redacted email]", "an email address outside your organisation"],
  ["[redacted phone]", "a phone number"],
  ["[redacted card]", "a payment card number"],
  ["[redacted iban]", "a bank account number (IBAN)"],
  ["[redacted id]", "a national ID number"],
  ["[redacted]", "a secret such as a password, token, key or connection string"],
];

function countOf(text: string, marker: string): number {
  let n = 0;
  for (let i = text.indexOf(marker); i >= 0; i = text.indexOf(marker, i + marker.length)) n += 1;
  return n;
}

/** What redact() would mask in this text, named as a kind (never the value), or null when nothing. */
export function sensitiveKind(text: string): string | null {
  const masked = redact(text);
  if (masked === text) return null;
  for (const [marker, kind] of SECRET_KINDS) {
    // "[redacted]" with its closing bracket is not part of the longer markers, so the counts stay separate.
    if (countOf(masked, marker) > countOf(text, marker)) return kind;
  }
  return "something BAB treats as confidential";
}

/**
 * The text of a UTF-8 file with no NUL bytes, else null (binary, or not valid UTF-8). Only the
 * text file checks use it.
 */
export function asUtf8Text(buf: Buffer): string | null {
  if (buf.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/** Refuses a text file that holds what redact() would mask. Binary files are not inspected. */
export function assertNoSecretsInText(buf: Buffer): void {
  const text = asUtf8Text(buf);
  if (text === null) return;
  const kind = sensitiveKind(text);
  if (kind) {
    throw new ValidationError(
      `This file holds ${kind}, and BAB does not store confidential data. Remove it from the file and upload again.`,
    );
  }
}
