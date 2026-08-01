// Thin, pure adapter over postal-mime + html-to-text. Turns a raw RFC 5322 message into the prose
// that belongs in text_repr — no fs, no network, same posture as parse.js. Imports only
// postal-mime, html-to-text and ./parse.js — NEVER src/ (doc 04 §1.1, npm run check:boundary).
import PostalMime from 'postal-mime';
import { htmlToText } from 'html-to-text';
import { splitMessage, parseHeaders } from './parse.js';

// Caps the text handed to html-to-text / truncateSnippet — converting a multi-MB html part just to
// take a 1000-char snippet (SNIPPET_MAX_CHARS in parse.js) is pure waste on a 14k-message run.
export const MAX_PART_CHARS = 20_000;

// The reader-independent MIME type of the message, from the headers themselves — not from the
// library, since routing a header through a second parser for no reason is not worth doing.
function mimeTypeFromHeaders(headerText) {
  const contentType = parseHeaders(headerText)['content-type'] || '';
  const match = /^[^;]+/.exec(contentType);
  return match ? match[0].trim().toLowerCase() : 'text/plain';
}

// The one property that makes this safe to run over 14k unseen messages: the failure mode is
// "no snippet", never "boilerplate". Selection ladder: parsed .text wins; else .html converted to
// text; else '' with source:'none'. Attachment parts are never a body candidate — postal-mime
// separates them into .attachments and this function never reads that array's content.
export async function extractBodyText(raw) {
  const { headerText } = splitMessage(raw);
  const mimeType = mimeTypeFromHeaders(headerText);
  try {
    const email = await PostalMime.parse(raw);
    if (email.text) {
      return { text: email.text.slice(0, MAX_PART_CHARS), source: 'text/plain', mimeType };
    }
    if (email.html) {
      const text = htmlToText(email.html.slice(0, MAX_PART_CHARS));
      return { text, source: 'text/html', mimeType };
    }
    return { text: '', source: 'none', mimeType };
  } catch {
    // A parse failure degrades to "Email to <recipients>: <subject>" (buildTextRepr already does
    // this for an empty body) — strictly better than the boilerplate this connector used to emit.
    return { text: '', source: 'none', mimeType };
  }
}
