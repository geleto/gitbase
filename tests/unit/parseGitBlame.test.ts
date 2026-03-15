import * as assert from 'assert'
import { parseGitBlame } from '../../src/blame'

const H1 = 'a'.repeat(40)
const H2 = 'b'.repeat(40)
const H3 = 'c'.repeat(40)

/** Build a raw `git blame --root --incremental` hunk string. */
function hunk(
  hash: string,
  finalLine: number,
  count: number,
  opts: { author?: string; authorTime?: number; summary?: string; filename?: string } = {},
): string {
  const lines: string[] = [`${hash} ${finalLine} ${finalLine} ${count}`]
  if (opts.author !== undefined)     lines.push(`author ${opts.author}`)
  if (opts.authorTime !== undefined) lines.push(`author-time ${opts.authorTime}`)
  if (opts.summary !== undefined)    lines.push(`summary ${opts.summary}`)
  if (opts.filename !== undefined)   lines.push(`filename ${opts.filename}`)
  return lines.join('\n')
}

/** Full hunk with all fields present. */
const full = (hash: string, finalLine: number, count: number) =>
  hunk(hash, finalLine, count, { author: 'Jane', authorTime: 1700000000, summary: 'My commit', filename: 'f.txt' })

suite('parseGitBlame', () => {
  suite('basic parsing', () => {
    test('#1 empty string → []', () => {
      assert.deepStrictEqual(parseGitBlame(''), [])
    })

    test('#2 single commit, single line', () => {
      const result = parseGitBlame(full(H1, 1, 1))
      assert.strictEqual(result.length, 1)
      assert.strictEqual(result[0].hash, H1)
      assert.deepStrictEqual(result[0].ranges, [{ startLineNumber: 1, endLineNumber: 1 }])
    })

    test('#3 single commit, count=5 → endLineNumber=5', () => {
      const result = parseGitBlame(full(H1, 1, 5))
      assert.deepStrictEqual(result[0].ranges, [{ startLineNumber: 1, endLineNumber: 5 }])
    })

    test('#4 author-time stored as unix ms (× 1000)', () => {
      assert.strictEqual(parseGitBlame(full(H1, 1, 1))[0].authorDate, 1700000000 * 1000)
    })

    test('#5 author line captured in authorName', () => {
      assert.strictEqual(parseGitBlame(full(H1, 1, 1))[0].authorName, 'Jane')
    })

    test('#6 summary line captured in subject', () => {
      assert.strictEqual(parseGitBlame(full(H1, 1, 1))[0].subject, 'My commit')
    })

    test('#7 two different commits → 2 entries', () => {
      const data = [full(H1, 1, 1), full(H2, 2, 1)].join('\n')
      assert.strictEqual(parseGitBlame(data).length, 2)
    })

    test('#8 same commit hash appearing twice → 1 entry with 2 ranges', () => {
      const data = [full(H1, 1, 1), full(H1, 3, 1)].join('\n')
      const result = parseGitBlame(data)
      assert.strictEqual(result.length, 1)
      assert.strictEqual(result[0].ranges.length, 2)
    })
  })

  suite('edge cases', () => {
    test('#9 missing author line → authorName is undefined', () => {
      const result = parseGitBlame(hunk(H1, 1, 1, { authorTime: 1000, summary: 'S', filename: 'f' }))
      assert.strictEqual(result[0].authorName, undefined)
    })

    test('#10 missing summary line → subject is undefined', () => {
      const result = parseGitBlame(hunk(H1, 1, 1, { author: 'A', authorTime: 1000, filename: 'f' }))
      assert.strictEqual(result[0].subject, undefined)
    })

    test('#11 missing author-time line → authorDate is undefined', () => {
      const result = parseGitBlame(hunk(H1, 1, 1, { author: 'A', summary: 'S', filename: 'f' }))
      assert.strictEqual(result[0].authorDate, undefined)
    })

    test('#12 non-hash prefix lines skipped cleanly', () => {
      const data = 'not a hash line\n' + full(H1, 1, 1)
      assert.strictEqual(parseGitBlame(data).length, 1)
    })

    test('#13 root commit (no previous line) parsed normally', () => {
      const result = parseGitBlame(hunk(H1, 1, 1, { author: 'A', authorTime: 1000, summary: 'S', filename: 'f' }))
      assert.strictEqual(result.length, 1)
      assert.strictEqual(result[0].hash, H1)
    })

    test('#14 hunk ends at EOF without filename line → not added', () => {
      const data = `${H1} 1 1 1\nauthor Jane\nsummary S`
      assert.deepStrictEqual(parseGitBlame(data), [])
    })

    test('#15 author-mail line does not corrupt other fields', () => {
      const data = `${H1} 1 1 1\nauthor Jane\nauthor-mail <jane@x.com>\nauthor-time 1000\nsummary S\nfilename f`
      const result = parseGitBlame(data)
      assert.strictEqual(result[0].authorName, 'Jane')
      assert.strictEqual(result[0].subject, 'S')
    })

    test('#16 filename line with spaces acts as hunk terminator', () => {
      const result = parseGitBlame(hunk(H1, 1, 1, { author: 'A', authorTime: 1000, summary: 'S', filename: 'path with spaces.txt' }))
      assert.strictEqual(result.length, 1)
    })

    test('#17 commit appearing again later has its range merged', () => {
      const data = [full(H1, 1, 1), full(H2, 2, 1), full(H3, 3, 1), full(H2, 5, 1)].join('\n')
      const h2 = parseGitBlame(data).find(e => e.hash === H2)!
      assert.strictEqual(h2.ranges.length, 2)
    })
  })

  suite('line number arithmetic', () => {
    test('#18 hash 1 1 3 → startLineNumber=1, endLineNumber=3', () => {
      const result = parseGitBlame(full(H1, 1, 3))
      assert.deepStrictEqual(result[0].ranges[0], { startLineNumber: 1, endLineNumber: 3 })
    })

    test('#19 hash 10 10 1 → startLine === endLine === 10', () => {
      const result = parseGitBlame(hunk(H1, 10, 1, { author: 'A', authorTime: 1000, summary: 'S', filename: 'f' }))
      assert.deepStrictEqual(result[0].ranges[0], { startLineNumber: 10, endLineNumber: 10 })
    })
  })
})
