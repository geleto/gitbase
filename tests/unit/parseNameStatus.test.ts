import * as assert from 'assert'
import { parseNameStatus } from '../../src/git'

suite('parseNameStatus', () => {
  test('#1 empty string → []', () => {
    assert.deepStrictEqual(parseNameStatus(''), [])
  })

  test('#2 only NULs → []', () => {
    assert.deepStrictEqual(parseNameStatus('\0\0\0'), [])
  })

  test('#3 single M entry', () => {
    assert.deepStrictEqual(parseNameStatus('M\0file.txt\0'), [{ status: 'M', path: 'file.txt' }])
  })

  test('#4 single A entry', () => {
    assert.deepStrictEqual(parseNameStatus('A\0added.txt\0'), [{ status: 'A', path: 'added.txt' }])
  })

  test('#5 single D entry', () => {
    assert.deepStrictEqual(parseNameStatus('D\0deleted.txt\0'), [{ status: 'D', path: 'deleted.txt' }])
  })

  test('#6 rename R100', () => {
    assert.deepStrictEqual(parseNameStatus('R100\0old.txt\0new.txt\0'), [
      { status: 'R', path: 'new.txt', oldPath: 'old.txt' },
    ])
  })

  test('#7 rename R095 (partial similarity)', () => {
    assert.deepStrictEqual(parseNameStatus('R095\0src/a.ts\0src/b.ts\0'), [
      { status: 'R', path: 'src/b.ts', oldPath: 'src/a.ts' },
    ])
  })

  test('#8 copy C100 treated as R', () => {
    assert.deepStrictEqual(parseNameStatus('C100\0orig.txt\0copy.txt\0'), [
      { status: 'R', path: 'copy.txt', oldPath: 'orig.txt' },
    ])
  })

  test('#9 multiple mixed entries preserve order', () => {
    assert.deepStrictEqual(parseNameStatus('M\0a.ts\0A\0b.ts\0D\0c.ts\0'), [
      { status: 'M', path: 'a.ts' },
      { status: 'A', path: 'b.ts' },
      { status: 'D', path: 'c.ts' },
    ])
  })

  test('#10 R entry missing second path → []', () => {
    assert.deepStrictEqual(parseNameStatus('R100\0old.txt\0'), [])
  })

  test('#11 path with spaces', () => {
    assert.deepStrictEqual(parseNameStatus('M\0src/my file.txt\0'), [
      { status: 'M', path: 'src/my file.txt' },
    ])
  })

  test('#12 path with special chars (#, &, unicode)', () => {
    assert.deepStrictEqual(parseNameStatus('M\0src/#&caf\u00e9.ts\0'), [
      { status: 'M', path: 'src/#&caf\u00e9.ts' },
    ])
  })

  test('#13 no trailing NUL produces same result', () => {
    assert.deepStrictEqual(parseNameStatus('M\0file.txt'), [{ status: 'M', path: 'file.txt' }])
  })

  test('#14 unknown status letter T passes through', () => {
    assert.deepStrictEqual(parseNameStatus('T\0file.txt\0'), [{ status: 'T', path: 'file.txt' }])
  })

  test('#15 back-to-back renames both produced', () => {
    assert.deepStrictEqual(parseNameStatus('R100\0old1.txt\0new1.txt\0R100\0old2.txt\0new2.txt\0'), [
      { status: 'R', path: 'new1.txt', oldPath: 'old1.txt' },
      { status: 'R', path: 'new2.txt', oldPath: 'old2.txt' },
    ])
  })

  test('#16 empty path token skipped, valid entry still produced', () => {
    assert.deepStrictEqual(parseNameStatus('M\0\0A\0real.txt\0'), [
      { status: 'A', path: 'real.txt' },
    ])
  })
})
