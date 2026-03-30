/**
 * Compute a unified diff between two text strings (Myers diff algorithm).
 * Returns a string in unified diff format compatible with `diff -u`.
 *
 * @param oldText - Original text
 * @param newText - Modified text
 * @param oldLabel - Label for the original file (shown after ---)
 * @param newLabel - Label for the modified file (shown after +++)
 * @param contextLines - Number of context lines around each change (default: 3)
 */
export function computeUnifiedDiff(
  oldText: string,
  newText: string,
  oldLabel: string,
  newLabel: string,
  contextLines = 3,
): string {
  if (oldText === newText) return ''

  const oldLines = oldText === '' ? [] : oldText.split('\n')
  const newLines = newText === '' ? [] : newText.split('\n')

  const edits = computeEdits(oldLines, newLines)
  const hunks = buildHunks(edits, oldLines, newLines, contextLines)

  if (hunks.length === 0) return ''

  return [`--- ${oldLabel}`, `+++ ${newLabel}`, ...hunks].join('\n')
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type EditType = 'equal' | 'insert' | 'delete'

interface Edit {
  type: EditType
  oldIdx: number // index into oldLines (-1 for inserts)
  newIdx: number // index into newLines (-1 for deletes)
}

// ---------------------------------------------------------------------------
// Myers diff — forward algorithm producing an edit script
// ---------------------------------------------------------------------------

function computeEdits(oldLines: string[], newLines: string[]): Edit[] {
  const N = oldLines.length
  const M = newLines.length

  if (N === 0) {
    return newLines.map((_, i) => ({ type: 'insert' as const, oldIdx: -1, newIdx: i }))
  }
  if (M === 0) {
    return oldLines.map((_, i) => ({ type: 'delete' as const, oldIdx: i, newIdx: -1 }))
  }

  const MAX = N + M
  // v[k] stores the furthest reaching x-coordinate on diagonal k
  // We use an offset so negative k values can index into the array
  const offset = MAX
  const v: number[] = new Array(2 * MAX + 1).fill(0)

  // trace[d] = snapshot of v array after d edits
  const trace: number[][] = []

  outer: for (let d = 0; d <= MAX; d++) {
    trace.push([...v])
    for (let k = -d; k <= d; k += 2) {
      const ki = k + offset
      let x: number
      if (k === -d || (k !== d && v[ki - 1] < v[ki + 1])) {
        x = v[ki + 1] // move down (insert)
      } else {
        x = v[ki - 1] + 1 // move right (delete)
      }
      let y = x - k
      while (x < N && y < M && oldLines[x] === newLines[y]) {
        x++
        y++
      }
      v[ki] = x
      if (x >= N && y >= M) {
        trace.push([...v])
        break outer
      }
    }
  }

  return backtrace(trace, oldLines, newLines, offset)
}

function backtrace(
  trace: number[][],
  oldLines: string[],
  newLines: string[],
  offset: number,
): Edit[] {
  const edits: Edit[] = []
  let x = oldLines.length
  let y = newLines.length

  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]
    const k = x - y
    const ki = k + offset

    let prevK: number
    if (k === -d || (k !== d && v[ki - 1] < v[ki + 1])) {
      prevK = k + 1 // came from insert
    } else {
      prevK = k - 1 // came from delete
    }

    const prevX = v[prevK + offset]
    const prevY = prevX - prevK

    // Walk back diagonals (equal lines)
    while (x > prevX && y > prevY) {
      x--
      y--
      edits.push({ type: 'equal', oldIdx: x, newIdx: y })
    }

    if (d > 0) {
      if (x === prevX) {
        // insert
        y--
        edits.push({ type: 'insert', oldIdx: -1, newIdx: y })
      } else {
        // delete
        x--
        edits.push({ type: 'delete', oldIdx: x, newIdx: -1 })
      }
    }
  }

  return edits.reverse()
}

// ---------------------------------------------------------------------------
// Hunk construction
// ---------------------------------------------------------------------------

function buildHunks(
  edits: Edit[],
  oldLines: string[],
  newLines: string[],
  contextLines: number,
): string[] {
  if (edits.length === 0) return []

  // Collect indices of changed (non-equal) edits
  const changedIndices: number[] = []
  for (let i = 0; i < edits.length; i++) {
    if (edits[i].type !== 'equal') changedIndices.push(i)
  }
  if (changedIndices.length === 0) return []

  // Group changed indices into hunks with context windows
  const groups: Array<[number, number]> = [] // [startEditIdx, endEditIdx]
  let groupStart = Math.max(0, changedIndices[0] - contextLines)
  let groupEnd = Math.min(edits.length - 1, changedIndices[0] + contextLines)

  for (let i = 1; i < changedIndices.length; i++) {
    const ci = changedIndices[i]
    const nextStart = Math.max(0, ci - contextLines)
    if (nextStart <= groupEnd + 1) {
      // Merge with current group
      groupEnd = Math.min(edits.length - 1, ci + contextLines)
    } else {
      groups.push([groupStart, groupEnd])
      groupStart = nextStart
      groupEnd = Math.min(edits.length - 1, ci + contextLines)
    }
  }
  groups.push([groupStart, groupEnd])

  const result: string[] = []

  for (const [start, end] of groups) {
    const hunkEdits = edits.slice(start, end + 1)

    // Calculate old/new start line numbers (1-based)
    const firstOld = hunkEdits.find((e) => e.oldIdx >= 0)
    const firstNew = hunkEdits.find((e) => e.newIdx >= 0)
    const oldStart = firstOld ? firstOld.oldIdx + 1 : 1
    const newStart = firstNew ? firstNew.newIdx + 1 : 1

    const oldCount = hunkEdits.filter((e) => e.type !== 'insert').length
    const newCount = hunkEdits.filter((e) => e.type !== 'delete').length

    const oldRange = oldCount === 1 ? `${oldStart}` : `${oldStart},${oldCount}`
    const newRange = newCount === 1 ? `${newStart}` : `${newStart},${newCount}`
    result.push(`@@ -${oldRange} +${newRange} @@`)

    for (const edit of hunkEdits) {
      if (edit.type === 'equal') {
        result.push(` ${oldLines[edit.oldIdx]}`)
      } else if (edit.type === 'delete') {
        result.push(`-${oldLines[edit.oldIdx]}`)
      } else {
        result.push(`+${newLines[edit.newIdx]}`)
      }
    }
  }

  return result
}
