import * as assert from 'assert'
import { parseBinarySet } from '../../src/git'

suite('parseBinarySet', () => {
  test('#1 empty string → empty set', () => {
    assert.deepStrictEqual(parseBinarySet(''), new Set())
  })

  test('#2 single text file → empty set', () => {
    assert.deepStrictEqual(parseBinarySet('5\t3\tfile.ts\0'), new Set())
  })

  test('#3 single binary file', () => {
    assert.deepStrictEqual(parseBinarySet('-\t-\tlogo.png\0'), new Set(['logo.png']))
  })

  test('#4 binary in subdirectory', () => {
    assert.deepStrictEqual(parseBinarySet('-\t-\tassets/img.jpg\0'), new Set(['assets/img.jpg']))
  })

  test('#5 binary rename: new path in set', () => {
    assert.deepStrictEqual(parseBinarySet('-\t-\t\0old.png\0new.png\0'), new Set(['new.png']))
  })

  test('#6 mixed: text file not added, binary added', () => {
    assert.deepStrictEqual(parseBinarySet('3\t1\ta.ts\0-\t-\tb.png\0'), new Set(['b.png']))
  })

  test('#7 multiple binaries both in set', () => {
    assert.deepStrictEqual(parseBinarySet('-\t-\ta.png\0-\t-\tb.png\0'), new Set(['a.png', 'b.png']))
  })

  test('#8 binary rename: old path NOT in set', () => {
    const result = parseBinarySet('-\t-\t\0old.png\0new.png\0')
    assert.ok(!result.has('old.png'), 'old path must not be in the set')
    assert.ok(result.has('new.png'), 'new path must be in the set')
  })

  test('#9 dash-prefixed token that is not -\\t-\\t is skipped', () => {
    assert.deepStrictEqual(parseBinarySet('--cached\t0\tfile\0'), new Set())
  })
})
