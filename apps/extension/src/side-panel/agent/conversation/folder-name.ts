/**
 * T607 (A1, G2): a project folder is shown by its name - the last segment of its path - wherever a
 * line is short (the chip, the header, a drawer row). The whole path stays one hover away, as the
 * element's title, and in the folder chooser. A drive or filesystem root has no name of its own, so
 * it is shown as it is.
 */
export function folderName(path: string): string {
  const last = path.split(/[\\/]+/).filter((segment) => segment !== "").at(-1);
  return last === undefined || /^[A-Za-z]:$/.test(last) ? path : last;
}
