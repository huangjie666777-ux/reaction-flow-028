
import { Fraction } from './fraction'
import { compareFraction, parseDecimal, type AmountUnit } from './stoich'

/** 去掉全部空白后的化学式，作为物质绑定键 */
export function speciesKey(text: string): string {
  return text.replace(/\s+/g, '')
}

export interface FlowSpecies {
  /** 归一化化学式（去空白），步骤内同侧唯一 */
  key: string
  /** 展示用原始文本 */
  label: string
  side: 'left' | 'right'
  coefficient: bigint
}

export interface FeedInput {
  amount: string
  unit: AmountUnit
}

export interface FlowStepData {
  id: number
  name: string
  species: FlowSpecies[]
  /** 外部补料，按反应物 key 存放；空数量视为 0（不补料） */
  feeds: Record<string, FeedInput>
  /** 各物质摩尔质量文本（反应物与生成物均可填），按 key 存放 */
  molarMasses: Record<string, string>
}

export interface FlowConnectionData {
  id: number
  fromStep: number
  /** 源步骤生成物 key */
  fromKey: string
  toStep: number
  /** 目标步骤反应物 key */
  toKey: string
  /** 百分比文本，(0, 100] 的十进制数 */
  percent: string
}

export interface FlowIssue {
  scope: 'step' | 'connection' | 'flow'
  stepId?: number
  connectionId?: number
  message: string
}

export interface IncomingTransfer {
  connectionId: number
  fromStepId: number
  fromKey: string
  mol: Fraction
}

export interface OutgoingTransfer {
  connectionId: number
  toStepId: number
  toKey: string
  /** 精确比例（百分比 / 100） */
  ratio: Fraction
  mol: Fraction
}

export interface ReactantAccount {
  key: string
  label: string
  coefficient: bigint
  /** 外部补料（mol） */
  feedMol: Fraction
  incoming: IncomingTransfer[]
  /** 可用量 = 补料 + 全部上游送入 */
  available: Fraction
  consumed: Fraction
  remaining: Fraction
  limiting: boolean
  molarMass?: Fraction
  remainingMass?: Fraction
}

export interface ProductAccount {
  key: string
  label: string
  coefficient: bigint
  produced: Fraction
  transfers: OutgoingTransfer[]
  transferred: Fraction
  retained: Fraction
  molarMass?: Fraction
  producedMass?: Fraction
}

export interface StepAccount {
  stepId: number
  name: string
  extent: Fraction
  reactants: ReactantAccount[]
  products: ProductAccount[]
}

export interface FlowResult {
  /** 按依赖顺序排列的步骤物料账 */
  steps: StepAccount[]
}

interface ParsedConnection {
  data: FlowConnectionData
  ratio: Fraction
}

const HUNDRED = new Fraction(100n)

/**
 * 校验整套流程并（校验通过时）按依赖顺序计算物料账。
 * 全程使用精确有理数；任一错误都会使 result 为空，不混用新旧结果。
 */
export function computeFlow(
  steps: FlowStepData[],
  connections: FlowConnectionData[],
): { issues: FlowIssue[]; result: FlowResult | null } {
  const issues: FlowIssue[] = []
  const stepById = new Map(steps.map((s) => [s.id, s]))

  // ---- 连接校验 ----
  const parsed = new Map<number, ParsedConnection>()
  const seenConn = new Set<string>()
  for (const c of connections) {
    const loc = (msg: string) => issues.push({ scope: 'connection', connectionId: c.id, message: msg })
    const from = stepById.get(c.fromStep)
    const to = stepById.get(c.toStep)
    if (!from || !to) {
      loc('连接指向的步骤不存在')
      continue
    }
    if (c.fromStep === c.toStep) {
      loc('步骤「' + from.name + '」不能自连')
      continue
    }
    if (!from.species.some((sp) => sp.side === 'right' && sp.key === c.fromKey)) {
      loc('步骤「' + from.name + '」没有生成物 ' + c.fromKey)
      continue
    }
    if (!to.species.some((sp) => sp.side === 'left' && sp.key === c.toKey)) {
      loc('步骤「' + to.name + '」没有反应物 ' + c.toKey)
      continue
    }
    if (c.fromKey !== c.toKey) {
      loc('只允许连接化学式相同的物质（' + c.fromKey + ' ≠ ' + c.toKey + '）')
      continue
    }
    const dupKey = c.fromStep + '|' + c.fromKey + '|' + c.toStep + '|' + c.toKey
    if (seenConn.has(dupKey)) {
      loc('重复连接：' + from.name + ' 的 ' + c.fromKey + ' → ' + to.name)
      continue
    }
    seenConn.add(dupKey)
    const p = parseDecimal(c.percent)
    if (p.error) {
      loc('分配比例：' + p.error)
      continue
    }
    const pct = p.value!
    if (!pct.isPositive()) {
      loc('分配比例：必须大于 0')
      continue
    }
    if (compareFraction(pct, HUNDRED) > 0) {
      loc('分配比例：不能超过 100')
      continue
    }
    parsed.set(c.id, { data: c, ratio: pct.div(HUNDRED) })
  }

  // 同一生成物分配比例之和 ≤ 100
  const bySource = new Map<string, Fraction>()
  for (const pc of parsed.values()) {
    const k = pc.data.fromStep + '|' + pc.data.fromKey
    bySource.set(k, (bySource.get(k) ?? Fraction.zero).add(pc.ratio))
  }
  for (const pc of parsed.values()) {
    const k = pc.data.fromStep + '|' + pc.data.fromKey
    if (compareFraction(bySource.get(k)!, new Fraction(1n)) > 0) {
      const from = stepById.get(pc.data.fromStep)!
      issues.push({
        scope: 'connection',
        connectionId: pc.data.id,
        message: '步骤「' + from.name + '」生成物 ' + pc.data.fromKey + ' 的分配比例之和超过 100%',
      })
    }
  }

  // ---- 循环依赖检测（在有效连接上） ----
  const adj = new Map<number, number[]>()
  for (const pc of parsed.values()) {
    const list = adj.get(pc.data.fromStep) ?? []
    list.push(pc.data.toStep)
    adj.set(pc.data.fromStep, list)
  }
  const state = new Map<number, number>()
  let cycleSteps: string[] = []
  const dfs = (u: number, stack: number[]): boolean => {
    state.set(u, 1)
    for (const v of adj.get(u) ?? []) {
      const s = state.get(v) ?? 0
      if (s === 1) {
        const cyc = stack.slice(stack.indexOf(u)).concat([u])
        cycleSteps = cyc.map((id) => stepById.get(id)?.name ?? String(id))
        return true
      }
      if (s === 0 && dfs(v, [...stack, v])) return true
    }
    state.set(u, 2)
    return false
  }
  for (const s of steps) {
    if ((state.get(s.id) ?? 0) === 0 && dfs(s.id, [s.id])) break
  }
  if (cycleSteps.length > 0) {
    issues.push({
      scope: 'flow',
      message: '存在循环依赖：' + cycleSteps.join(' → ') + '，请断开其中一条连接',
    })
  }

  // ---- 补料与摩尔质量校验 ----
  const feedMol = new Map<string, Fraction>() // stepId|key
  const molarMass = new Map<string, Fraction>()
  for (const step of steps) {
    for (const sp of step.species) {
      const mmText = (step.molarMasses[sp.key] ?? '').trim()
      if (mmText !== '') {
        const mm = parseDecimal(mmText)
        if (mm.error) {
          issues.push({ scope: 'step', stepId: step.id, message: '步骤「' + step.name + '」' + sp.label + ' 摩尔质量：' + mm.error })
        } else if (!mm.value!.isPositive()) {
          issues.push({ scope: 'step', stepId: step.id, message: '步骤「' + step.name + '」' + sp.label + ' 摩尔质量：必须为正数' })
        } else {
          molarMass.set(step.id + '|' + sp.key, mm.value!)
        }
      }
      if (sp.side !== 'left') continue
      const feed = step.feeds[sp.key] ?? { amount: '', unit: 'mol' as AmountUnit }
      const amountText = feed.amount.trim()
      if (amountText === '') {
        feedMol.set(step.id + '|' + sp.key, Fraction.zero)
        continue
      }
      const amount = parseDecimal(amountText)
      if (amount.error) {
        issues.push({ scope: 'step', stepId: step.id, message: '步骤「' + step.name + '」' + sp.label + ' 补料数量：' + amount.error })
        continue
      }
      if (amount.value!.isNegative()) {
        issues.push({ scope: 'step', stepId: step.id, message: '步骤「' + step.name + '」' + sp.label + ' 补料数量：不能为负数' })
        continue
      }
      if (feed.unit === 'mol') feedMol.set(step.id + '|' + sp.key, amount.value!)
      else if (feed.unit === 'mmol') feedMol.set(step.id + '|' + sp.key, amount.value!.div(new Fraction(1000n)))
      else {
        const mm = molarMass.get(step.id + '|' + sp.key)
        if (!mm) {
          issues.push({ scope: 'step', stepId: step.id, message: '步骤「' + step.name + '」' + sp.label + '：按 g 补料必须填写正摩尔质量' })
          continue
        }
        feedMol.set(step.id + '|' + sp.key, amount.value!.div(mm))
      }
    }
  }

  if (issues.length > 0) return { issues, result: null }

  // ---- 拓扑排序（Kahn），保证按依赖顺序计算；与步骤展示顺序无关 ----
  const indeg = new Map<number, number>(steps.map((s) => [s.id, 0]))
  for (const pc of parsed.values()) indeg.set(pc.data.toStep, (indeg.get(pc.data.toStep) ?? 0) + 1)
  const queue = steps.map((s) => s.id).filter((id) => (indeg.get(id) ?? 0) === 0)
  const order: number[] = []
  while (queue.length > 0) {
    const u = queue.shift()!
    order.push(u)
    for (const v of adj.get(u) ?? []) {
      const d = (indeg.get(v) ?? 0) - 1
      indeg.set(v, d)
      if (d === 0) queue.push(v)
    }
  }

  // ---- 逐步计算 ----
  const accounts: StepAccount[] = []
  for (const stepId of order) {
    const step = stepById.get(stepId)!
    const reactants: ReactantAccount[] = []
    const products: ProductAccount[] = []

    for (const sp of step.species) {
      const mm = molarMass.get(step.id + '|' + sp.key)
      if (sp.side === 'left') {
        const incoming: IncomingTransfer[] = []
        for (const pc of parsed.values()) {
          if (pc.data.toStep !== step.id || pc.data.toKey !== sp.key) continue
          const srcAccount = accounts.find((a) => a.stepId === pc.data.fromStep)!
          const srcProduct = srcAccount.products.find((p) => p.key === pc.data.fromKey)!
          incoming.push({
            connectionId: pc.data.id,
            fromStepId: pc.data.fromStep,
            fromKey: pc.data.fromKey,
            mol: srcProduct.produced.mul(pc.ratio),
          })
        }
        const feed = feedMol.get(step.id + '|' + sp.key) ?? Fraction.zero
        const available = incoming.reduce((acc, t) => acc.add(t.mol), feed)
        reactants.push({
          key: sp.key,
          label: sp.label,
          coefficient: sp.coefficient,
          feedMol: feed,
          incoming,
          available,
          consumed: Fraction.zero,
          remaining: Fraction.zero,
          limiting: false,
          molarMass: mm,
        })
      } else {
        products.push({
          key: sp.key,
          label: sp.label,
          coefficient: sp.coefficient,
          produced: Fraction.zero,
          transfers: [],
          transferred: Fraction.zero,
          retained: Fraction.zero,
          molarMass: mm,
        })
      }
    }

    // 反应进度 ξ = min(可用量 / 系数)，精确比较
    let extent: Fraction | null = null
    for (const r of reactants) {
      const ratio = r.available.div(new Fraction(r.coefficient))
      if (extent === null || compareFraction(ratio, extent) < 0) extent = ratio
    }
    if (extent === null) extent = Fraction.zero

    for (const r of reactants) {
      r.consumed = extent.mul(new Fraction(r.coefficient))
      r.remaining = r.available.sub(r.consumed)
      r.limiting = compareFraction(r.available.div(new Fraction(r.coefficient)), extent) === 0
      if (r.molarMass) r.remainingMass = r.remaining.mul(r.molarMass)
    }
    for (const p of products) {
      p.produced = extent.mul(new Fraction(p.coefficient))
      if (p.molarMass) p.producedMass = p.produced.mul(p.molarMass)
      for (const pc of parsed.values()) {
        if (pc.data.fromStep !== step.id || pc.data.fromKey !== p.key) continue
        p.transfers.push({
          connectionId: pc.data.id,
          toStepId: pc.data.toStep,
          toKey: pc.data.toKey,
          ratio: pc.ratio,
          mol: p.produced.mul(pc.ratio),
        })
      }
      p.transferred = p.transfers.reduce((acc, t) => acc.add(t.mol), Fraction.zero)
      p.retained = p.produced.sub(p.transferred)
    }
    accounts.push({ stepId: step.id, name: step.name, extent, reactants, products })
  }

  return { issues: [], result: { steps: accounts } }
}

