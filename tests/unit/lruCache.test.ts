import * as assert from 'assert'
import { LRUCache } from '../../src/blame'

suite('LRUCache', () => {
  test('#1 get() on empty cache → undefined', () => {
    const c = new LRUCache<string, number>(3)
    assert.strictEqual(c.get('x'), undefined)
  })

  test('#2 set() then get() returns stored value', () => {
    const c = new LRUCache<string, number>(3)
    c.set('a', 1)
    assert.strictEqual(c.get('a'), 1)
  })

  test('#3 inserting beyond limit evicts oldest entry', () => {
    const c = new LRUCache<string, number>(2)
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)  // evicts 'a'
    assert.strictEqual(c.get('a'), undefined)
    assert.strictEqual(c.get('b'), 2)
    assert.strictEqual(c.get('c'), 3)
  })

  test('#4 get() promotes key to MRU — promotes a, so b is evicted next', () => {
    const c = new LRUCache<string, number>(3)
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)
    c.get('a')     // promote 'a'; order is now b, c, a
    c.set('d', 4)  // evicts 'b' (oldest), not 'a'
    assert.strictEqual(c.get('b'), undefined, "'b' should have been evicted")
    assert.strictEqual(c.get('a'), 1,         "'a' should still be present")
  })

  test('#5 set() on existing key does not increase size', () => {
    const c = new LRUCache<string, number>(3)
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)
    c.set('a', 99) // overwrite — no eviction
    assert.strictEqual(c.get('a'), 99)
    assert.strictEqual(c.get('b'), 2)
    assert.strictEqual(c.get('c'), 3)
  })

  test('#6 overwrite moves key to MRU position', () => {
    const c = new LRUCache<string, number>(3)
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)
    c.set('a', 10) // re-set moves 'a' to end; order is b, c, a
    c.set('d', 4)  // evicts 'b', not 'a'
    assert.strictEqual(c.get('b'), undefined, "'b' should have been evicted")
    assert.strictEqual(c.get('a'), 10,        "'a' should still be present")
  })

  test('#7 limit=1: second insert evicts first', () => {
    const c = new LRUCache<string, number>(1)
    c.set('a', 1)
    c.set('b', 2)
    assert.strictEqual(c.get('a'), undefined)
    assert.strictEqual(c.get('b'), 2)
  })

  test('#8 get-promoted entry is eventually evictable', () => {
    const c = new LRUCache<string, number>(3)
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)
    c.get('a')     // promote 'a'; order: b, c, a
    c.set('d', 4)  // evicts b; order: c, a, d
    c.set('e', 5)  // evicts c; order: a, d, e
    c.set('f', 6)  // evicts a; order: d, e, f
    assert.strictEqual(c.get('a'), undefined, "'a' should eventually be evicted")
    assert.strictEqual(c.get('d'), 4)
  })
})
