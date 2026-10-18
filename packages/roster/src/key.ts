/**
 * The matching key and distance of spec 1.2 §7.1 and §7.2. Any change here
 * changes matching, so it needs a new `ROSTER_MATCHER_VERSION`.
 */

/** Each look-alike character and its group's representative (§7.1 step 5). */
const LOOK_ALIKES: ReadonlyMap<string, string> = new Map([
  ['i', '1'],
  ['l', '1'],
  ['1', '1'],
  ['|', '1'],
  ['o', '0'],
  ['0', '0'],
  ['s', '5'],
  ['5', '5'],
  ['b', '8'],
  ['8', '8'],
]);

/**
 * The roster matching key of `text`: NFKC, lowercase, every whitespace
 * character removed, each `rn` replaced with `m` left to right, then each
 * look-alike character replaced with its group's representative.
 */
export function rosterKey(text: string): string {
  const folded = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s/gu, '')
    .replaceAll('rn', 'm');
  let key = '';
  for (const character of folded) {
    key += LOOK_ALIKES.get(character) ?? character;
  }
  return key;
}

/**
 * The Levenshtein distance between two strings over Unicode code points.
 * Insertion, deletion and substitution each cost 1, so a transposition costs
 * 2. Spec 1.2 applies it to two keys (`keyDistance`) and to the name as read and
 * a gamertag (`textDistance`).
 */
export function keyDistance(a: string, b: string): number {
  const matrix = editMatrix(Array.from(a), Array.from(b));
  return matrix.at(-1)!.at(-1)!;
}

/**
 * The Levenshtein matrix of `a` against `b`: `matrix[i][j]` is the distance
 * from the first `i` code points of `a` to the first `j` of `b`.
 */
export function editMatrix(
  a: readonly string[],
  b: readonly string[],
): number[][] {
  const matrix: number[][] = [
    Array.from({ length: b.length + 1 }, (_, j) => j),
  ];
  for (let i = 1; i <= a.length; i += 1) {
    const previous = matrix[i - 1];
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(
        Math.min(
          previous[j - 1] + substitution,
          previous[j] + 1,
          row[j - 1] + 1,
        ),
      );
    }
    matrix.push(row);
  }
  return matrix;
}
