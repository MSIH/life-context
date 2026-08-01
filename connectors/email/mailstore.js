// Reads a local mail store off disk — the acquisition step is a desktop mail client (Thunderbird
// or equivalent), which authenticates over OAuth2 with its own provider credentials and syncs the
// folders. This connector therefore holds no mail credential, opens no socket, and only ever READS:
// nothing here creates, modifies, moves or deletes a file, and client-owned index files are skipped
// rather than parsed. The store belongs to the mail client.
//
// Two layouts are supported because both are in the wild: mbox (one file per folder — what an
// existing Thunderbird profile almost certainly has) and maildir (one file per message — preferable
// for a store set up fresh, since incremental reads never restream a multi-gigabyte file).
import { createReadStream } from 'node:fs';
import { readdir, stat, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';

// Thunderbird writes a sibling index (.msf) per folder and nests subfolders in a .sbd directory;
// neither is a message. Everything else that is a plain file in a maildir subdir is one.
const CLIENT_INDEX_EXTENSIONS = new Set(['.msf', '.dat', '.sbd']);
const MAILDIR_MESSAGE_DIRS = ['cur', 'new'];

export const isClientIndexFile = (name) => CLIENT_INDEX_EXTENSIONS.has(path.extname(name).toLowerCase());

// mbox quotes a body line that would otherwise look like a separator, adding one '>' per level
// ("mboxrd"). Undo exactly one level so the body is byte-faithful again: '>From ' -> 'From ',
// '>>From ' -> '>From '. Anything not matching that shape is left alone.
export const unescapeMboxLine = (line) => (/^>+From /.test(line) ? line.slice(1) : line);

/** 'maildir' when the path holds a cur/ or new/ directory, 'mbox' when it is a plain file, else null. */
export async function detectStoreFormat(target) {
  let info;
  try { info = await stat(target); } catch { return null; }
  if (info.isFile()) return 'mbox';
  if (!info.isDirectory()) return null;
  const entries = await readdir(target);
  return MAILDIR_MESSAGE_DIRS.some((d) => entries.includes(d)) ? 'maildir' : null;
}

// Streams an mbox folder file, yielding one raw message at a time. Streaming is not an
// optimization here: a real Sent folder can be gigabytes, and readFile would need all of it
// resident. A 'From ' at the start of a line opens the next message; the mboxrd quoting above is
// what keeps a body line that looks like one from splitting the message in two.
async function* readMbox(filePath) {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lines = null; // null until the first separator, so any preamble before it is discarded
  try {
    for await (const line of rl) {
      if (/^From /.test(line)) {
        if (lines?.length) yield lines.join('\n');
        lines = [];
        continue; // the separator itself is not part of the message
      }
      if (lines) lines.push(unescapeMboxLine(line));
    }
    if (lines?.length) yield lines.join('\n');
  } finally {
    // Destroy the stream too, not just the interface: closing only the readline leaves the file
    // handle tearing down asynchronously, and a caller that exits promptly can race that teardown.
    rl.close();
    stream.destroy();
  }
}

// Yields each message file under cur/ and new/. Sorted for determinism (readdir order is
// filesystem-dependent, and a stable order makes a resumed run predictable).
async function* readMaildir(dirPath) {
  for (const sub of MAILDIR_MESSAGE_DIRS) {
    const full = path.join(dirPath, sub);
    let names;
    try { names = await readdir(full); } catch { continue; } // a maildir legitimately lacks new/
    for (const name of names.sort()) {
      if (isClientIndexFile(name)) continue;
      const file = path.join(full, name);
      let info;
      try { info = await stat(file); } catch { continue; }
      if (!info.isFile()) continue;
      yield { raw: await readFile(file, 'utf8'), sourcePath: file };
    }
  }
}

/**
 * Yields `{ raw, sourcePath }` for every message in the folder, whichever layout it uses.
 * `sourcePath` is the per-message file for maildir and null for mbox — an mbox has no addressable
 * path for a single message, which is exactly why raw_path is only set for maildir sources.
 * Throws on an unrecognizable target rather than yielding nothing: a silent zero-message run against
 * a mistyped path looks identical to an empty folder, and that is the confusing failure to avoid.
 */
export async function* readMessages(folderPath) {
  const format = await detectStoreFormat(folderPath);
  if (format === 'mbox') {
    for await (const raw of readMbox(folderPath)) yield { raw, sourcePath: null };
    return;
  }
  if (format === 'maildir') {
    yield* readMaildir(folderPath);
    return;
  }
  throw new Error(
    `not a readable mail folder: expected an mbox file or a maildir directory (containing cur/ or new/). ` +
    `If the account was configured as POP rather than IMAP, there is no Sent folder to read.`,
  );
}
