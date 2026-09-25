import { describe, it, expect } from 'vitest'
import {
  computeFlow,
  parsePercent,
  topoOrder,
  validateFlow,
  type FlowConnection,
  type FlowStep,
} from '../flow'
import { Fraction } from '../fraction'
import { compareFraction } from '../stoich'

let stepId = 1
let connId = 1

function mkStep(
  name: string,
  rows: Array<['left' | 'right', string]>,
  coefficients: bigint[],
  feeds: Record<number, { amount: string; unit: 'mol' | 'mmol' | 'g'; molarMass: string }> = {},
): FlowStep {
  return {
    id: stepId++,
    name,
    rows: rows.map(([side, text]) => ({ side, text })),
    coefficients,
    feeds,
  }
}

function mkConn(from: FlowStep, product: string, to: FlowStep, percent: string): FlowConnection {
  return { id: connId++, fromStep: from.id, product, toStep: to.id, reactant: product, percent }
}

/** 分流 + 合流示例：A/B 制氢合流 → 合成氨 → NH3 分流。 */
function exampleFlow() {
  const s1 = mkStep(
    'A',
    [
      ['left', 'Zn'],
      ['left', 'HCl'],
      ['right', 'ZnCl2'],
      ['right', 'H2'],
    ],
    [1n, 2n, 1n, 1n],
    { 0: { amount: '1', unit: 'mol', molarMass: '' }, 1: { amount: '2', unit: 'mol', molarMass: '' } },
  )
  const s2 = mkStep(
    'B',
    [
      ['left', 'Fe'],
      ['left', 'HCl'],
      ['right', 'FeCl2'],
      ['right', 'H2'],
    ],
    [1n, 2n, 1n, 1n],
    { 0: { amount: '1', unit: 'mol', molarMass: '' }, 1: { amount: '2', unit: 'mol', molarMass: '' } },
  )
  const s3 = mkStep(
    'C',
    [
      ['left', 'N2'],
      ['left', 'H2'],
      ['right', 'NH3'],
    ],
    [1n, 3n, 2n],
    { 0: { amount: '0.5', unit: 'mol', molarMass: '' }, 1: { amount: '0', unit: 'mol', molarMass: '' } },
  )
  const s4 = mkStep(
    'D',
    [
      ['left', 'NH3'],
      ['left', 'O2'],
      ['right', 'NO'],
      ['right', 'H2O'],
    ],
    [4n, 5n, 4n, 6n],
    { 0: { amount: '0', unit: 'mol', molarMass: '' }, 1: { amount: '1', unit: 'mol', molarMass: '' } },
  )
  const s5 = mkStep(
    'E',
    [
      ['left', 'NH3'],
      ['left', 'HCl'],
      ['right', 'NH4Cl'],
    ],
    [1n, 1n, 1n],
    { 0: { amount: '0', unit: 'mol', molarMass: '' }, 1: { amount: '1', unit: 'mol', molarMass: '' } },
  )
  const conns = [mkConn(s1, 'H2', s3, '100'), mkConn(s2, 'H2', s3, '100'), mkConn(s3, 'NH3', s4, '60'), mkConn(s3, 'NH3', s5, '30')]
  return { steps: [s1, s2, s3, s4, s5], conns }
}

function frac(n: number, d = 1): Fraction {
  return new Fraction(BigInt(n), BigInt(d))
}

function expectEq(actual: Fraction, expected: Fraction) {
  expect(compareFraction(actual, expected)).toBe(0)
}

describe('parsePercent', () => {
  it('接受 0 < p ≤ 100 的十进制数', () => {
    expect(parsePercent('0.5').value).toBeDefined()
    expect(parsePercent('100').value).toBeDefined()
    expect(parsePercent('33.33').value).toBeDefined()
  })
  it('拒绝 0、负数、超过 100 与非法文本', () => {
    expect(parsePercent('0').error).toBeDefined()
    expect(parsePercent('-5').error).toBeDefined()
    expect(parsePercent('100.01').error).toBeDefined()
    expect(parsePercent('abc').error).toBeDefined()
    expect(parsePercent('').error).toBeDefined()
  })
})

describe('validateFlow', () => {
  it('合法的分流 + 合流流程无问题', () => {
    const { steps, conns } = exampleFlow()
    expect(validateFlow(steps, conns)).toEqual([])
  })

  it('拒绝自连', () => {
    const s = mkStep('A', [['left', 'H2'], ['right', 'H2O']], [2n, 2n])
    // 手工构造自连（H2O 不在反应物中，所以用 H2 -> H2 不行；直接构造同步骤连接）
    const s2 = mkStep('B', [['left', 'H2O'], ['right', 'H2']], [2n, 2n])
    const c: FlowConnection = { id: connId++, fromStep: s.id, product: 'H2O', toStep: s.id, reactant: 'H2O', percent: '50' }
    const issues = validateFlow([s, s2], [c])
    expect(issues.some((i) => i.message.includes('自连'))).toBe(true)
  })

  it('拒绝重复连接', () => {
    const { steps, conns } = exampleFlow()
    const dup = mkConn(steps[0], 'H2', steps[2], '10')
    const issues = validateFlow(steps, [...conns, dup])
    expect(issues.some((i) => i.message.includes('重复连接'))).toBe(true)
  })

  it('拒绝化学式不同的连接', () => {
    const s1 = mkStep('A', [['left', 'H2'], ['right', 'H2O']], [2n, 2n])
    const s2 = mkStep('B', [['left', 'O2'], ['right', 'O3']], [3n, 2n])
    const c: FlowConnection = { id: connId++, fromStep: s1.id, product: 'H2O', toStep: s2.id, reactant: 'O2', percent: '50' }
    const issues = validateFlow([s1, s2], [c])
    expect(issues.some((i) => i.message.includes('化学式相同'))).toBe(true)
  })

  it('同一生成物分配比例之和超过 100 报错并定位步骤', () => {
    const { steps, conns } = exampleFlow()
    conns[2].percent = '80'
    conns[3].percent = '50'
    const issues = validateFlow(steps, conns)
    const issue = issues.find((i) => i.message.includes('超过 100'))
    expect(issue).toBeDefined()
    expect(issue!.stepId).toBe(steps[2].id)
  })

  it('拒绝循环依赖并定位步骤', () => {
    const s1 = mkStep('A', [['left', 'X'], ['right', 'Y']], [1n, 1n])
    const s2 = mkStep('B', [['left', 'Y'], ['right', 'X']], [1n, 1n])
    const conns = [mkConn(s1, 'Y', s2, '100'), mkConn(s2, 'X', s1, '100')]
    const issues = validateFlow([s1, s2], conns)
    const cycle = issues.filter((i) => i.message.includes('循环依赖'))
    expect(cycle.length).toBe(2)
    expect(cycle.map((i) => i.stepId).sort()).toEqual([s1.id, s2.id].sort())
  })

  it('比例非法时定位连接', () => {
    const { steps, conns } = exampleFlow()
    conns[0].percent = '0'
    const issues = validateFlow(steps, conns)
    expect(issues.some((i) => i.connectionId === conns[0].id && i.message.includes('大于 0'))).toBe(true)
  })
})

describe('computeFlow', () => {
  it('合流：多来源送入累加为可用量', () => {
    const { steps, conns } = exampleFlow()
    const { accounts } = computeFlow(steps, conns)
    const c = accounts.get(steps[2].id)!
    const h2 = c.reactants.find((r) => r.label === 'H2')!
    expect(h2.incoming.length).toBe(2)
    expectEq(h2.available, frac(2))
    expectEq(h2.feedMol, frac(0))
  })

  it('按依赖顺序精确计算限量、消耗、剩余与产量', () => {
    const { steps, conns } = exampleFlow()
    const { order, accounts } = computeFlow(steps, conns)
    expect(order.indexOf(steps[0].id)).toBeLessThan(order.indexOf(steps[2].id))
    expect(order.indexOf(steps[1].id)).toBeLessThan(order.indexOf(steps[2].id))
    expect(order.indexOf(steps[2].id)).toBeLessThan(order.indexOf(steps[3].id))

    const c = accounts.get(steps[2].id)!
    // N2 0.5 mol 限量，H2 可用 2 mol
    expect(c.limiting).toEqual(['N2'])
    expectEq(c.extent, frac(1, 2))
    const h2 = c.reactants.find((r) => r.label === 'H2')!
    expectEq(h2.consumed, frac(3, 2))
    expectEq(h2.remaining, frac(1, 2))
    const nh3 = c.products.find((p) => p.label === 'NH3')!
    expectEq(nh3.produced, frac(1))
  })

  it('分流：按比例转送且未分配部分留存，总量精确守恒', () => {
    const { steps, conns } = exampleFlow()
    const { accounts } = computeFlow(steps, conns)
    const c = accounts.get(steps[2].id)!
    const nh3 = c.products.find((p) => p.label === 'NH3')!
    expectEq(nh3.transfers[0].mol, frac(3, 5)) // 60%
    expectEq(nh3.transfers[1].mol, frac(3, 10)) // 30%
    expectEq(nh3.retained, frac(1, 10)) // 10% 留存
    const d = accounts.get(steps[3].id)!
    const dNh3 = d.reactants.find((r) => r.label === 'NH3')!
    expectEq(dNh3.available, frac(3, 5))
    // D: NH3 0.6 mol, O2 1 mol → ξ = min(0.6/4, 1/5) = 0.15
    expectEq(d.extent, frac(3, 20))
    expect(d.limiting).toEqual(['NH3'])
    const e = accounts.get(steps[4].id)!
    expectEq(e.extent, frac(3, 10))
  })

  it('剩余反应物不自动转送', () => {
    const { steps, conns } = exampleFlow()
    const { accounts } = computeFlow(steps, conns)
    const c = accounts.get(steps[2].id)!
    const h2 = c.reactants.find((r) => r.label === 'H2')!
    expectEq(h2.remaining, frac(1, 2))
    // H2 的剩余不出现在任何下游
    const d = accounts.get(steps[3].id)!
    expect(d.reactants.every((r) => r.label !== 'H2')).toBe(true)
  })

  it('调序不改变计算结果与物质绑定', () => {
    const { steps, conns } = exampleFlow()
    const r1 = computeFlow(steps, conns)
    const reversed = [...steps].reverse()
    const r2 = computeFlow(reversed, conns)
    for (const s of steps) {
      const a1 = r1.accounts.get(s.id)!
      const a2 = r2.accounts.get(s.id)!
      expect(compareFraction(a1.extent, a2.extent)).toBe(0)
      a1.products.forEach((p, i) => {
        expect(compareFraction(p.produced, a2.products[i].produced)).toBe(0)
        expect(compareFraction(p.retained, a2.products[i].retained)).toBe(0)
      })
    }
  })

  it('支持 g 与 mmol 补料换算及摩尔质量校验', () => {
    const s = mkStep(
      'G',
      [
        ['left', 'NaOH'],
        ['left', 'HCl'],
        ['right', 'NaCl'],
        ['right', 'H2O'],
      ],
      [1n, 1n, 1n, 1n],
      {
        0: { amount: '40', unit: 'g', molarMass: '40' },
        1: { amount: '500', unit: 'mmol', molarMass: '' },
      },
    )
    const { accounts } = computeFlow([s], [])
    const acc = accounts.get(s.id)!
    expect(acc.hasError).toBe(false)
    expectEq(acc.extent, frac(1, 2))
    expect(acc.limiting).toEqual(['HCl'])
    const naoh = acc.reactants[0]
    expectEq(naoh.available, frac(1))
    expectEq(naoh.remaining, frac(1, 2))
  })

  it('按 g 补料缺摩尔质量时报字段错误', () => {
    const s = mkStep(
      'G',
      [
        ['left', 'NaOH'],
        ['right', 'X'],
      ],
      [1n, 1n],
      { 0: { amount: '40', unit: 'g', molarMass: '' } },
    )
    const { accounts } = computeFlow([s], [])
    const acc = accounts.get(s.id)!
    expect(acc.hasError).toBe(true)
    expect(acc.reactants[0].errors.some((e) => e.field === 'molarMass')).toBe(true)
  })

  it('补料允许填 0 或留空', () => {
    const s = mkStep(
      'Z',
      [
        ['left', 'A'],
        ['left', 'B'],
        ['right', 'C'],
      ],
      [1n, 1n, 1n],
      { 0: { amount: '0', unit: 'mol', molarMass: '' } },
    )
    const { accounts } = computeFlow([s], [])
    const acc = accounts.get(s.id)!
    expect(acc.hasError).toBe(false)
    expectEq(acc.extent, frac(0))
    expectEq(acc.products[0].produced, frac(0))
  })

  it('topoOrder 同层保持步骤数组顺序', () => {
    const { steps, conns } = exampleFlow()
    const order = topoOrder(steps, conns)
    expect(order[0]).toBe(steps[0].id)
    expect(order[1]).toBe(steps[1].id)
    expect(order.length).toBe(5)
  })
})
