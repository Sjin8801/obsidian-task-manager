// A task note is "---", the properties, "---", a blank line, then the text. The text a person writes starts after that
// blank line, so the editor hides it and puts it back on save instead of showing empty lines in front of every note.
const separator = '\n\n';
const leading = /^\n*/;

/** Split the raw body (line endings already turned into \n) into the hidden separator and the text to edit. */
export function splitBody(body: string) {
  const lead = leading.exec(body)![0];
  const text = body.slice(lead.length);
  // Keep whatever separator the note already has; give a note with no text the usual blank line.
  return { lead: text ? lead : separator, text };
}

export function joinBody(lead: string, text: string) {
  return lead + text;
}
