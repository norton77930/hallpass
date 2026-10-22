/**
 * What to call an action in a sentence that quotes it ("asks to: {title}", "Waiting for you: {title}",
 * "You rejected: {title}").
 *
 * Some agents (DeepSeek) often send a permission request with no title, and a reject-only card has no
 * detail either; substituting the blank would leave the sentence ending in a dangling colon. So: the
 * title when it says anything, else the first non-blank line of the action's detail where the site has
 * it, else the panel's "an action it did not describe".
 */
export function actionWords(title: string | undefined, t: (key: string) => string, detail?: string): string {
  const named = (title ?? "").trim();
  if (named !== "") return title ?? "";
  const line = (detail ?? "")
    .split(/\r?\n/)
    .map((words) => words.trim())
    .find((words) => words !== "");
  return line ?? t("conversation.permission.unnamed");
}
