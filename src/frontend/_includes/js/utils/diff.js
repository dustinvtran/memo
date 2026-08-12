/**
 * @file A line diff, so the history UI can show what a version did to a note
 * rather than two walls of text side by side.
 *
 * Plain longest-common-subsequence, which is what `diff` itself does. Notes
 * are a few hundred lines at worst, so nothing cleverer is warranted.
 */

/** Past this, the LCS table is not worth the memory: fall back to a wholesale
 * replacement, which is what a diff of two unrelated texts looks like anyway. */
const MAX_LINES = 1500

/**
 * @typedef {{ type: 'same' | 'added' | 'removed', text: string }} DiffLine
 * @type {(before: string, after: string) => DiffLine[]}
 */
const lineDiff = (before, after) => {
  const oldLines = toLines(before)
  const newLines = toLines(after)

  if (oldLines.length > MAX_LINES || newLines.length > MAX_LINES) {
    return [
      ...oldLines.map((text) => ({ type: 'removed', text })),
      ...newLines.map((text) => ({ type: 'added', text })),
    ]
  }

  return walkBack(oldLines, newLines, lcsTable(oldLines, newLines))
}

/** @type {(lines: DiffLine[]) => { added: number, removed: number }} */
const diffSummary = (lines) => ({
  added: lines.filter(({ type }) => type === 'added').length,
  removed: lines.filter(({ type }) => type === 'removed').length,
})

Diff = {
  lineDiff,
  diffSummary,
}

///////////////////////////////////////////////////////////////////////////////

/** An empty string is no lines at all, not one empty line. */
const toLines = (text) => (text ? String(text).split('\n') : [])

/** table[i][j] = length of the longest common subsequence of the lines from
 * i onwards and the lines from j onwards. */
const lcsTable = (oldLines, newLines) => {
  const table = Array.from({ length: oldLines.length + 1 }, () =>
    new Uint32Array(newLines.length + 1)
  )

  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      table[i][j] =
        oldLines[i] === newLines[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  return table
}

const walkBack = (oldLines, newLines, table) => {
  const lines = []
  let i = 0
  let j = 0

  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      lines.push({ type: 'same', text: oldLines[i] })
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ type: 'removed', text: oldLines[i] })
      i++
    } else {
      lines.push({ type: 'added', text: newLines[j] })
      j++
    }
  }

  while (i < oldLines.length) lines.push({ type: 'removed', text: oldLines[i++] })
  while (j < newLines.length) lines.push({ type: 'added', text: newLines[j++] })

  return lines
}
