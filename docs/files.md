# Files

BAB stores files so agents, your other machines and colleagues can pass them to each other with the BAB identity they already have. No cloud login, no shared drive.

## What not to upload

Never confidential data: no customer data, database dumps, credentials, secrets or personal data. BAB is shared company infrastructure, and a file can be opened to the whole organisation. The rule is in the tool description and the served skill too.

BAB checks text files up to 1 MB (UTF-8, no NUL bytes) with the same redaction rules as memories and messages. A file that holds a password, token, key, connection string, an outside email address, a phone, card, bank account or national ID number is refused. The answer names the kind of thing found, never the value. Binary files and archives are not inspected.

## Limits

| Limit | Default | Setting |
| --- | --- | --- |
| Size of one file | 25 MB | `BAB_FILES_MAX_FILE_BYTES` (at most 50 MB, and at most the per-person total) |
| Total per person | 100 MB | `BAB_FILES_USER_QUOTA_BYTES` |
| Expiry | 14 days | `BAB_FILES_DEFAULT_EXPIRY_DAYS` |
| Longest expiry | 30 days | `BAB_FILES_MAX_EXPIRY_DAYS` |
| Disk guard, percentage | refuse uploads above 85% full | `BAB_FILES_DISK_FULL_PERCENT` |
| Disk guard, free space | keep twice the database size plus 64 MB free | `BAB_FILES_DISK_RESERVE_BYTES` |
| Time for one upload | 5 minutes | `BAB_FILES_UPLOAD_DEADLINE_SECONDS` |
| Uploads at once | 2 per person, 3 per client address, 6 in all | fixed |
| Inline `put` with `bab_files` | 700 KB | fixed (an MCP call is limited to 1 MB) |
| Switch | on | `BAB_FILES` |

- The total per person counts every file whose bytes are still on disk. A deleted file frees its space at once. An expired file frees its space when its bytes are removed: at the start of the next upload, or by the hourly maintenance.
- The disk guard counts every upload in progress at the full per-file size, also one sent without a `Content-Length`, because its bytes are not on disk yet. It checks again every 4 MB while an upload streams and drops the upload when the disk fills. The free-space floor keeps room for SQLite to grow and for the daily snapshot (`VACUUM INTO`, about the size of the database).
- An upload that sends nothing for 30 seconds, or is still running after the deadline, is dropped and its partial bytes deleted. The per-address cap needs `BAB_CLIENT_IP_HEADER`; without it the address is not verified and only the per-person and total caps apply.
- A refused upload says why: 413 for a file over the size limit, 507 for a full quota (with the bytes used and remaining) or a full disk, 400 for an executable, a secret, a stall or a timeout, 429 for too many uploads at once.
- Executables are refused, by extension and by their bytes:
  - Extensions: Windows programs and installers (`.exe`, `.dll`, `.msi`, `.msix`, `.application`, `.appref-ms`), scripts and shortcuts Windows runs on a double click (`.bat`, `.cmd`, `.ps1`, `.vbs`, `.hta`, `.lnk`, `.url`, `.scf`, `.library-ms`, `.chm`), Office files with macros (`.docm`, `.xlsm`, `.xlam`), OneNote (`.one`), disk images (`.iso`, `.img`, `.vhd`, `.vhdx`), Java, Android and Apple packages (`.jar`, `.apk`, `.ipa`, `.dmg`, `.pkg`), Linux packages and libraries (`.deb`, `.rpm`, `.so`), and similar.
  - Bytes: Windows programs (an `MZ` header that points to a `PE` header; plain text that starts with "MZ" is fine), Linux and macOS programs, Java classes.
  - Zip files: BAB reads the zip's table of contents and refuses Android apps (`AndroidManifest.xml`), Windows app packages (`AppxManifest.xml`) and runnable Java programs (`META-INF/MANIFEST.MF` with `Main-Class`). It does not unpack anything else, so other files inside an archive are not inspected.
  - Source code such as `.sh`, `.py` or `.js` is text and is allowed.

## Who sees what

- A file belongs to whoever uploaded it. Only the owner deletes it, shares it or changes its expiry.
- Nobody else sees it until the owner shares it with named people (`shareWith`) or with everyone (`orgVisible`). Agents set `orgVisible` only with the user's yes.
- A file someone may not see answers "not found", so ids cannot be probed.

### Identity

The file store serves only a caller whose identity BAB holds on more than the request's own word:

- a device the BAB plugin set up (`X-Bab-Device`, bound with `bab_identify`),
- the sign-in proxy (`BAB_TRUST_PROXY_IDENTITY`),
- an API token bound to that person (`BAB_API_TOKENS` entry `token=email`).

A caller identified only by `X-Bab-Actor-*` headers, or by `bab_identify` on an MCP connection with no device, gets 403 on every files route and `bab_files` action. Those can name anyone, and a file store must not let anyone read, share or delete another person's files. `BAB_FILES_ALLOW_DECLARED=1` lifts this for local development only; BAB warns at startup when it is on.

A device is still the person's own word, remembered: `bab_identify` binds a new device secret to the address it is given, and can rebind a device that was someone else's (audited as `device-rebind`). The rule above stops header spoofing, not a caller who identifies as someone else on purpose. Where that matters, put BAB behind the sign-in proxy or give people tokens bound to them (see [Operating BAB](operations.md), trust model).

## How an agent uses it

With the plugin or any MCP client, the `bab_files` tool:

- `put`: `name` and `content` (text) or `contentBase64`. At most 700 KB, because an MCP call is limited to 1 MB. `to` shares the file with that person and sends them a BAB message with its id and name; your own id reaches your other machine. `subject` and `note` go into that message.
- `list`: your files, the files shared with you, and your usage (used and quota).
- `get`: the details, a download link that works for an hour without identity, and the text inline for a small text file. Each `get` makes a new link.
- `share`: `shareWith`, `unshare`, `orgVisible`, `expiresInDays`.
- `delete`: owner only.

The tool description shows the limits of the BAB it is connected to.

Bigger files go through the REST API with a proven identity: the plugin's device secret (the `device-secret` file in the BAB plugin's data folder) or a token bound to you.

```bash
F='-H "X-Bab-Device: <device secret>"'
curl -X POST --data-binary @sweep.tar.gz "https://bab.example.com/api/files?name=sweep.tar.gz&to=first.last@example.com" $F
curl -s "https://bab.example.com/api/files/<id>/content" $F -o sweep.tar.gz
```

Every answer carries the file's `sha256`; the content route sends it as `X-Bab-File-Sha256`. Check it after a download.

**Many small files:** bundle them into one tar or zip first. One upload is one call; a thousand files are a thousand calls. BAB does not unpack archives.

## Download links

A link is `https://bab.example.com/api/files/dl/<token>`: 256 random bits, valid for an hour and only while its maker may still see the file. Anyone holding it can fetch the file in that hour. BAB stores only the sha256 of the token and never writes the token to its log or an audit row. The token is part of the URL path, though, so a reverse proxy, load balancer or access log in front of BAB may record it. Treat a link like the file itself, and keep such logs as private as the data volume. The audit row of a link fetch names the link's maker and the verified client address (`BAB_CLIENT_IP_HEADER`), the same address the rate limit uses.

## Storage and backup

The bytes live on BAB's data volume under `DATA_DIR/files`, named by a random id, never by the uploaded name. An upload streams to `DATA_DIR/files/tmp` and moves into place when it is complete and checked, so a backup never sees half a file under a final name. The bytes move into place before the row is written: a crash in between leaves bytes with no row, which the hourly maintenance deletes after an hour. The same maintenance marks a row whose bytes are missing as deleted, so it stops counting towards the quota. Rows in SQLite (`files`, `file_shares`, `file_links`) hold the name, owner, size, checksum, expiry and shares. Anything that backs up the data volume backs up the files; plan its size for the per-person total times the number of people who upload.

Every put, fetch, share, expiry, loss and delete writes an audit row.

Maintainers see the volume's size and use, the files on disk and the biggest users on `/admin`.
