/**
 * Decide whether SKIP must stop before presenting the next dialogue line.
 *
 * SKIP may continue only when the line is positively known to have been read.
 * An untrackable/legacy line uses null and stops as the safe default.
 */
export function shouldStopSkipAtLine(
  skipping: boolean,
  wasRead: boolean | null,
): boolean {
  return skipping && wasRead !== true;
}
