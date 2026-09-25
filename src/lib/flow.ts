import { Fraction } from './fraction'
import { compareFraction, parseDecimal, type AmountUnit, type FieldError } from './stoich'

/** 去掉全部空白后的化学式文本，用于连接匹配。 */
export function normalizeFormulaText(text: string): string {
  return text.replace(/\s+/g, '')
}

export interface FlowFeed {
  amount: string
  unit: AmountUnit
  molarMass: string
}

export interface FlowStepRow {
  side: 'left' | 'right'
  text: string
}

/** 已确认方程式 + 投料的独立步骤快照；保存后与原工作台输入脱钩。 */
export interface FlowStep {
  id: number
  name: string
  rows: FlowStepRow[]
  /** 与 rows 对齐的唯一全正配平系数 */
  coefficients: bigint[]
  /** 外部补料，按行下标存放；仅反应物行使用数量与单位 */
  feeds: Record<number, FlowFeed>
}

export interface FlowConnection {
  id: number
  fromStep: number
  /** 源步骤生成物（去空白化学式） */
  product: string
  toStep: number
  /** 目标步骤反应物（去空白化学式，必须与 product 相同） */
  reactant: string
  /** 用户录入的百分比文本 */
  percent: string
}

export interface FlowIssue {
  stepId?: number
  connectionId?: number
  message: string
}

export function stepProducts(step: FlowStep): string[] {
  return step.rows.filter((r) => r.side === 'right').map((r) => normalizeFormulaText(r.text))
}

export function stepReactants(step: FlowStep): string[] {
  return step.rows.filter((r) => r.side === 'left').map((r) => normalizeFormulaText(r.text))
}

/** 解析百分比：必须是 0 < p ≤ 100 的十进制数。 */
export function parsePercent(text: string): { value?: Fraction; error?: string } {
  const parsed = parseDecimal(text)
  if (parsed.error) return { error: parsed.error }
  const v = parsed.value!
  if (!v.isPositive()) return { error: '必须大于 0' }
  if (compareFraction(v, new Fraction(100n)) > 0) return { error: '不能超过 100' }
  return { value: v }
}

/** 校验整套流程，返回定位到步骤或连接的问题列表。 */
export function validateFlow(steps: FlowStep[], connections: FlowConnection[]): FlowIssue[] {
  const issues: FlowIssue[] = []
  const byId = new Map(steps.map((s) => [s.id, s]))
  const seen = new Set<string>()

  for (const c of connections) {
    const from = byId.get(c.fromStep)
    const to = byId.get(c.toStep)
    if (!from || !to) {
      issues.push({ connectionId: c.id, message: '连接指向的步骤已不存在，请删除该连接。' })
      continue
    }
    if (c.fromStep === c.toStep) {
      issues.push({ connectionId: c.id, stepId: c.fromStep, message: '不允许步骤自连。' })
      continue
    }
    if (!stepProducts(from).includes(c.product)) {
      issues.push({ connectionId: c.id, stepId: c.fromStep, message: `步骤「${from.name}」的生成物中没有 ${c.product}。` })
      continue
    }
    if (!stepReactants(to).includes(c.reactant)) {
      issues.push({ connectionId: c.id, stepId: c.toStep, message: `步骤「${to.name}」的反应物中没有 ${c.reactant}。` })
      continue
    }
    if (c.product !== c.reactant) {
      issues.push({
        connectionId: c.id,
        message: `只允许连接去掉空白后化学式相同的物质（${c.product} ≠ ${c.reactant}）。`,
      })
      continue
    }
    const dupKey = `${c.fromStep}|${c.product}|${c.toStep}|${c.reactant}`
    if (seen.has(dupKey)) {
      issues.push({ connectionId: c.id, message: '重复连接：同一生成物到同一反应物的连接已存在。' })
      continue
    }
    seen.add(dupKey)
    const p = parsePercent(c.percent)
    if (p.error) {
      issues.push({ connectionId: c.id, message: `分配比例：${p.error}` })
    }
  }

  // 同一生成物分配比例之和不得超过 100
  const sums = new Map<string, { total: Fraction; ids: number[] }>()
  for (const c of connections) {
    const p = parsePercent(c.percent)
    if (!p.value) continue
    const key = `${c.fromStep}|${c.product}`
    const entry = sums.get(key) ?? { total: Fraction.zero, ids: [] }
    entry.total = entry.total.add(p.value)
    entry.ids.push(c.id)
    sums.set(key, entry)
  }
  for (const [key, entry] of sums) {
    if (compareFraction(entry.total, new Fraction(100n)) > 0) {
      const [stepId, product] = key.split('|')
      const step = byId.get(Number(stepId))
      issues.push({
        stepId: Number(stepId),
        connectionId: entry.ids[entry.ids.length - 1],
        message: `步骤「${step?.name ?? stepId}」的生成物 ${product} 分配比例之和超过 100%。`,
      })
    }
  }

  // 循环依赖检测（Kahn 拓扑排序）
  const indeg = new Map<number, number>()
  const adj = new Map<number, Set<number>>()
  for (const s of steps) indeg.set(s.id, 0)
  for (const c of connections) {
    if (!byId.has(c.fromStep) || !byId.has(c.toStep) || c.fromStep === c.toStep) continue
    const set = adj.get(c.fromStep) ?? new Set<number>()
    if (!set.has(c.toStep)) {
      set.add(c.toStep)
      adj.set(c.fromStep, set)
      indeg.set(c.toStep, (indeg.get(c.toStep) ?? 0) + 1)
    }
  }
  const queue = steps.filter((s) => (indeg.get(s.id) ?? 0) === 0).map((s) => s.id)
  let processed = 0
  while (queue.length > 0) {
    const id = queue.shift()!
    processed++
    for (const next of adj.get(id) ?? []) {
      const d = (indeg.get(next) ?? 0) - 1
      indeg.set(next, d)
      if (d === 0) queue.push(next)
    }
  }
  if (processed < steps.length) {
    for (const s of steps) {
      if ((indeg.get(s.id) ?? 0) > 0) {
        issues.push({ stepId: s.id, message: `步骤「${s.name}」处于循环依赖中，无法确定计算顺序。` })
      }
    }
  }
  return issues
}

/** 依赖顺序（拓扑序）；同层保持步骤数组中的先后顺序，调序不改变结果。 */
export function topoOrder(steps: FlowStep[], connections: FlowConnection[]): number[] {
  const indeg = new Map<number, number>()
  const adj = new Map<number, Set<number>>()
  for (const s of steps) indeg.set(s.id, 0)
  for (const c of connections) {
    if (c.fromStep === c.toStep) continue
    const set = adj.get(c.fromStep) ?? new Set<number>()
    if (!set.has(c.toStep)) {
      set.add(c.toStep)
      adj.set(c.fromStep, set)
      indeg.set(c.toStep, (indeg.get(c.toStep) ?? 0) + 1)
    }
  }
  const order: number[] = []
  const queue = steps.filter((s) => (indeg.get(s.id) ?? 0) === 0).map((s) => s.id)
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const next of adj.get(id) ?? []) {
      const d = (indeg.get(next) ?? 0) - 1
      indeg.set(next, d)
      if (d === 0) queue.push(next)
    }
  }
  return order
}

export interface ReactantAccount {
  rowIndex: number
  label: string
  coefficient: bigint
  errors: FieldError[]
  /** 外部补料（mol） */
  feedMol: Fraction
  /** 上游送入明细 */
  incoming: Array<{ connectionId: number; fromStepId: number; mol: Fraction }>
  /** 可用量 = 补料 + 全部送入 */
  available: Fraction
  consumed: Fraction
  remaining: Fraction
  molarMass?: Fraction
}

export interface ProductAccount {
  rowIndex: number
  label: string
  coefficient: bigint
  errors: FieldError[]
  produced: Fraction
  transfers: Array<{ connectionId: number; toStepId: number; percent: Fraction; mol: Fraction }>
  /** 未分配部分留存 */
  retained: Fraction
  molarMass?: Fraction
  producedMass?: Fraction
}

export interface StepAccount {
  stepId: number
  reactants: ReactantAccount[]
  products: ProductAccount[]
  extent: Fraction
  /** 并列限量试剂标签 */
  limiting: string[]
  hasError: boolean
}

function parseFeed(feed: FlowFeed | undefined, isReactant: boolean): {
  mol: Fraction
  molarMass?: Fraction
  errors: FieldError[]
} {
  const errors: FieldError[] = []
  let molarMass: Fraction | undefined
  const f = feed ?? { amount: '', unit: 'mol' as AmountUnit, molarMass: '' }
  const mmText = f.molarMass.trim()
  if (mmText !== '') {
    const mm = parseDecimal(mmText)
    if (mm.error) errors.push({ field: 'molarMass', message: `摩尔质量：${mm.error}` })
    else if (!mm.value!.isPositive()) errors.push({ field: 'molarMass', message: '摩尔质量：必须为正数' })
    else molarMass = mm.value
  }
  let mol = Fraction.zero
  if (isReactant) {
    const text = f.amount.trim()
    if (text !== '') {
      const parsed = parseDecimal(text)
      if (parsed.error) {
        errors.push({ field: 'amount', message: `数量：${parsed.error}` })
      } else if (parsed.value!.isNegative()) {
        errors.push({ field: 'amount', message: '数量：不能为负数' })
      } else if (f.unit === 'g') {
        if (molarMass === undefined) {
          errors.push({ field: 'molarMass', message: '摩尔质量：按质量（g）投料时必须填写正摩尔质量' })
        } else {
          mol = parsed.value!.div(molarMass)
        }
      } else if (f.unit === 'mmol') {
        mol = parsed.value!.div(new Fraction(1000n))
      } else {
        mol = parsed.value!
      }
    } else if (f.unit === 'g' && molarMass === undefined) {
      // 空数量视为 0，不强制要求摩尔质量
    }
  }
  return { mol, molarMass, errors }
}

/**
 * 按依赖顺序计算全流程物料账。调用前须保证 validateFlow 无问题。
 * 全程使用精确有理数；剩余反应物不自动转送。
 */
export function computeFlow(
  steps: FlowStep[],
  connections: FlowConnection[],
): { order: number[]; accounts: Map<number, StepAccount> } {
  const byId = new Map(steps.map((s) => [s.id, s]))
  const order = topoOrder(steps, connections)
  const accounts = new Map<number, StepAccount>()
  const incomingByStep = new Map<number, Array<{ connectionId: number; fromStepId: number; reactant: string; mol: Fraction }>>()

  for (const stepId of order) {
    const step = byId.get(stepId)!
    const incomingList = incomingByStep.get(stepId) ?? []
    const reactants: ReactantAccount[] = []
    const products: ProductAccount[] = []
    let hasError = false

    step.rows.forEach((row, rowIndex) => {
      const coef = step.coefficients[rowIndex]
      const feed = parseFeed(step.feeds[rowIndex], row.side === 'left')
      if (feed.errors.length > 0) hasError = true
      if (row.side === 'left') {
        const key = normalizeFormulaText(row.text)
        const incoming = incomingList
          .filter((i) => i.reactant === key)
          .map((i) => ({ connectionId: i.connectionId, fromStepId: i.fromStepId, mol: i.mol }))
        let available = feed.mol
        for (const i of incoming) available = available.add(i.mol)
        reactants.push({
          rowIndex,
          label: row.text,
          coefficient: coef,
          errors: feed.errors,
          feedMol: feed.mol,
          incoming,
          available,
          consumed: Fraction.zero,
          remaining: Fraction.zero,
          molarMass: feed.molarMass,
        })
      } else {
        products.push({
          rowIndex,
          label: row.text,
          coefficient: coef,
          errors: feed.errors,
          produced: Fraction.zero,
          transfers: [],
          retained: Fraction.zero,
          molarMass: feed.molarMass,
        })
      }
    })

    // 反应进度 ξ = min(可用量 / 系数)，精确比较
    let extent: Fraction | null = null
    for (const r of reactants) {
      const ratio = r.available.div(new Fraction(r.coefficient))
      if (extent === null || compareFraction(ratio, extent) < 0) extent = ratio
    }
    const xi = extent ?? Fraction.zero
    const limiting: string[] = []
    for (const r of reactants) {
      r.consumed = xi.mul(new Fraction(r.coefficient))
      r.remaining = r.available.sub(r.consumed)
      if (compareFraction(r.available.div(new Fraction(r.coefficient)), xi) === 0) limiting.push(r.label)
    }
    for (const p of products) {
      p.produced = xi.mul(new Fraction(p.coefficient))
      if (p.molarMass) p.producedMass = p.produced.mul(p.molarMass)
    }

    // 分配生成物：按比例转送，未分配部分留存
    for (const c of connections) {
      if (c.fromStep !== stepId) continue
      const product = products.find((p) => normalizeFormulaText(p.label) === c.product)
      const percent = parsePercent(c.percent)
      if (!product || !percent.value) continue
      const mol = product.produced.mul(percent.value).div(new Fraction(100n))
      product.transfers.push({ connectionId: c.id, toStepId: c.toStep, percent: percent.value, mol })
      const list = incomingByStep.get(c.toStep) ?? []
      list.push({ connectionId: c.id, fromStepId: stepId, reactant: c.reactant, mol })
      incomingByStep.set(c.toStep, list)
    }
    for (const p of products) {
      let sent = Fraction.zero
      for (const t of p.transfers) sent = sent.add(t.mol)
      p.retained = p.produced.sub(sent)
    }

    accounts.set(stepId, { stepId, reactants, products, extent: xi, limiting, hasError })
  }
  return { order, accounts }
}
