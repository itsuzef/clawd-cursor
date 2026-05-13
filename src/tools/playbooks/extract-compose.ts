/**
 * Deterministic field extraction for compose-send tasks.
 *
 * Pulls recipient / subject / body out of natural-language task text
 * like: "send an email to bob@example.com with the subject 'Hi'
 * introducing yourself". Pure (no LLM). Returns whatever it can find;
 * callers decide whether to proceed with missing fields.
 *
 * The match patterns are intentionally conservative: false negatives
 * are fine (caller falls through to the agent ladder), false positives
 * would mean sending mail to the wrong address, which is worse.
 */

export interface ComposeFields {
  recipient: string;
  subject: string;
  body: string;
}

/**
 * Extract compose fields from a task string. Always returns an object;
 * any unrecognized field comes back as the empty string.
 */
export function extractComposeFields(task: string): ComposeFields {
  return {
    recipient: extractRecipient(task),
    subject:   extractSubject(task),
    body:      extractBody(task),
  };
}

/**
 * First well-formed email address in the task. Strict-enough RFC 5322
 * shape (we won't accept "foo @ bar"). If none, return empty string \u2014
 * the caller will refuse to dispatch.
 */
function extractRecipient(task: string): string {
  const m = task.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0] : '';
}

/**
 * Quoted subject wins. Otherwise look for "with (the )?subject X" or
 * "subject: X" or "subject \"X\"". Stops at the next clause keyword
 * (introducing/saying/about/that/and the body...) so we don't grab the
 * whole rest of the task as the subject.
 */
function extractSubject(task: string): string {
  // 1) Quoted: subject 'Hi', subject "Hi", subject \u201cHi\u201d.
  const quoted = task.match(/subject\s*[:=]?\s*(?:["'\u201c\u2018])([^"'\u201d\u2019\n]{1,200})(?:["'\u201d\u2019])/i);
  if (quoted) return quoted[1].trim();

  // 2) Unquoted "subject ... " up to a stop word.
  const stopWords = /(?=\s+(?:introducing|saying|about|that|and|with body|with the body|body[:\s]|telling|asking|explaining|describing|requesting|inviting))/i;
  const unquoted = task.match(/subject\s*[:=]?\s+([^\n]+)/i);
  if (unquoted) {
    const tail = unquoted[1];
    const stopMatch = tail.match(stopWords);
    const cut = stopMatch ? tail.slice(0, stopMatch.index).trim() : tail.trim();
    if (cut.length >= 1 && cut.length <= 200) return cut.replace(/[.,;]$/, '');
  }
  return '';
}

/**
 * Body extraction. Patterns we recognize:
 *   - "introducing yourself"               \u2192 "Hello, I am an AI assistant introducing myself."
 *   - "body: <text>" / "body \"<text>\""    \u2192 verbatim
 *   - "saying <text>"                       \u2192 verbatim
 *   - "with (the )?message <text>"          \u2192 verbatim
 * Anything else: empty (caller can leave the body blank).
 */
function extractBody(task: string): string {
  // Quoted body wins.
  const quoted = task.match(/(?:body|message|saying|content)\s*[:=]?\s*(?:["'\u201c\u2018])([^"'\u201d\u2019]{1,2000})(?:["'\u201d\u2019])/i);
  if (quoted) return quoted[1].trim();

  // Unquoted "body: X" / "saying X" / "with the message X" \u2014 take the rest.
  const unquoted = task.match(/(?:^|\s)(?:body|saying|message|content)\s*[:=]?\s+([^\n]{1,2000})/i);
  if (unquoted) return unquoted[1].trim().replace(/[.,;]$/, '');

  // Semantic shortcuts. "introducing yourself" is the example the user
  // ran into; expand it to a polite one-liner. Keep these intentionally
  // conservative \u2014 if we can't recognize the intent we leave body
  // empty and let the agent type something.
  if (/\bintroduc(?:e|ing)\s+yourself\b/i.test(task)) {
    return 'Hello,\n\nI am an AI assistant reaching out to introduce myself. Please let me know if there is anything I can help with.\n\nBest regards.';
  }

  return '';
}
