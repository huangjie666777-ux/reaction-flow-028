import { describe, expect, it } from 'vitest'
import { Fraction } from '../fraction'
import { computeFlow, type FlowConnectionData, type FlowStepData } from '../flow'

let sid = 0
function step(
  name: string,
  left: Array<[string, bigint]>,
  right: Array<[string, bigint]>,
  feeds: Record<string, { amount: string; unit: 'mol' | 'mmol' | 'g' }> = {},
  molarMasses: Record<string, string> = {},
): FlowStepData {
  return {
    id: ++sid,
    name,
    species: [
      ...left.map(([key, coefficient]) => ({ key, label: key, side: 'left' as const, coefficient })),
      ...right.map(([key, coefficient]) => ({ key, label: key, side: 'right' as const, coefficient })),
    ],
    feeds,
    molarMasses,
  }
}

let cid = 0
function conn(fromStep: number, key: string, toStep: number, percent: string): FlowConnectionData {
  return { id: ++cid, fromStep, fromKey: key, toStep, toKey: key, percent }
}

function fr(text: string): Fraction {
  const [n, d] = text.split('/')
  return new Fraction(BigInt(n), d ? BigInt(d) : 1n).normalize()
}

/** 蒸汽重整 -> 甲醇合成（分流 + 合流）夹具 */
function fixture() {
  const s1 = step('蒸汽重整', [['CH4', 1n], ['H2O', 1n]], [['CO', 1n], ['H2', 3n]], {
    CH4: { amount: '2', unit: 'mol' },
    H2O: { amount: '3', unit: 'mol' },
  })
  const s2 = step('甲醇合成', [['CO', 1n], ['H2', 2n]], [['CH3OH', 1n]])
  const s3 = step('电解水', [['H2O', 2n]], [['H2', 2n], ['O2', 1n]], {
    H2O: { amount: '4', unit: 'mol' },
  })
  const c1 = conn(s1.id, 'CO', s2.id, '100')
  const c2 = conn(s1.id, 'H2', s2.id, '50')
  const c3 = conn(s3.id, 'H2', s2.id, '100')
  return { s1, s2, s3, c1, c2, c3 }
}

describe('多步流程计算', () => {
  it('分流与合流：精确计算各步骤物料账', () => {
    const { s1, s2, s3, c1, c2, c3 } = fixture()
    const { issues, result } = computeFlow([s1, s2, s3], [c1, c2, c3])
    expect(issues).toEqual([])
    const a1 = result!.steps.find((a) => a.stepId === s1.id)!
    const a2 = result!.steps.find((a) => a.stepId === s2.id)!
    const a3 = result!.steps.find((a) => a.stepId === s3.id)!

    // 步骤1：CH4 2 mol 限量，ξ=2；产 CO 2、H2 6
    expect(a1.extent.num).toBe(2n)
    const co = a1.products.find((p) => p.key === 'CO')!
    const h2a = a1.products.find((p) => p.key === 'H2')!
    expect(co.produced.num).toBe(2n)
    expect(h2a.produced.num).toBe(6n)
    // CO 100% 转送；H2 50% 转送 3 mol，留存 3 mol
    expect(co.retained.num).toBe(0n)
    expect(h2a.transferred.num).toBe(3n)
    expect(h2a.retained.num).toBe(3n)

    // 步骤3：产 H2 4 mol 全部转送
    const h2c = a3.products.find((p) => p.key === 'H2')!
    expect(h2c.produced.num).toBe(4n)
    expect(h2c.retained.num).toBe(0n)

    // 步骤2：CO 可用 2，H2 可用 3+4=7（合流），ξ=min(2, 7/2)=2
    const h2in = a2.reactants.find((r) => r.key === 'H2')!
    expect(h2in.incoming).toHaveLength(2)
    expect(h2in.available.num).toBe(7n)
    expect(a2.extent.num).toBe(2n)
    expect(h2in.consumed.num).toBe(4n)
    expect(h2in.remaining.num).toBe(3n)
    const meoh = a2.products.find((p) => p.key === 'CH3OH')!
    expect(meoh.produced.num).toBe(2n)
    expect(meoh.retained.num).toBe(2n)
  })

  it('步骤展示顺序不影响计算结果', () => {
    const { s1, s2, s3, c1, c2, c3 } = fixture()
    const a = computeFlow([s1, s2, s3], [c1, c2, c3]).result!
    const b = computeFlow([s3, s2, s1], [c3, c2, c1]).result!
    const pick = (r: typeof a, id: number) => r.steps.find((x) => x.stepId === id)!
    for (const s of [s1, s2, s3]) {
      const x = pick(a, s.id)
      const y = pick(b, s.id)
      expect(x.extent.num * y.extent.den).toBe(y.extent.num * x.extent.den)
      expect(x.products.map((p) => [p.key, p.produced.num, p.produced.den])).toEqual(
        y.products.map((p) => [p.key, p.produced.num, p.produced.den]),
      )
    }
  })

  it('未分配部分留存；剩余反应物不自动转送', () => {
    const s1 = step('A', [['A', 1n]], [['B', 1n]], { A: { amount: '2', unit: 'mol' } })
    const s2 = step('B', [['B', 1n]], [['C', 1n]])
    const c = conn(s1.id, 'B', s2.id, '25')
    const { issues, result } = computeFlow([s1, s2], [c])
    expect(issues).toEqual([])
    const b = result!.steps[0].products[0]
    expect(b.transferred).toEqual(fr('1/2'))
    expect(b.retained).toEqual(fr('3/2'))
    // 步骤2 可用 1/2，无其他来源
    expect(result!.steps[1].extent).toEqual(fr('1/2'))
  })

  it('百分比之和超过 100 报错并定位连接', () => {
    const s1 = step('A', [['A', 1n]], [['B', 1n]], { A: { amount: '1', unit: 'mol' } })
    const s2 = step('B', [['B', 1n]], [['C', 1n]])
    const s3 = step('C', [['B', 1n]], [['D', 1n]])
    const c1 = conn(s1.id, 'B', s2.id, '60')
    const c2 = conn(s1.id, 'B', s3.id, '50')
    const { issues, result } = computeFlow([s1, s2, s3], [c1, c2])
    expect(result).toBeNull()
    expect(issues.some((i) => i.connectionId === c1.id && i.message.includes('超过 100%'))).toBe(true)
    expect(issues.some((i) => i.connectionId === c2.id)).toBe(true)
  })

  it('拒绝自连、重复连接、越界与非法百分比、化学式不同', () => {
    const s1 = step('A', [['A', 1n]], [['B', 1n], ['E', 1n], ['F', 1n], ['G', 1n]], { A: { amount: '1', unit: 'mol' } })
    const s2 = step('B', [['B', 1n], ['E', 1n], ['F', 1n], ['G', 1n]], [['C', 1n]])
    const self = conn(s1.id, 'B', s1.id, '50')
    const dup1 = conn(s1.id, 'B', s2.id, '50')
    const dup2 = conn(s1.id, 'B', s2.id, '10')
    const zero = conn(s1.id, 'E', s2.id, '0')
    const over = conn(s1.id, 'F', s2.id, '100.1')
    const bad = conn(s1.id, 'G', s2.id, 'abc')
    const mismatch = { ...conn(s1.id, 'E', s2.id, '50'), toKey: 'B' } // E -> B 化学式不同
    const { issues, result } = computeFlow(
      [s1, s2],
      [self, dup1, dup2, zero, over, bad, mismatch],
    )
    expect(result).toBeNull()
    expect(issues.find((i) => i.connectionId === self.id)?.message).toContain('自连')
    expect(issues.find((i) => i.connectionId === dup2.id)?.message).toContain('重复连接')
    expect(issues.find((i) => i.connectionId === zero.id)?.message).toContain('大于 0')
    expect(issues.find((i) => i.connectionId === over.id)?.message).toContain('不能超过 100')
    expect(issues.find((i) => i.connectionId === bad.id)?.message).toContain('分配比例')
    expect(issues.find((i) => i.connectionId === mismatch.id)?.message).toContain('化学式相同')
  })

  it('检测循环依赖', () => {
    const s1 = step('A', [['A', 1n], ['X', 1n]], [['B', 1n]], { A: { amount: '1', unit: 'mol' } })
    const s2 = step('B', [['B', 1n]], [['X', 1n]])
    const c1 = conn(s1.id, 'B', s2.id, '100')
    const c2 = conn(s2.id, 'X', s1.id, '100')
    const { issues, result } = computeFlow([s1, s2], [c1, c2])
    expect(result).toBeNull()
    expect(issues.some((i) => i.scope === 'flow' && i.message.includes('循环依赖'))).toBe(true)
  })

  it('补料单位换算：mmol、g（需摩尔质量）与零补料', () => {
    const s1 = step(
      'A',
      [['A', 2n]],
      [['B', 1n]],
      { A: { amount: '500', unit: 'mmol' } },
      { A: '10', B: '4' },
    )
    const s2 = step('B', [['B', 1n]], [['C', 1n]], { B: { amount: '0', unit: 'mol' } })
    const c = conn(s1.id, 'B', s2.id, '100')
    const { issues, result } = computeFlow([s1, s2], [c])
    expect(issues).toEqual([])
    // 500 mmol = 0.5 mol，系数 2，ξ = 0.25，产 B 0.25 mol = 1 g
    const b = result!.steps[0].products[0]
    expect(b.produced).toEqual(fr('1/4'))
    expect(b.producedMass).toEqual(fr('1'))
    expect(result!.steps[1].extent).toEqual(fr('1/4'))

    // g 补料：4 g / 10 g/mol = 0.4 mol
    const s3 = step('C', [['A', 1n]], [['D', 1n]], { A: { amount: '4', unit: 'g' } }, { A: '10' })
    const r3 = computeFlow([s3], [])
    expect(r3.issues).toEqual([])
    expect(r3.result!.steps[0].extent).toEqual(fr('2/5'))

    // g 补料缺摩尔质量 → 错误定位步骤
    const s4 = step('D', [['A', 1n]], [['D', 1n]], { A: { amount: '4', unit: 'g' } })
    const r4 = computeFlow([s4], [])
    expect(r4.result).toBeNull()
    expect(r4.issues[0].stepId).toBe(s4.id)
    expect(r4.issues[0].message).toContain('摩尔质量')
  })

  it('非法补料与摩尔质量报错并定位步骤', () => {
    const s1 = step('A', [['A', 1n]], [['B', 1n]], { A: { amount: '-1', unit: 'mol' } })
    const r1 = computeFlow([s1], [])
    expect(r1.result).toBeNull()
    expect(r1.issues[0].message).toContain('不能为负数')
    const s2 = step('B', [['A', 1n]], [['B', 1n]], { A: { amount: 'x', unit: 'mol' } })
    expect(computeFlow([s2], []).result).toBeNull()
    const s3 = step('C', [['A', 1n]], [['B', 1n]], {}, { A: '0' })
    expect(computeFlow([s3], []).issues[0].message).toContain('必须为正数')
  })
})

