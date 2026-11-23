import assert from 'node:assert/strict'
import test from 'node:test'

import { classify, pickEffort } from '../lib/index.js'

const CASES = [
  ['你好', 'trivial'],
  ['谢谢！', 'trivial'],
  ['好的', 'light'],
  ['继续', 'keep'],
  ['今天几号', 'light'],
  ['帮我把这段话翻译成英文', 'light'],
  ['帮我写一个 Python 脚本，读取 CSV 并输出统计', 'normal'],
  ['这段代码报错了，怎么排查？', 'deep'],
  ['帮我看看这个报错', 'normal'],
  ['设计一个高并发订单系统，要考虑幂等和分布式事务', 'deep'],
  ['为什么 Rust 的所有权能保证内存安全？', 'deep'],
  ['解释一下这段代码', 'normal'],
]

for (const [text, tier] of CASES) {
  test(`classify ${JSON.stringify(text)} -> ${tier}`, () => {
    assert.equal(classify(text)?.tier, tier)
  })
}

test('an empty message is not classified', () => {
  assert.equal(classify('   '), null)
})

test('effort mapping only uses supported levels', () => {
  const levels = ['off', 'low', 'high', 'max']
  assert.equal(pickEffort(levels, 'trivial'), 'off')
  assert.equal(pickEffort(levels, 'light'), 'low')
  assert.equal(pickEffort(levels, 'normal'), 'high')
  assert.equal(pickEffort(levels, 'deep'), 'max')
})

test('models without off still get a lowest level', () => {
  assert.equal(pickEffort(['low', 'high'], 'trivial'), 'low')
  assert.equal(pickEffort(['low', 'high'], 'deep'), 'high')
})

test('models without reasoning levels are left alone', () => {
  assert.equal(pickEffort(['off'], 'deep'), undefined)
  assert.equal(pickEffort([], 'normal'), undefined)
})
