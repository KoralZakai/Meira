/**
 * sameText — two task names that say the same thing (spaces, quotes and
 * punctuation aside). A task named exactly like another is its duplicate, not
 * a part of it: TaskHierarchy never files one under the other (28.10: six
 * copies of «חופשה במדבר» were filed under a seventh on every open). Pure.
 */
const norm = (t: string) => (t || '').replace(/[\s"'«»״׳.,!?־-]+/g, ' ').trim().toLowerCase();

export function sameText(a: string, b: string): boolean {
  return norm(a) === norm(b);
}
