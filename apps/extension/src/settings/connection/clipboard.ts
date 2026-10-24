/** Writes to the clipboard; rejects where there is none or the page may not write (the caller says so). */
export async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard === undefined) throw new Error("no clipboard");
  await navigator.clipboard.writeText(text);
}
