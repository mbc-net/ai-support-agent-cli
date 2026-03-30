import { computeUnifiedDiff } from '../../src/utils/unified-diff'

describe('computeUnifiedDiff', () => {
  it('should return empty string for identical inputs', () => {
    const text = 'line1\nline2\nline3'
    expect(computeUnifiedDiff(text, text, 'a', 'b')).toBe('')
  })

  it('should return empty string for two empty strings', () => {
    expect(computeUnifiedDiff('', '', 'a', 'b')).toBe('')
  })

  it('should include --- and +++ header lines', () => {
    const result = computeUnifiedDiff('old\n', 'new\n', 'file-a', 'file-b')
    expect(result).toContain('--- file-a')
    expect(result).toContain('+++ file-b')
  })

  it('should show added lines with + prefix', () => {
    const result = computeUnifiedDiff('line1', 'line1\nline2', 'a', 'b')
    expect(result).toContain('+line2')
  })

  it('should show removed lines with - prefix', () => {
    const result = computeUnifiedDiff('line1\nline2', 'line1', 'a', 'b')
    expect(result).toContain('-line2')
  })

  it('should show context lines with space prefix', () => {
    const oldText = 'ctx1\nctx2\nctx3\nchange\nctx4\nctx5\nctx6'
    const newText = 'ctx1\nctx2\nctx3\nchanged\nctx4\nctx5\nctx6'
    const result = computeUnifiedDiff(oldText, newText, 'a', 'b')
    // ctx2, ctx3, ctx4, ctx5 should appear as context (space prefix)
    expect(result).toContain(' ctx2')
    expect(result).toContain(' ctx3')
    expect(result).toContain(' ctx4')
  })

  it('should include @@ hunk header', () => {
    const result = computeUnifiedDiff('old', 'new', 'a', 'b')
    expect(result).toMatch(/^@@.+@@$/m)
  })

  it('should handle all insertions (empty old)', () => {
    const result = computeUnifiedDiff('', 'line1\nline2', 'a', 'b')
    expect(result).toContain('+line1')
    expect(result).toContain('+line2')
    // Only the header lines should start with '-', no deletion lines
    const lines = result.split('\n')
    const deletionLines = lines.filter((l) => l.startsWith('-') && !l.startsWith('---'))
    expect(deletionLines).toHaveLength(0)
  })

  it('should handle all deletions (empty new)', () => {
    const result = computeUnifiedDiff('line1\nline2', '', 'a', 'b')
    expect(result).toContain('-line1')
    expect(result).toContain('-line2')
    expect(result).not.toContain('+line')
  })

  it('should produce separate hunks for non-adjacent changes', () => {
    // Changes far apart should produce 2 hunks
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`)
    const oldText = lines.join('\n')
    const newLines = [...lines]
    newLines[0] = 'changed1'
    newLines[19] = 'changed20'
    const newText = newLines.join('\n')
    const result = computeUnifiedDiff(oldText, newText, 'a', 'b')
    const hunkCount = (result.match(/^@@/gm) ?? []).length
    expect(hunkCount).toBe(2)
  })

  it('should merge adjacent changes into a single hunk', () => {
    const oldText = 'a\nb\nc\nd\ne'
    const newText = 'A\nB\nc\nd\ne'
    const result = computeUnifiedDiff(oldText, newText, 'a', 'b')
    const hunkCount = (result.match(/^@@/gm) ?? []).length
    expect(hunkCount).toBe(1)
  })

  it('should respect custom contextLines parameter', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`)
    const oldText = lines.join('\n')
    const newLines = [...lines]
    newLines[5] = 'changed'
    const newText = newLines.join('\n')

    // With 0 context lines, only the changed line should appear (no context)
    const result = computeUnifiedDiff(oldText, newText, 'a', 'b', 0)
    expect(result).toContain('-line6')
    expect(result).toContain('+changed')
    expect(result).not.toContain(' line5')
  })

  it('should handle single-line difference', () => {
    const result = computeUnifiedDiff('hello', 'world', 'a', 'b')
    expect(result).toContain('-hello')
    expect(result).toContain('+world')
  })

  it('should handle files that differ only in trailing newline', () => {
    const result = computeUnifiedDiff('line1\nline2', 'line1\nline2\n', 'a', 'b')
    expect(result).toBeTruthy()
    expect(result).toContain('---')
    expect(result).toContain('+++')
  })
})
