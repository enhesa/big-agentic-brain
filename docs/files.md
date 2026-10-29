# Files

BAB stores files so agents, your other machines and colleagues can pass them to each other with the BAB identity they already have. No cloud login, no shared drive.

## What not to upload

Never confidential data: no customer data, database dumps, credentials, secrets or personal data. BAB is shared company infrastructure, and a file can be opened to the whole organisation. The rule is in the tool description and the served skill too.

BAB checks text files up to 1 MB (UTF-8, no NUL bytes) with the same redaction rules as memories and messages. A file that holds a password, token, key, connection string, an outside email address, a phone, card, bank account or national ID number is refused. The answer names the kind of thing found, never the value. Bigger text files, other encodings (such as UTF-16), binary files and archives are not inspected, so this catches mistakes, not someone set on getting a secret past it.

## Limits

| Limit | Default | Setting |
| --- | --- | --- |
| Size of one file | 25 MB | `BAB_FILES_MAX_FILE_BYTES` (at most 50 MB, and at most the per-person total) |
| Total per person | 100 MB | `BAB_FILES_USER_QUOTA_BYTES` |
| Expiry | 14 days | `BAB_FILES_DEFAULT_EXPIRY_DAYS` |
| Longest expiry | 30 days | `BAB_FILES_MAX_EXPIRY_DAYS` |
| Disk guard, percentage | refuse uploads above 85% full | `BAB_FILES_DISK_FULL_PERCENT` |
| Disk guard, free space | keep twice the database size plus 64 MB free | `BAB_FILES_DISK_RESERVE_BYTES` |
| Time for one upload | 5 minutes | `BAB_FILES_UPLOAD_DEADLINE_SECONDS` (10 seconds to 30 minutes) |
| Uploads at once | 2 per person, 3 per client address, 6 in all | fixed |
| Inline `put` with `bab_files` | 256 KB | fixed (an MCP call is limited to 1 MB; bigger files use an upload link) |
| Upload link | one upload within 15 minutes, at most 20 unused per person | fixed |
| Switch | on | `BAB_FILES` |

- The total per person counts every file whose bytes are still on disk. A deleted file frees its space at once. An expired file frees its space when its bytes are removed: at the start of the next upload, or by the hourly maintenance.
- The disk guard counts every upload in progress at the full per-file size, also one sent without a `Content-Length`, because its bytes are not on disk yet. It checks again every 4 MB while an upload streams and drops the upload when the disk fills. The free-space floor keeps room for SQLite to grow and for the daily snapshot (`VACUUM INTO`, about the size of the database).
- An upload that sends nothing for 30 seconds, or is still running after the deadline, is dropped and its partial bytes deleted. The per-address cap needs `BAB_CLIENT_IP_HEADER`; without it the address is not verified and only the per-person and total caps apply.
- A refused upload says why: 413 for a file over the size limit, 507 for a full quota (with the bytes used and remaining) or a full disk, 400 for an executable, a secret, a stall or a timeout, 429 for too many uploads at once.
- Executables are refused, by extension and by their bytes:
  - Extensions: Windows programs and installers (`.exe`, `.dll`, `.msi`, `.msix`, `.application`, `.appref-ms`), scripts and shortcuts Windows runs on a double click (`.bat`, `.cmd`, `.ps1`, `.vbs`, `.hta`, `.lnk`, `.url`, `.scf`, `.library-ms`, `.chm`), Office files with macros (`.docm`, `.xlsm`, `.xlam`), OneNote (`.one`), disk images (`.iso`, `.img`, `.vhd`, `.vhdx`), Java, Android and Apple packages (`.jar`, `.apk`, `.ipa`, `.dmg`, `.pkg`), Linux packages and libraries (`.deb`, `.rpm`, `.so`), and similar.
  - Bytes: Windows programs (an `MZ` header that points to a `PE` header; plain text that starts with "MZ" is fine), Linux and macOS programs, Java classes.
  - Zip files: BAB reads the zip's table of contents from the end of the file, so bytes put in front of a zip do not hide it. It refuses Android apps (`AndroidManifest.xml`), Windows app packages (`AppxManifest.xml`) and runnable Java programs (`META-INF/MANIFEST.MF` with `Main-Class`, or a manifest it cannot read). It does not unpack anything else, so other files inside an archive are not inspected. A zip64 file or a table of contents over 4 MB is not inspected. A zip with more than 16 end-of-directory records in its last 64 KB is refused.
  - Source code such as `.sh`, `.py` or `.js` is text and is allowed.

## Who sees what

- A file belongs to whoever uploaded it. Only the owner deletes it, shares it or changes its expiry.
- Nobody else sees it until the owner shares it with named people (`shareWith`) or with everyone (`orgVisible`). Agents set `orgVisible` only with the user's yes.
- A file someone may not see answers "not found", so ids cannot be probed.

### Identity

The file store serves only a caller whose identity BAB remembers or checks:

- a device the BAB plugin set up (`X-Bab-Device`, bound with `bab_identify`),
- the sign-in proxy (`BAB_TRUST_PROXY_IDENTITY`),
- an API token bound to that person (`BAB_API_TOKENS` entry `token=email`).

A caller identified only by `X-Bab-Actor-*` headers, or by `bab_identify` on an MCP connection with no device, gets 403 on every files route and `bab_files` action. Those can name anyone, and a file store must not let anyone read, share or delete another person's files just by sending a header. `BAB_FILES_ALLOW_DECLARED=1` lifts this for local development only; BAB warns at startup when it is on.

A device is still the person's own word, remembered: `bab_identify` binds a new device secret to the address it is given, and can rebind a device that was someone else's (audited as `device-rebind`). A device is not proof of who someone is. The rule above stops header spoofing, not a caller who identifies as someone else on purpose. To make that visible, when a new device is connected as a person who already has another device or a linked browser (or a device they had forgotten comes back), each of that person's sessions is told once, with the time, and pointed at `/me/devices`, where the device's name is shown and it can be forgotten. The notice stops once the device is forgotten, and after 7 days. The first device of someone with nothing else cannot be noticed this way, and a person who does not run the plugin's hooks does not hear it. Where that matters, put BAB behind the sign-in proxy or give people tokens bound to them (see [Operating BAB](operations.md), trust model).

## How an agent uses it

With the plugin or any MCP client, the `bab_files` tool:

- `put`: `name` and `content` (text) or `contentBase64`. At most 256 KB, because an MCP call is limited to 1 MB and text grows when it is escaped. `to` shares the file with that person and sends them a BAB message with its id and name; your own id reaches your other machine. `subject` and `note` go into that message.
- `upload_link`: for bigger files. Takes `name` and the same options as `put` (`to`, `shareWith`, `orgVisible`, `expiresInDays`, `subject`, `note`) and returns a `url`. Send the file to it with `curl -X POST --data-binary @file "<url>"`. The link works for one upload within 15 minutes and carries everything about the file, so the curl call needs no identity and no headers. Query parameters on the link are ignored. A refused upload (too big, quota, disk, executable, secret) spends the link: make a new one.
- `list`: your files, the files shared with you, and your usage (used and quota).
- `get`: the details, a download link that works for an hour without identity, and the text inline for a small text file. Each `get` makes a new link.
- `share`: `shareWith`, `unshare`, `orgVisible`, `expiresInDays`.
- `delete`: owner only.

The tool description shows the limits of the BAB it is connected to.

Bigger files and downloads with curl, with no credential on the command line:

```bash
# bab_files action=upload_link name=sweep.tar.gz to=first.last@example.com  ->  { "url": ... }
curl -X POST --data-binary @sweep.tar.gz "https://bab.example.com/api/files/up/<token>"
# bab_files action=get id=<id>  ->  { "download": { "url": ... } }
curl -fo sweep.tar.gz "https://bab.example.com/api/files/dl/<token>"
```

Agents use the links above. A program that already keeps a token bound to a person in its own configuration can call `POST /api/files?name=...` and `GET /api/files/<id>/content` with it. Never type a device secret or a token into a command line.

Every answer carries the file's `sha256`; the content route sends it as `X-Bab-File-Sha256`. Check it after a download.

**Many small files:** bundle them into one tar or zip first. One upload is one call; a thousand files are a thousand calls. BAB does not unpack archives.

## Download links

A link is `https://bab.example.com/api/files/dl/<token>`: 256 random bits, valid for an hour and only while its maker may still see the file. Anyone holding it can fetch the file in that hour. BAB stores only the sha256 of the token and never writes the token to its log or an audit row. The token is part of the URL path, though, so a reverse proxy, load balancer or access log in front of BAB may record it. Treat a link like the file itself, and keep such logs as private as the data volume. The audit row of a link fetch names the link's maker and the verified client address (`BAB_CLIENT_IP_HEADER`), the same address the rate limit uses.

## Upload links

An upload link is `https://bab.example.com/api/files/up/<token>`: 256 random bits, one upload, 15 minutes. BAB stores only the sha256 of the token and marks it used before it reads the body, so two uploads to one link cannot both succeed. The link belongs to the person who made it; whoever holds it can upload one file into that person's store in those 15 minutes, with every limit and check above. A link made before a device is forgotten still works until it expires. Like a download link, the token is in the URL path, so a reverse proxy in front of BAB may log it. The audit log records who made the link, its use and the verified client address.

## Storage and backup

The bytes live on BAB's data volume under `DATA_DIR/files`, named by a random id, never by the uploaded name. An upload streams to `DATA_DIR/files/tmp` and moves into place when it is complete and checked, so a backup never sees half a file under a final name. The bytes move into place before the row is written: a crash in between leaves bytes with no row, which the hourly maintenance deletes after an hour. The same maintenance marks a row whose bytes are missing as deleted, so it stops counting towards the quota: at most 100 a run, and none when every stored file is missing at once, which points at a volume that is not mounted (BAB logs a warning instead). Rows in SQLite (`files`, `file_shares`, `file_links`) hold the name, owner, size, checksum, expiry and shares. Anything that backs up the data volume backs up the files; plan its size for the per-person total times the number of people who upload.

Restore `bab.db` and `files/` from the same moment. A database older than the files makes the newer bytes orphans, which maintenance deletes after an hour: files uploaded after the database snapshot are lost. A `files/` folder older than the database leaves rows without bytes, which maintenance marks as lost.

Every put, fetch, share, expiry, loss and delete writes an audit row.

Maintainers see the volume's size and use, the files on disk and the biggest users on `/admin`.
