import * as assert from 'assert'
import { diffTitle, baseFragment } from '../../src/labels'

suite('diffTitle / baseFragment (LABEL_FORMATTER_ENABLED = false)', () => {
  test('#1 diffTitle returns "filename (shortSuffix)"', () => {
    assert.strictEqual(diffTitle('file.ts', 'abc1234'), 'file.ts (abc1234)')
  })

  test('#2 diffTitle with path and branch ref', () => {
    assert.strictEqual(diffTitle('utils/helpers.ts', 'origin/main'), 'utils/helpers.ts (origin/main)')
  })

  test('#3 baseFragment returns comparison arg unchanged regardless of type/ref/label', () => {
    assert.strictEqual(baseFragment('Branch', 'origin/main', 'Branch · origin/main', 'my-comparison'), 'my-comparison')
    assert.strictEqual(baseFragment('Tag',    'v1.0',        'Tag · v1.0',            'other'),          'other')
    assert.strictEqual(baseFragment('Commit', 'abc1234',     'Commit · abc1234',       'anything'),       'anything')
    assert.strictEqual(baseFragment(undefined,'ref',         'label',                  'x'),              'x')
  })

  test('#4 baseFragment with specific comparison value', () => {
    assert.strictEqual(baseFragment('Branch', 'origin/main', 'Branch · origin/main', 'base-to-head'), 'base-to-head')
  })
})
