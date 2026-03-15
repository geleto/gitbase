import * as assert from 'assert'
import { isSha } from '../../src/git'

suite('isSha', () => {
  test('#1 40 lowercase hex chars → true', () => {
    assert.strictEqual(isSha('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'), true)
  })

  test('#2 39 chars (too short) → false', () => {
    assert.strictEqual(isSha('a'.repeat(39)), false)
  })

  test('#3 41 chars (too long) → false', () => {
    assert.strictEqual(isSha('a'.repeat(41)), false)
  })

  test('#4 contains uppercase → false', () => {
    assert.strictEqual(isSha('A'.repeat(40)), false)
  })

  test('#5 contains g → false', () => {
    assert.strictEqual(isSha('a'.repeat(39) + 'g'), false)
  })

  test('#6 branch name origin/main → false', () => {
    assert.strictEqual(isSha('origin/main'), false)
  })

  test('#7 tag name v1.0 → false', () => {
    assert.strictEqual(isSha('v1.0'), false)
  })

  test('#8 empty string → false', () => {
    assert.strictEqual(isSha(''), false)
  })

  test('#9 all zeros (structurally valid) → true', () => {
    assert.strictEqual(isSha('0'.repeat(40)), true)
  })
})
