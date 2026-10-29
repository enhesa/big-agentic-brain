# Files

BAB stores files so agents, your other machines and colleagues can pass them to each other with the BAB identity they already have. No cloud login, no shared drive.

## What not to upload

Never confidential data: no customer data, database dumps, credentials, secrets or personal data. BAB is shared company infrastructure, and a file can be opened to the whole organisation. The rule is in the tool description and the served skill too.

## Limits

| Limit | Default | Setting |
| --- | --- | --- |
| Size of one file | 25 MB | `BAB_FILES_MAX_FILE_BYTES` (at most 50 MB, and at most the per-person total) |
| Total per person | 100 MB | `BAB_FILES_USER_QUOTA_BYTES` |
| Expiry | 14 days | `BAB_FILES_DEFAULT_EXPIRY_DAYS` |
| Longest expiry | 30 days | `BAB_FILES_MAX_EXPIRY_DAYS` |
| Disk guard | refuse uploads above 85% full | `BAB_FILES_DISK_FULL_PERCENT` |
| Switch | on | `BAB_FILES` |

- The total per person counts every file whose bytes are still on disk. A deleted file frees its space at once. An expired file frees its space when its bytes are removed: at the start of the next upload, or by the hourly maintenance.
- A refused upload says why: 413 for a file over the size limit, 507 for a full quota (with the bytes used and remaining) or a full disk.
- Executables are refused, by extension (`.exe`, `.dll`, `.msi`, `.bat`, `.cmd`, `.ps1`, `.vbs`, `.jar`, `.apk`, `.dmg`, `.so` and similar) and by their first bytes (Windows, Linux and macOS programs). Source code such as `.sh`, `.py` or `.js` is text and is allowed. Files inside an archive are not inspected.

## Who sees what

- A file belongs to whoever uploaded it. Only the owner deletes it, shares it or changes its expiry.
- Nobody else sees it until the owner shares it with named people (`shareWith`) or with everyone (`orgVisible`).
- A file someone may not see answers "not found", so ids cannot be probed.
- Identity is BAB's own (see [Operating BAB](operations.md), trust model). On a deployment where agents declare who they are, file privacy is only as strong as that.

## How an agent uses it

With the plugin or any MCP client, the `bab_files` tool:

- `put`: `name` and `content` (text) or `contentBase64`. For small files only, about 700 KB, because an MCP call is limited to 1 MB. `to` shares the file with that person and sends them a BAB message with its id and name; your own id reaches your other machine. `subject` and `note` go into that message.
- `list`: your files, the files shared with you, and your usage (used and quota).
- `get`: the details, a download link that works for an hour without identity, and the text inline for a small text file.
- `share`: `shareWith`, `unshare`, `orgVisible`, `expiresInDays`.
- `delete`: owner only.

Bigger files go through the REST API with the same identity headers:

```bash
curl -X POST --data-binary @sweep.tar.gz "https://bab.example.com/api/files?name=sweep.tar.gz&to=first.last@example.com" $H
curl -s "https://bab.example.com/api/files/<id>/content" $H -o sweep.tar.gz
```

Every answer carries the file's `sha256`; the content route sends it as `X-Bab-File-Sha256`. Check it after a download.

**Many small files:** bundle them into one tar or zip first. One upload is one call; a thousand files are a thousand calls. BAB does not unpack archives.

## Storage and backup

The bytes live on BAB's data volume under `DATA_DIR/files`, named by a random id, never by the uploaded name. An upload streams to `DATA_DIR/files/tmp` and moves into place when it is complete, so a backup never sees half a file under a final name. Rows in SQLite (`files`, `file_shares`, `file_links`) hold the name, owner, size, checksum, expiry and shares. Anything that backs up the data volume backs up the files; plan its size for the per-person total times the number of people who upload.

Download links are stored as the sha256 of their token, never the token. Every put, fetch, share, expiry and delete writes an audit row.

Maintainers see the volume's size and use, the files on disk and the biggest users on `/admin`.
