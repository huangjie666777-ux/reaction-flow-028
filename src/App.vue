<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { parseFormula, type ParseResult } from './lib/parser'
import { Fraction } from './lib/fraction'
import { balance, type BalanceResult, type Species } from './lib/solver'
import {
  computeStoich,
  formatFraction,
  UNIT_LABELS,
  type AmountUnit,
  type StoichInput,
  type StoichResult,
  type StoichSpecies,
} from './lib/stoich'
import {
  computeFlow,
  speciesKey,
  type FeedInput,
  type FlowConnectionData,
  type FlowIssue,
  type FlowResult,
  type FlowSpecies,
  type FlowStepData,
} from './lib/flow'

interface Row {
  id: number
  text: string
}

let nextId = 1
const mkRows = (texts: string[]): Row[] => texts.map((text) => ({ id: nextId++, text }))

const leftRows = reactive<Row[]>(mkRows(['H2', 'O2']))
const rightRows = reactive<Row[]>(mkRows(['H2O']))

const EXAMPLES: Array<{ name: string; left: string[]; right: string[] }> = [
  {
    name: '普通反应（甲烷燃烧）',
    left: ['CH4', 'O2'],
    right: ['CO2', 'H2O'],
  },
  {
    name: '嵌套分组（亚铁氰化镁与氢氧化钾）',
    left: ['Mg2[Fe(CN)6]', 'KOH'],
    right: ['Mg(OH)2', 'K4[Fe(CN)6]'],
  },
  {
    name: '结晶水（五水硫酸铜脱水）',
    left: ['CuSO4·5H2O'],
    right: ['CuSO4', 'H2O'],
  },
  {
    name: '离子-电子反应（高锰酸根还原）',
    left: ['MnO4^-', 'H^+', 'e^-'],
    right: ['Mn^2+', 'H2O'],
  },
]

interface Snapshot {
  rows: { side: 'left' | 'right'; text: string; id: number }[]
  result: BalanceResult
  elementOrder: string[]
}

const snapshot = ref<Snapshot | null>(null)
const dirty = ref(false)
const highlightedElement = ref<string | null>(null)
const copyState = ref<'idle' | 'ok' | 'fail'>('idle')
const globalMessage = ref('')

interface RowParse {
  result: ParseResult
}

function parseRow(text: string): RowParse {
  return { result: parseFormula(text) }
}

const leftParsed = computed(() => leftRows.map((r) => ({ row: r, ...parseRow(r.text) })))
const rightParsed = computed(() => rightRows.map((r) => ({ row: r, ...parseRow(r.text) })))

const parseErrors = computed(() => {
  const errs: { side: 'left' | 'right'; id: number; text: string; message: string; pos: number }[] = []
  for (const p of leftParsed.value) {
    if (p.row.text.trim() !== '' && !p.result.ok) {
      errs.push({
        side: 'left',
        id: p.row.id,
        text: p.row.text,
        message: p.result.error.message,
        pos: p.result.error.pos,
      })
    }
  }
  for (const p of rightParsed.value) {
    if (p.row.text.trim() !== '' && !p.result.ok) {
      errs.push({
        side: 'right',
        id: p.row.id,
        text: p.row.text,
        message: p.result.error.message,
        pos: p.result.error.pos,
      })
    }
  }
  return errs
})

const canBalance = computed(
  () =>
    leftRows.some((r) => r.text.trim() !== '') &&
    rightRows.some((r) => r.text.trim() !== '') &&
    parseErrors.value.length === 0,
)

function addRow(side: 'left' | 'right') {
  const rows = side === 'left' ? leftRows : rightRows
  rows.push({ id: nextId++, text: '' })
  dirty.value = true
}

function removeRow(side: 'left' | 'right', id: number) {
  const rows = side === 'left' ? leftRows : rightRows
  const idx = rows.findIndex((r) => r.id === id)
  if (idx >= 0) rows.splice(idx, 1)
  dirty.value = true
}

function moveRow(side: 'left' | 'right', id: number, delta: -1 | 1) {
  const rows = side === 'left' ? leftRows : rightRows
  const idx = rows.findIndex((r) => r.id === id)
  const target = idx + delta
  if (idx < 0 || target < 0 || target >= rows.length) return
  const [item] = rows.splice(idx, 1)
  rows.splice(target, 0, item)
  dirty.value = true
}

function onInput() {
  dirty.value = true
}

function doBalance() {
  if (!canBalance.value) return
  const species: Species[] = []
  const rowsSnapshot: Snapshot['rows'] = []
  for (const p of leftParsed.value) {
    if (p.row.text.trim() === '' || !p.result.ok) continue
    species.push({ raw: p.row.text.trim(), formula: p.result.formula!, side: 'left' })
    rowsSnapshot.push({ side: 'left', text: p.row.text, id: p.row.id })
  }
  for (const p of rightParsed.value) {
    if (p.row.text.trim() === '' || !p.result.ok) continue
    species.push({ raw: p.row.text.trim(), formula: p.result.formula!, side: 'right' })
    rowsSnapshot.push({ side: 'right', text: p.row.text, id: p.row.id })
  }
  const result = balance(species)
  const elementOrder: string[] = []
  const seen = new Set<string>()
  for (const sp of species) {
    for (const el of Object.keys(sp.formula.elements)) {
      if (!seen.has(el)) {
        seen.add(el)
        elementOrder.push(el)
      }
    }
  }
  snapshot.value = { rows: rowsSnapshot, result, elementOrder }
  dirty.value = false
  highlightedElement.value = null
  globalMessage.value = ''
}

function loadExample(ex: (typeof EXAMPLES)[number]) {
  leftRows.splice(0, leftRows.length, ...mkRows(ex.left))
  rightRows.splice(0, rightRows.length, ...mkRows(ex.right))
  dirty.value = true
  globalMessage.value = `已载入示例：${ex.name}，点击「配平」查看结果。`
}

const stale = computed(() => dirty.value || parseErrors.value.length > 0)

const equationText = computed(() => {
  const snap = snapshot.value
  if (!snap || snap.result.kind !== 'unique') return ''
  const coef = snap.result.coefficients
  const parts = snap.rows.map((r, i) => {
    const c = coef[i]
    return c === 1n ? r.text : `${c}${r.text.replace(/\s+/g, '')}`
  })
  const left = parts
    .filter((_, i) => snap.rows[i].side === 'left')
    .join(' + ')
  const right = parts
    .filter((_, i) => snap.rows[i].side === 'right')
    .join(' + ')
  return `${left} → ${right}`
})

interface CheckRow {
  label: string
  left: bigint
  right: bigint
  balanced: boolean
}

const checkTable = computed<CheckRow[]>(() => {
  const snap = snapshot.value
  if (!snap || snap.result.kind !== 'unique') return []
  const coef = snap.result.coefficients
  const rows: CheckRow[] = snap.elementOrder.map((el) => {
    let left = 0n
    let right = 0n
    snap.rows.forEach((r, i) => {
      const parsed = parseFormula(r.text)
      if (!parsed.ok) return
      const n = parsed.formula.elements[el] ?? 0n
      if (r.side === 'left') left += n * coef[i]
      else right += n * coef[i]
    })
    return { label: el, left, right, balanced: left === right }
  })
  let leftCharge = 0n
  let rightCharge = 0n
  snap.rows.forEach((r, i) => {
    const parsed = parseFormula(r.text)
    if (!parsed.ok) return
    if (r.side === 'left') leftCharge += parsed.formula.charge * coef[i]
    else rightCharge += parsed.formula.charge * coef[i]
  })
  rows.push({ label: '电荷', left: leftCharge, right: rightCharge, balanced: leftCharge === rightCharge })
  return rows
})

function contribution(text: string, element: string): bigint | null {
  const r = parseFormula(text)
  if (!r.ok) return null
  return r.formula.elements[element] ?? null
}

async function copyEquation() {
  if (!equationText.value) return
  try {
    await navigator.clipboard.writeText(equationText.value)
    copyState.value = 'ok'
  } catch {
    copyState.value = 'fail'
  }
  setTimeout(() => (copyState.value = 'idle'), 2000)
}

function formatCharge(n: bigint): string {
  if (n === 0n) return '0'
  const sign = n > 0n ? '+' : '-'
  const mag = n < 0n ? -n : n
  return mag === 1n ? sign : `${mag}${sign}`
}

/* ---------- 投料方案与限量试剂 ---------- */

interface PlanInput {
  amount: string
  unit: AmountUnit
}

interface Plan {
  id: number
  name: string
  /** 按物质行 id 存放，物质调序时投料随之移动 */
  inputs: Record<number, PlanInput>
  molarMasses: Record<number, string>
  result: StoichResult | null
  /** 投料被编辑后结果失效 */
  stale: boolean
}

let nextPlanId = 1
const plans = reactive<Plan[]>([])
const activePlanId = ref<number | null>(null)

const activePlan = computed(() => plans.find((p) => p.id === activePlanId.value) ?? null)

const fmt = formatFraction
const unitLabels = UNIT_LABELS

const hasElectron = computed(() => {
  const snap = snapshot.value
  if (!snap) return false
  return snap.rows.some((r) => {
    const parsed = parseFormula(r.text)
    return parsed.ok && parsed.formula.isElectron
  })
})

const stoichSpecies = computed<StoichSpecies[]>(() => {
  const snap = snapshot.value
  if (!snap || snap.result.kind !== 'unique') return []
  const coef = snap.result.coefficients
  return snap.rows.map((r, i) => ({ id: r.id, side: r.side, label: r.text, coefficient: coef[i] }))
})

function createPlan(name?: string): Plan {
  const plan: Plan = {
    id: nextPlanId,
    name: name ?? '方案 ' + nextPlanId,
    inputs: {},
    molarMasses: {},
    result: null,
    stale: false,
  }
  nextPlanId++
  plans.push(plan)
  activePlanId.value = plan.id
  return plan
}

function planInput(plan: Plan, rowId: number): PlanInput {
  if (!plan.inputs[rowId]) plan.inputs[rowId] = { amount: '', unit: 'mol' }
  return plan.inputs[rowId]
}

function markPlanStale(plan: Plan) {
  plan.stale = true
}

function duplicatePlan(plan: Plan) {
  const copy = createPlan(plan.name + '（副本）')
  copy.inputs = JSON.parse(JSON.stringify(plan.inputs))
  copy.molarMasses = { ...plan.molarMasses }
  copy.result = null
  copy.stale = false
}

function deletePlan(plan: Plan) {
  const idx = plans.findIndex((p) => p.id === plan.id)
  if (idx >= 0) plans.splice(idx, 1)
  if (activePlanId.value === plan.id) activePlanId.value = plans[0]?.id ?? null
}

function computeActivePlan() {
  const plan = activePlan.value
  const snap = snapshot.value
  if (!plan || !snap || snap.result.kind !== 'unique' || stale.value || hasElectron.value) return
  const inputs = new Map<number, StoichInput>()
  for (const sp of stoichSpecies.value) {
    const pi = plan.inputs[sp.id] ?? { amount: '', unit: 'mol' as AmountUnit }
    inputs.set(sp.id, { amount: pi.amount, unit: pi.unit, molarMass: plan.molarMasses[sp.id] ?? '' })
  }
  plan.result = computeStoich(stoichSpecies.value, inputs)
  plan.stale = false
}

function planResultValid(plan: Plan): boolean {
  return plan.result !== null && !plan.stale && !stale.value
}

const comparablePlans = computed(() =>
  plans.filter((p) => planResultValid(p) && p.result !== null && !p.result.hasError),
)

const productLabels = computed(() =>
  stoichSpecies.value.filter((sp) => sp.side === 'right').map((sp) => sp.label),
)

function errorsFor(plan: Plan, rowId: number, field: 'amount' | 'molarMass'): string[] {
  if (!plan.result || plan.stale) return []
  const entry = plan.result.entries.find((e) => e.species.id === rowId)
  return entry ? entry.errors.filter((e) => e.field === field).map((e) => e.message) : []
}

function hasFieldError(plan: Plan, rowId: number, field: 'amount' | 'molarMass'): boolean {
  return errorsFor(plan, rowId, field).length > 0
}

function limitingText(result: StoichResult): string {
  return result.limiting.map((i) => result.entries[i].species.label).join('、')
}

function productYieldText(plan: Plan, label: string): string {
  const entry = plan.result?.entries.find((e) => e.species.side === 'right' && e.species.label === label)
  if (!entry || !entry.produced) return '—'
  let text = fmt(entry.produced).text + ' mol'
  if (entry.mass) text += '（' + fmt(entry.mass).text + ' g）'
  return text
}

function fillStoichExample(kind: 'exact' | 'excess') {
  const plan = createPlan(kind === 'exact' ? '示例：恰好配比' : '示例：试剂过量')
  let firstLeftSeen = false
  for (const sp of stoichSpecies.value) {
    if (sp.side !== 'left') continue
    let amount = sp.coefficient
    if (kind === 'excess' && !firstLeftSeen) amount = sp.coefficient * 2n
    firstLeftSeen = true
    plan.inputs[sp.id] = { amount: amount.toString(), unit: 'mol' }
  }
  plan.stale = true
  globalMessage.value =
    kind === 'exact'
      ? '已生成「恰好配比」示例方案：各反应物投料 = 系数 mol，点击「计算投料结果」查看。'
      : '已生成「试剂过量」示例方案：第一种反应物加倍、其余按系数投料，点击「计算投料结果」查看。'
}

function coefFor(side: 'left' | 'right', indexWithinSide: number): bigint | null {
  const snap = snapshot.value
  if (!snap || snap.result.kind !== 'unique') return null
  let globalIdx = 0
  for (let i = 0; i < snap.rows.length; i++) {
    if (snap.rows[i].side === side) {
      if (globalIdx === indexWithinSide) return snap.result.coefficients[i]
      globalIdx++
    }
  }
  return null
}


/* ---------- 多步反应流程 ---------- */

let nextStepId = 1
let nextConnId = 1
const flowSteps = reactive<FlowStepData[]>([])
const flowConnections = reactive<FlowConnectionData[]>([])
const flowStale = ref(false)
const flowOutcome = ref<{ issues: FlowIssue[]; result: FlowResult | null } | null>(null)

const canSaveStep = computed(
  () => snapshot.value !== null && snapshot.value.result.kind === 'unique' && !stale.value && !hasElectron.value,
)

function markFlowStale() {
  if (flowOutcome.value) flowStale.value = true
}

function saveFlowStep() {
  const snap = snapshot.value
  if (!snap || snap.result.kind !== 'unique' || stale.value || hasElectron.value) return
  const coef = snap.result.coefficients
  const species: FlowSpecies[] = snap.rows.map((r, i) => ({
    key: speciesKey(r.text),
    label: r.text.trim(),
    side: r.side,
    coefficient: coef[i],
  }))
  const seenKeys = new Set<string>()
  for (const sp of species) {
    const k = sp.side + '|' + sp.key
    if (seenKeys.has(k)) {
      globalMessage.value = `无法保存为流程步骤：同侧存在重复物质 ${sp.key}，请先调整。`
      return
    }
    seenKeys.add(k)
  }
  flowSteps.push({ id: nextStepId, name: `步骤 ${nextStepId}`, species, feeds: {}, molarMasses: {} })
  nextStepId++
  markFlowStale()
  globalMessage.value = '已把当前反应保存为独立的流程步骤快照；此后上方工作台的修改不会影响它。'
}

function stepEquation(species: FlowSpecies[]): string {
  const part = (sp: FlowSpecies) => (sp.coefficient === 1n ? sp.label : `${sp.coefficient}${sp.label}`)
  const left = species.filter((sp) => sp.side === 'left').map(part).join(' + ')
  const right = species.filter((sp) => sp.side === 'right').map(part).join(' + ')
  return `${left} → ${right}`
}

function moveFlowStep(id: number, delta: -1 | 1) {
  const idx = flowSteps.findIndex((s) => s.id === id)
  const target = idx + delta
  if (idx < 0 || target < 0 || target >= flowSteps.length) return
  const [item] = flowSteps.splice(idx, 1)
  flowSteps.splice(target, 0, item)
  // 调序只改变展示顺序，不改变物质绑定与计算结果，无需失效
}

function deleteFlowStep(step: FlowStepData) {
  const idx = flowSteps.findIndex((s) => s.id === step.id)
  if (idx >= 0) flowSteps.splice(idx, 1)
  for (let i = flowConnections.length - 1; i >= 0; i--) {
    if (flowConnections[i].fromStep === step.id || flowConnections[i].toStep === step.id) {
      flowConnections.splice(i, 1)
    }
  }
  markFlowStale()
}

function feedFor(step: FlowStepData, key: string): FeedInput {
  if (!step.feeds[key]) step.feeds[key] = { amount: '', unit: 'mol' }
  return step.feeds[key]
}

const connForm = reactive<{ fromStep: number | null; fromKey: string; toStep: number | null; percent: string }>({
  fromStep: null,
  fromKey: '',
  toStep: null,
  percent: '',
})

const connSourceProducts = computed(
  () => flowSteps.find((s) => s.id === connForm.fromStep)?.species.filter((sp) => sp.side === 'right') ?? [],
)

const connTargetSteps = computed(() => flowSteps.filter((s) => s.id !== connForm.fromStep))

const connTargetReactants = computed(() => {
  const target = flowSteps.find((s) => s.id === connForm.toStep)
  if (!target || !connForm.fromKey) return []
  return target.species.filter((sp) => sp.side === 'left' && sp.key === connForm.fromKey)
})

function addFlowConnection() {
  const target = connTargetReactants.value[0]
  if (connForm.fromStep === null || !connForm.fromKey || connForm.toStep === null || !target) return
  flowConnections.push({
    id: nextConnId++,
    fromStep: connForm.fromStep,
    fromKey: connForm.fromKey,
    toStep: connForm.toStep,
    toKey: target.key,
    percent: connForm.percent,
  })
  connForm.percent = ''
  markFlowStale()
}

function deleteFlowConnection(id: number) {
  const idx = flowConnections.findIndex((c) => c.id === id)
  if (idx >= 0) flowConnections.splice(idx, 1)
  markFlowStale()
}

function stepName(id: number): string {
  return flowSteps.find((s) => s.id === id)?.name ?? `#${id}`
}

function computeFlowAll() {
  flowOutcome.value = computeFlow(flowSteps, flowConnections)
  flowStale.value = false
}

const flowResultVisible = computed(() => flowOutcome.value !== null && !flowStale.value)

function connIssues(id: number): FlowIssue[] {
  if (!flowOutcome.value || flowStale.value) return []
  return flowOutcome.value.issues.filter((i) => i.connectionId === id)
}

function stepIssues(id: number): FlowIssue[] {
  if (!flowOutcome.value || flowStale.value) return []
  return flowOutcome.value.issues.filter((i) => i.stepId === id)
}

const flowGlobalIssues = computed(() =>
  !flowOutcome.value || flowStale.value
    ? []
    : flowOutcome.value.issues.filter((i) => i.scope === 'flow'),
)

function pctText(ratio: Fraction): string {
  return fmt(ratio.mul(new Fraction(100n))).text
}

function loadFlowExample() {
  flowSteps.splice(0, flowSteps.length)
  flowConnections.splice(0, flowConnections.length)
  flowOutcome.value = null
  flowStale.value = false
  const mk = (
    name: string,
    left: Array<[string, bigint]>,
    right: Array<[string, bigint]>,
    feeds: Record<string, FeedInput>,
  ): FlowStepData => {
    const step: FlowStepData = {
      id: nextStepId++,
      name,
      species: [
        ...left.map(([key, coefficient]) => ({ key, label: key, side: 'left' as const, coefficient })),
        ...right.map(([key, coefficient]) => ({ key, label: key, side: 'right' as const, coefficient })),
      ],
      feeds,
      molarMasses: {},
    }
    flowSteps.push(step)
    return step
  }
  const s1 = mk(
    '蒸汽重整',
    [['CH4', 1n], ['H2O', 1n]],
    [['CO', 1n], ['H2', 3n]],
    { CH4: { amount: '2', unit: 'mol' }, H2O: { amount: '3', unit: 'mol' } },
  )
  const s2 = mk('甲醇合成', [['CO', 1n], ['H2', 2n]], [['CH3OH', 1n]], {})
  const s3 = mk(
    '电解水',
    [['H2O', 2n]],
    [['H2', 2n], ['O2', 1n]],
    { H2O: { amount: '4', unit: 'mol' } },
  )
  flowConnections.push(
    { id: nextConnId++, fromStep: s1.id, fromKey: 'CO', toStep: s2.id, toKey: 'CO', percent: '100' },
    { id: nextConnId++, fromStep: s1.id, fromKey: 'H2', toStep: s2.id, toKey: 'H2', percent: '50' },
    { id: nextConnId++, fromStep: s3.id, fromKey: 'H2', toStep: s2.id, toKey: 'H2', percent: '100' },
  )
  globalMessage.value =
    '已载入多步示例（含分流与合流）：蒸汽重整的 CO 全部、H2 的 50% 送入甲醇合成，电解水的 H2 全部合流进甲醇合成。假设每步完全反应且无副反应。点击「计算全流程」查看结果。'
}

function onRowKeydown(e: KeyboardEvent, side: 'left' | 'right', id: number, index: number) {
  if (e.key === 'Enter') {
    e.preventDefault()
    const rows = side === 'left' ? leftRows : rightRows
    if (index === rows.length - 1) {
      addRow(side)
      requestAnimationFrame(() => {
        const inputs = document.querySelectorAll<HTMLInputElement>(`[data-side="${side}"] .formula-input`)
        inputs[inputs.length - 1]?.focus()
      })
    } else {
      const inputs = document.querySelectorAll<HTMLInputElement>(`[data-side="${side}"] .formula-input`)
      inputs[index + 1]?.focus()
    }
  } else if (e.key === 'Backspace' && (e.target as HTMLInputElement).value === '' && rowsCount(side) > 1) {
    e.preventDefault()
    removeRow(side, id)
  }
}

function rowsCount(side: 'left' | 'right'): number {
  return (side === 'left' ? leftRows : rightRows).length
}

function onGlobalKey(e: KeyboardEvent) {
  if (e.altKey && (e.key === 'b' || e.key === 'B')) {
    e.preventDefault()
    doBalance()
  }
}

onMounted(() => window.addEventListener('keydown', onGlobalKey))
onUnmounted(() => window.removeEventListener('keydown', onGlobalKey))
</script>

<template>
  <main class="app">
    <header class="app-header">
      <h1>化学方程式配平与守恒核对工作台</h1>
      <p class="hint">
        本地精确整数/有理数求解 · 支持多层括号、结晶水、电荷与电子 e^- · 数据不离开浏览器
      </p>
    </header>

    <section class="examples" aria-label="示例">
      <span class="examples-label">载入示例：</span>
      <button
        v-for="ex in EXAMPLES"
        :key="ex.name"
        type="button"
        class="example-btn"
        @click="loadExample(ex)"
      >
        {{ ex.name }}
      </button>
    </section>

    <section class="columns">
      <div class="column" data-side="left">
        <h2>反应物</h2>
        <div
          v-for="(p, index) in leftParsed"
          :key="p.row.id"
          class="row"
          :class="{ invalid: p.row.text.trim() !== '' && !p.result.ok, dimmed: highlightedElement !== null && contribution(p.row.text, highlightedElement) === null }"
        >
          <input
            v-model="p.row.text"
            class="formula-input"
            :aria-label="`反应物 ${index + 1}`"
            :aria-invalid="!p.result.ok"
            placeholder="如 H2、Ca(OH)2、SO4^2-"
            @input="onInput"
            @keydown="onRowKeydown($event, 'left', p.row.id, index)"
          />
          <span v-if="snapshot && snapshot.result.kind === 'unique' && !stale" class="coef">
            {{ coefFor('left', index) }}
          </span>
          <div class="row-tools">
            <button type="button" :disabled="index === 0" @click="moveRow('left', p.row.id, -1)">↑</button>
            <button
              type="button"
              :disabled="index === leftRows.length - 1"
              @click="moveRow('left', p.row.id, 1)"
            >
              ↓
            </button>
            <button type="button" @click="removeRow('left', p.row.id)">删除</button>
          </div>
          <p v-if="p.row.text.trim() !== '' && !p.result.ok" class="error" role="alert">
            位置 {{ p.result.error.pos + 1 }}：{{ p.result.error.message }}
          </p>
        </div>
        <button type="button" class="add-btn" @click="addRow('left')">+ 添加反应物</button>
      </div>

      <div class="equals" aria-hidden="true">→</div>

      <div class="column" data-side="right">
        <h2>生成物</h2>
        <div
          v-for="(p, index) in rightParsed"
          :key="p.row.id"
          class="row"
          :class="{ invalid: p.row.text.trim() !== '' && !p.result.ok, dimmed: highlightedElement !== null && contribution(p.row.text, highlightedElement) === null }"
        >
          <input
            v-model="p.row.text"
            class="formula-input"
            :aria-label="`生成物 ${index + 1}`"
            :aria-invalid="!p.result.ok"
            placeholder="如 H2O、CuSO4·5H2O、e^-"
            @input="onInput"
            @keydown="onRowKeydown($event, 'right', p.row.id, index)"
          />
          <span v-if="snapshot && snapshot.result.kind === 'unique' && !stale" class="coef">
            {{ coefFor('right', index) }}
          </span>
          <div class="row-tools">
            <button type="button" :disabled="index === 0" @click="moveRow('right', p.row.id, -1)">↑</button>
            <button
              type="button"
              :disabled="index === rightRows.length - 1"
              @click="moveRow('right', p.row.id, 1)"
            >
              ↓
            </button>
            <button type="button" @click="removeRow('right', p.row.id)">删除</button>
          </div>
          <p v-if="p.row.text.trim() !== '' && !p.result.ok" class="error" role="alert">
            位置 {{ p.result.error.pos + 1 }}：{{ p.result.error.message }}
          </p>
        </div>
        <button type="button" class="add-btn" @click="addRow('right')">+ 添加生成物</button>
      </div>
    </section>

    <section class="actions">
      <button type="button" class="balance-btn" :disabled="!canBalance" @click="doBalance">
        配平（Alt+B）
      </button>
      <button
        type="button"
        :disabled="!equationText || stale"
        @click="copyEquation"
      >
        复制纯文本方程式
      </button>
      <span v-if="copyState === 'ok'" class="copy-ok">已复制</span>
      <span v-if="copyState === 'fail'" class="error">复制失败，请手动选择文本</span>
      <p v-if="!canBalance" class="hint">需要两侧都有非空物质，且全部解析通过后才能配平。</p>
    </section>

    <section v-if="globalMessage" class="banner info" role="status">{{ globalMessage }}</section>

    <section v-if="stale && snapshot" class="banner warn" role="status">
      输入已修改或存在解析错误，以下结果已失效，不再代表当前输入。请重新点击「配平」。
    </section>

    <section v-if="snapshot && !stale" class="results">
      <template v-if="snapshot.result.kind === 'unique'">
        <h2>配平结果</h2>
        <pre class="equation">{{ equationText }}</pre>

        <h2>守恒核对表</h2>
        <p class="hint">点击元素名称可突出该元素在各物质中的贡献；再次点击取消。</p>
        <table class="check-table">
          <thead>
            <tr>
              <th>项目</th>
              <th>反应物总计（系数 × 原子数）</th>
              <th>生成物总计</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in checkTable"
              :key="row.label"
              :class="{ highlighted: highlightedElement === row.label }"
            >
              <td>
                <button
                  v-if="row.label !== '电荷'"
                  type="button"
                  class="el-btn"
                  @click="highlightedElement = highlightedElement === row.label ? null : row.label"
                >
                  {{ row.label }}
                </button>
                <span v-else>电荷</span>
              </td>
              <td>{{ row.label === '电荷' ? formatCharge(row.left) : row.left }}</td>
              <td>{{ row.label === '电荷' ? formatCharge(row.right) : row.right }}</td>
              <td :class="row.balanced ? 'ok' : 'error'">
                {{ row.balanced ? '守恒 ✓' : '不守恒 ✗' }}
              </td>
            </tr>
          </tbody>
        </table>

        <div v-if="highlightedElement" class="contrib-panel">
          <h3>「{{ highlightedElement }}」在各物质中的单份含量</h3>
          <ul>
            <li
              v-for="(r, i) in snapshot.rows"
              :key="i"
              :class="{ zero: contribution(r.text, highlightedElement) === null || contribution(r.text, highlightedElement) === 0n }"
            >
              <span class="side-tag">{{ r.side === 'left' ? '反应物' : '生成物' }}</span>
              {{ r.text }}：{{ contribution(r.text, highlightedElement) ?? 0 }} 个
              （计入总数时再乘系数 {{ snapshot.result.kind === 'unique' ? snapshot.result.coefficients[i] : '' }}）
            </li>
          </ul>
        </div>
      </template>

      <div v-else-if="snapshot.result.kind === 'no-solution'" class="banner bad" role="alert">
        <strong>无解：</strong>{{ snapshot.result.reason }}
      </div>
      <div v-else-if="snapshot.result.kind === 'has-nonpositive'" class="banner bad" role="alert">
        <strong>不能配平为全正系数：</strong>{{ snapshot.result.reason }}
        <p>唯一解（取绝对值，仅作核对）：{{ snapshot.result.sample.join('、') }}</p>
      </div>
    <div v-else-if="snapshot.result.kind === 'infinite'" class="banner bad" role="alert">
        <strong>解不唯一：</strong>{{ snapshot.result.reason }}
      </div>
    </section>

    <section v-if="snapshot && snapshot.result.kind === 'unique'" class="stoich-section" aria-label="投料方案">
      <h2>限量试剂与投料方案</h2>
      <div v-if="hasElectron" class="banner info" role="status">
        当前反应含有电子 e^-（半反应），投料与限量试剂计算不适用。
      </div>
      <template v-else>
        <div v-if="stale" class="banner warn" role="status">
          物质已增删或化学式已修改，所有投料方案的结果已失效。请重新点击「配平」，核对各方案输入后重新计算。
        </div>

        <div class="plan-bar">
          <button
            v-for="p in plans"
            :key="p.id"
            type="button"
            class="plan-tab"
            :class="{ active: p.id === activePlanId }"
            @click="activePlanId = p.id"
          >
            {{ p.name }}<template v-if="p.result && !planResultValid(p)">（已失效）</template>
          </button>
          <button type="button" class="example-btn" @click="createPlan()">+ 新建方案</button>
          <button type="button" class="example-btn" :disabled="stale" @click="fillStoichExample('exact')">
            示例：恰好配比
          </button>
          <button type="button" class="example-btn" :disabled="stale" @click="fillStoichExample('excess')">
            示例：试剂过量
          </button>
        </div>

        <div v-if="activePlan" class="plan-body">
          <div class="plan-tools">
            <label>
              方案名：
              <input v-model="activePlan.name" class="plan-name-input" aria-label="方案名称" />
            </label>
            <button type="button" @click="duplicatePlan(activePlan)">复制方案</button>
            <button type="button" @click="deletePlan(activePlan)">删除方案</button>
          </div>

          <table class="stoich-table">
            <thead>
              <tr>
                <th>物质</th>
                <th>系数</th>
                <th>投料数量</th>
                <th>单位</th>
                <th>摩尔质量 (g/mol，选填)</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="sp in stoichSpecies" :key="sp.id">
                <td>
                  <span class="side-tag">{{ sp.side === 'left' ? '反应物' : '生成物' }}</span>
                  {{ sp.label }}
                </td>
                <td>{{ sp.coefficient }}</td>
                <template v-if="sp.side === 'left'">
                  <td>
                    <input
                      v-model="planInput(activePlan, sp.id).amount"
                      class="amount-input"
                      :class="{ invalid: hasFieldError(activePlan, sp.id, 'amount') }"
                      :aria-label="sp.label + ' 投料数量'"
                      :aria-invalid="hasFieldError(activePlan, sp.id, 'amount')"
                      placeholder="如 1.5"
                      @input="markPlanStale(activePlan)"
                      @keydown.enter="computeActivePlan"
                    />
                    <p
                      v-for="err in errorsFor(activePlan, sp.id, 'amount')"
                      :key="err"
                      class="error"
                      role="alert"
                    >
                      {{ err }}
                    </p>
                  </td>
                  <td>
                    <select
                      v-model="planInput(activePlan, sp.id).unit"
                      :aria-label="sp.label + ' 单位'"
                      @change="markPlanStale(activePlan)"
                    >
                      <option v-for="(label, u) in unitLabels" :key="u" :value="u">{{ label }}</option>
                    </select>
                  </td>
                </template>
                <template v-else>
                  <td colspan="2" class="hint">生成物无需投料</td>
                </template>
                <td>
                  <input
                    v-model="activePlan.molarMasses[sp.id]"
                    class="amount-input"
                    :class="{ invalid: hasFieldError(activePlan, sp.id, 'molarMass') }"
                    :aria-label="sp.label + ' 摩尔质量'"
                    :aria-invalid="hasFieldError(activePlan, sp.id, 'molarMass')"
                    placeholder="选填"
                    @input="markPlanStale(activePlan)"
                    @keydown.enter="computeActivePlan"
                  />
                  <p
                    v-for="err in errorsFor(activePlan, sp.id, 'molarMass')"
                    :key="err"
                    class="error"
                    role="alert"
                  >
                    {{ err }}
                  </p>
                </td>
              </tr>
            </tbody>
          </table>

          <div class="actions">
            <button type="button" class="balance-btn" :disabled="stale" @click="computeActivePlan">
              计算投料结果
            </button>
            <span class="hint">数量支持普通十进制数；空值、负数与非法文本会定位提示，不会被当作 0。</span>
          </div>

          <p v-if="activePlan.result && activePlan.stale" class="banner warn" role="status">
            投料已修改，该方案结果已失效，请重新计算。
          </p>

          <div v-if="activePlan.result && planResultValid(activePlan)" class="plan-result">
            <div v-if="activePlan.result.hasError" class="banner bad" role="alert">
              输入存在错误，请根据各字段下方提示修正后重新计算。
            </div>
            <template v-else>
              <p class="limiting-line">
                <strong>限量试剂：</strong>{{ limitingText(activePlan.result) }}
                （反应进度 ξ = {{ fmt(activePlan.result.extent!).text }} mol）
              </p>
              <p class="hint">
                假设：反应完全进行且无副反应，理论产量 = ξ × 系数。内部以精确有理数比较与运算，仅显示时保留
                6 位有效数字，「≈」表示经舍入；并列限量与零剩余均由精确值判定。
              </p>

              <h3>换算与比例依据（反应物）</h3>
              <table class="stoich-table">
                <thead>
                  <tr>
                    <th>物质</th>
                    <th>投料 (mol)</th>
                    <th>系数</th>
                    <th>n / 系数 (mol)</th>
                    <th>消耗 (mol)</th>
                    <th>剩余 (mol)</th>
                    <th>剩余质量 (g)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="entry in activePlan.result.entries.filter((e) => e.species.side === 'left')"
                    :key="entry.species.id"
                    :class="{ limiting: activePlan.result!.limiting.includes(activePlan.result!.entries.indexOf(entry)) }"
                  >
                    <td>{{ entry.species.label }}</td>
                    <td>{{ fmt(entry.mol!).text }}</td>
                    <td>{{ entry.species.coefficient }}</td>
                    <td>{{ fmt(entry.ratio!).text }}</td>
                    <td>{{ fmt(entry.consumed!).text }}</td>
                    <td>{{ fmt(entry.remaining!).text }}</td>
                    <td>{{ entry.mass ? fmt(entry.mass).text : '—' }}</td>
                  </tr>
                </tbody>
              </table>

              <h3>生成物理论产量</h3>
              <table class="stoich-table">
                <thead>
                  <tr>
                    <th>物质</th>
                    <th>系数</th>
                    <th>理论产量 (mol)</th>
                    <th>理论产量 (g)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="entry in activePlan.result.entries.filter((e) => e.species.side === 'right')"
                    :key="entry.species.id"
                  >
                    <td>{{ entry.species.label }}</td>
                    <td>{{ entry.species.coefficient }}</td>
                    <td>{{ fmt(entry.produced!).text }}</td>
                    <td>{{ entry.mass ? fmt(entry.mass).text : '—（未填摩尔质量）' }}</td>
                  </tr>
                </tbody>
              </table>
            </template>
          </div>
        </div>
        <p v-else class="hint">还没有投料方案。点击「+ 新建方案」，或载入「恰好配比 / 试剂过量」示例。</p>

        <div v-if="comparablePlans.length > 0" class="compare-block">
          <h3>方案对比（仅列结果有效的方案）</h3>
          <table class="stoich-table">
            <thead>
              <tr>
                <th>项目</th>
                <th v-for="p in comparablePlans" :key="p.id">{{ p.name }}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>限量试剂</td>
                <td v-for="p in comparablePlans" :key="p.id">{{ limitingText(p.result!) }}</td>
              </tr>
              <tr v-for="label in productLabels" :key="label">
                <td>{{ label }} 理论产量</td>
                <td v-for="p in comparablePlans" :key="p.id">{{ productYieldText(p, label) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </section>

    <section class="flow-section" aria-label="多步反应流程">
      <h2>多步反应流程</h2>
      <p class="hint">
        把上方已确认的反应保存为独立步骤快照，再把某步的生成物按比例分配给后续步骤的反应物（分流 / 合流）。
        假设每步反应完全进行且无副反应；全流程使用精确有理数计算，仅显示时舍入。
      </p>
      <div class="actions">
        <button type="button" class="balance-btn" :disabled="!canSaveStep" @click="saveFlowStep">
          保存当前反应为流程步骤
        </button>
        <button type="button" class="example-btn" @click="loadFlowExample">载入多步示例（分流 + 合流）</button>
        <span v-if="!canSaveStep" class="hint">需先配平出唯一全正解且不含电子 e^-，才能保存为步骤。</span>
      </div>

      <div v-if="flowSteps.length === 0" class="hint">还没有流程步骤。</div>

      <div v-for="(step, si) in flowSteps" :key="step.id" class="flow-step">
        <div class="flow-step-head">
          <input v-model="step.name" class="plan-name-input" :aria-label="'步骤 ' + (si + 1) + ' 名称'" @input="markFlowStale" />
          <span class="flow-eq">{{ stepEquation(step.species) }}</span>
          <span class="row-tools">
            <button type="button" :disabled="si === 0" @click="moveFlowStep(step.id, -1)">↑</button>
            <button type="button" :disabled="si === flowSteps.length - 1" @click="moveFlowStep(step.id, 1)">↓</button>
            <button type="button" @click="deleteFlowStep(step)">删除步骤</button>
          </span>
        </div>
        <p v-for="issue in stepIssues(step.id)" :key="issue.message" class="error" role="alert">{{ issue.message }}</p>
        <table class="stoich-table">
          <thead>
            <tr>
              <th>物质</th>
              <th>系数</th>
              <th>外部补料</th>
              <th>单位</th>
              <th>摩尔质量 (g/mol，选填)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="sp in step.species" :key="sp.side + sp.key">
              <td>
                <span class="side-tag">{{ sp.side === 'left' ? '反应物' : '生成物' }}</span>
                {{ sp.label }}
              </td>
              <td>{{ sp.coefficient }}</td>
              <template v-if="sp.side === 'left'">
                <td>
                  <input
                    v-model="feedFor(step, sp.key).amount"
                    class="amount-input"
                    :aria-label="step.name + ' ' + sp.label + ' 补料数量'"
                    placeholder="0（可留空）"
                    @input="markFlowStale"
                  />
                </td>
                <td>
                  <select
                    v-model="feedFor(step, sp.key).unit"
                    :aria-label="step.name + ' ' + sp.label + ' 单位'"
                    @change="markFlowStale"
                  >
                    <option v-for="(label, u) in unitLabels" :key="u" :value="u">{{ label }}</option>
                  </select>
                </td>
              </template>
              <template v-else>
                <td colspan="2" class="hint">生成物无需补料</td>
              </template>
              <td>
                <input
                  v-model="step.molarMasses[sp.key]"
                  class="amount-input"
                  :aria-label="step.name + ' ' + sp.label + ' 摩尔质量'"
                  placeholder="选填"
                  @input="markFlowStale"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <template v-if="flowSteps.length > 0">
        <h3>流程连接（生成物 → 反应物，按产量百分比分配）</h3>
        <table v-if="flowConnections.length > 0" class="stoich-table">
          <thead>
            <tr>
              <th>来源生成物</th>
              <th>目标反应物</th>
              <th>分配比例 (%)</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in flowConnections" :key="c.id" :class="{ invalid: connIssues(c.id).length > 0 }">
              <td>{{ stepName(c.fromStep) }} · {{ c.fromKey }}</td>
              <td>{{ stepName(c.toStep) }} · {{ c.toKey }}</td>
              <td>
                <input
                  v-model="c.percent"
                  class="amount-input percent-input"
                  :aria-label="'连接 ' + c.fromKey + ' 分配比例'"
                  @input="markFlowStale"
                />
                <p v-for="issue in connIssues(c.id)" :key="issue.message" class="error" role="alert">{{ issue.message }}</p>
              </td>
              <td><button type="button" @click="deleteFlowConnection(c.id)">删除</button></td>
            </tr>
          </tbody>
        </table>
        <p v-else class="hint">还没有连接。未连接的生成物全部留存；剩余反应物不会自动转送。</p>

        <div class="conn-form">
          <select v-model="connForm.fromStep" aria-label="来源步骤" @change="connForm.fromKey = ''">
            <option :value="null" disabled>来源步骤</option>
            <option v-for="s in flowSteps" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
          <select v-model="connForm.fromKey" aria-label="来源生成物" :disabled="connSourceProducts.length === 0">
            <option value="" disabled>生成物</option>
            <option v-for="sp in connSourceProducts" :key="sp.key" :value="sp.key">{{ sp.label }}</option>
          </select>
          <span aria-hidden="true">→</span>
          <select v-model="connForm.toStep" aria-label="目标步骤">
            <option :value="null" disabled>目标步骤</option>
            <option v-for="s in connTargetSteps" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
          <select aria-label="目标反应物" :disabled="connTargetReactants.length === 0" :value="connTargetReactants[0]?.key ?? ''">
            <option v-if="connTargetReactants.length === 0" value="" disabled>无同式反应物</option>
            <option v-for="sp in connTargetReactants" :key="sp.key" :value="sp.key">{{ sp.label }}</option>
          </select>
          <input
            v-model="connForm.percent"
            class="amount-input percent-input"
            aria-label="分配比例百分比"
            placeholder="比例 % (0,100]"
          />
          <button
            type="button"
            :disabled="connForm.fromStep === null || !connForm.fromKey || connForm.toStep === null || connTargetReactants.length === 0"
            @click="addFlowConnection"
          >
            + 添加连接
          </button>
        </div>
        <p class="hint">只允许连接去掉空白后化学式相同的物质；同一生成物各连接比例之和不得超过 100%，未分配部分留存。</p>

        <div class="actions">
          <button type="button" class="balance-btn" @click="computeFlowAll">计算全流程</button>
          <span class="hint">任一编辑都会使旧结果失效；全部校验通过后才会发布完整结果。</span>
        </div>
      </template>

      <p v-if="flowOutcome && flowStale" class="banner warn" role="status">
        步骤、补料或连接已修改，整套流程结果已失效，请重新点击「计算全流程」。
      </p>

      <template v-if="flowResultVisible && flowOutcome">
        <p v-for="issue in flowGlobalIssues" :key="issue.message" class="banner bad" role="alert">{{ issue.message }}</p>
        <div v-if="flowOutcome.issues.length > 0" class="banner bad" role="alert">
          流程校验未通过（{{ flowOutcome.issues.length }} 处问题，见各步骤 / 连接下方标注），本次不发布结果。
        </div>

        <template v-if="flowOutcome.result">
          <div v-for="acct in flowOutcome.result.steps" :key="acct.stepId" class="flow-account">
            <h3>
              {{ acct.name }}
              <span class="hint">（反应进度 ξ = {{ fmt(acct.extent).text }} mol）</span>
            </h3>
            <table class="stoich-table">
              <thead>
                <tr>
                  <th>反应物</th>
                  <th>外部补料 (mol)</th>
                  <th>上游送入 (mol)</th>
                  <th>可用 (mol)</th>
                  <th>消耗 (mol)</th>
                  <th>剩余 (mol)</th>
                  <th>剩余质量 (g)</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in acct.reactants" :key="r.key" :class="{ limiting: r.limiting }">
                  <td>
                    {{ r.label }}
                    <span v-if="r.limiting" class="side-tag">限量</span>
                  </td>
                  <td>{{ fmt(r.feedMol).text }}</td>
                  <td>
                    <template v-if="r.incoming.length > 0">
                      <div v-for="t in r.incoming" :key="t.connectionId">
                        来自「{{ stepName(t.fromStepId) }}」{{ t.fromKey }}：{{ fmt(t.mol).text }}
                      </div>
                    </template>
                    <template v-else>—</template>
                  </td>
                  <td>{{ fmt(r.available).text }}</td>
                  <td>{{ fmt(r.consumed).text }}</td>
                  <td>{{ fmt(r.remaining).text }}</td>
                  <td>{{ r.remainingMass ? fmt(r.remainingMass).text : '—' }}</td>
                </tr>
              </tbody>
            </table>
            <table class="stoich-table">
              <thead>
                <tr>
                  <th>生成物</th>
                  <th>产量 (mol)</th>
                  <th>产量 (g)</th>
                  <th>已转送 (mol)</th>
                  <th>转送明细</th>
                  <th>留存 (mol)</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="pr in acct.products" :key="pr.key">
                  <td>{{ pr.label }}</td>
                  <td>{{ fmt(pr.produced).text }}</td>
                  <td>{{ pr.producedMass ? fmt(pr.producedMass).text : '—' }}</td>
                  <td>{{ fmt(pr.transferred).text }}</td>
                  <td>
                    <template v-if="pr.transfers.length > 0">
                      <div v-for="t in pr.transfers" :key="t.connectionId">
                        → 「{{ stepName(t.toStepId) }}」{{ fmt(t.mol).text }}（{{ pctText(t.ratio) }}%）
                      </div>
                    </template>
                    <template v-else>—</template>
                  </td>
                  <td>{{ fmt(pr.retained).text }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </template>
    </section>

    <section class="syntax-help">
      <h2>输入语法</h2>
      <ul>
        <li>元素符号首字母大写、次字母小写，如 <code>Fe</code>、<code>Cl</code>；下标写正整数，如 <code>H2O</code>。</li>
        <li>支持多层圆括号（也可用中括号、花括号）：<code>Ca3(Fe(CN)6)2</code>，括号外下标乘整个分组。</li>
        <li>结晶水用 <code>·</code> 或 <code>.</code> 分隔：<code>CuSO4·5H2O</code>，整数只乘点号后的该一段。</li>
        <li>电荷写在末尾：<code>Mg^2+</code>、<code>SO4^2-</code>、<code>H^+</code>；电子固定写 <code>e^-</code>。</li>
        <li>每行一种物质；在输入框内按 Enter 跳到下一行（末行自动新增）；空行按 Backspace 删除该行。</li>
      </ul>
    </section>
  </main>
</template>

<style>
:root {
  --bg: #f5f7fa;
  --panel: #ffffff;
  --border: #d7dde6;
  --accent: #2563eb;
  --accent-soft: #dbeafe;
  --danger: #dc2626;
  --danger-soft: #fee2e2;
  --warn: #b45309;
  --warn-soft: #fef3c7;
  --ok: #15803d;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: #1f2937;
  font-family: 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}

.app {
  max-width: 1080px;
  margin: 0 auto;
  padding: 24px 20px 60px;
}

.app-header h1 {
  margin: 0 0 4px;
  font-size: 26px;
}

.hint {
  color: #6b7280;
  font-size: 14px;
}

.examples {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin: 16px 0;
  padding: 12px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.examples-label {
  font-weight: 600;
}

button {
  font: inherit;
  cursor: pointer;
  border: 1px solid var(--border);
  background: #fff;
  border-radius: 6px;
  padding: 4px 10px;
}

button:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.example-btn {
  background: var(--accent-soft);
  border-color: transparent;
  color: #1e40af;
}

.columns {
  display: grid;
  grid-template-columns: 1fr 48px 1fr;
  gap: 12px;
  align-items: start;
}

.column {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px;
}

.column h2 {
  margin: 0 0 10px;
  font-size: 18px;
}

.equals {
  align-self: center;
  text-align: center;
  font-size: 28px;
  color: var(--accent);
  font-weight: 700;
}

.row {
  position: relative;
  padding: 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  margin-bottom: 8px;
  transition: opacity 0.15s, background 0.15s;
}

.row.invalid {
  background: var(--danger-soft);
  border-color: #fca5a5;
}

.row.dimmed {
  opacity: 0.35;
}

.formula-input {
  width: 100%;
  font-size: 17px;
  font-family: 'Cambria Math', 'Times New Roman', monospace;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
}

.formula-input:focus {
  outline: 2px solid var(--accent-soft);
  border-color: var(--accent);
}

.coef {
  position: absolute;
  left: -14px;
  top: 10px;
  font-weight: 700;
  color: var(--accent);
  font-size: 16px;
}

.row-tools {
  display: flex;
  gap: 4px;
  margin-top: 6px;
}

.row-tools button {
  padding: 2px 8px;
  font-size: 13px;
}

.add-btn {
  width: 100%;
  padding: 8px;
  border-style: dashed;
  color: var(--accent);
}

.error {
  color: var(--danger);
  font-size: 13px;
  margin: 4px 0 0;
}

.actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 18px 0;
  flex-wrap: wrap;
}

.balance-btn {
  background: var(--accent);
  color: #fff;
  border: none;
  padding: 10px 22px;
  font-size: 16px;
  border-radius: 8px;
}

.balance-btn:hover:not(:disabled) {
  background: #1d4ed8;
  color: #fff;
}

.copy-ok {
  color: var(--ok);
  font-size: 14px;
}

.banner {
  border-radius: 8px;
  padding: 12px 14px;
  margin: 12px 0;
  font-size: 15px;
}

.banner.warn {
  background: var(--warn-soft);
  color: var(--warn);
  border: 1px solid #fcd34d;
}

.banner.bad {
  background: var(--danger-soft);
  color: #991b1b;
  border: 1px solid #fca5a5;
}

.banner.info {
  background: var(--accent-soft);
  color: #1e40af;
  border: 1px solid #93c5fd;
}

.results {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px 18px;
  margin: 16px 0;
}

.equation {
  font-size: 20px;
  font-family: 'Cambria Math', 'Times New Roman', serif;
  background: var(--accent-soft);
  border-radius: 8px;
  padding: 12px 16px;
  overflow-x: auto;
}

.check-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 8px;
}

.check-table th,
.check-table td {
  border: 1px solid var(--border);
  padding: 8px 12px;
  text-align: left;
}

.check-table th {
  background: #f1f5f9;
}

.check-table tr.highlighted {
  background: #fef9c3;
}

.check-table .ok {
  color: var(--ok);
}

.el-btn {
  border: none;
  background: none;
  color: var(--accent);
  font-weight: 700;
  padding: 0;
  text-decoration: underline dotted;
}

.contrib-panel {
  margin-top: 16px;
  border-top: 1px dashed var(--border);
  padding-top: 10px;
}

.contrib-panel ul {
  margin: 6px 0;
  padding-left: 18px;
}

.contrib-panel li.zero {
  opacity: 0.4;
}

.side-tag {
  display: inline-block;
  font-size: 12px;
  background: #e5e7eb;
  border-radius: 4px;
  padding: 0 6px;
  margin-right: 6px;
}

.syntax-help {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 18px;
}

.stoich-section {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px 18px;
  margin: 16px 0;
}

.stoich-section h2 {
  margin-top: 0;
  font-size: 18px;
}

.stoich-section h3 {
  font-size: 15px;
  margin: 14px 0 6px;
}

.plan-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.plan-tab {
  background: #f1f5f9;
}

.plan-tab.active {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}

.plan-tools {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.plan-name-input {
  font: inherit;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}

.stoich-table {
  width: 100%;
  border-collapse: collapse;
  margin: 8px 0;
}

.stoich-table th,
.stoich-table td {
  border: 1px solid var(--border);
  padding: 6px 10px;
  text-align: left;
  vertical-align: top;
}

.stoich-table th {
  background: #f1f5f9;
}

.stoich-table tr.limiting {
  background: var(--warn-soft);
}

.amount-input {
  width: 110px;
  font: inherit;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}

.amount-input.invalid {
  border-color: var(--danger);
  background: var(--danger-soft);
}

.limiting-line {
  font-size: 16px;
}


.flow-section {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px 18px;
  margin: 16px 0;
}

.flow-section h2 {
  margin-top: 0;
  font-size: 18px;
}

.flow-section h3 {
  font-size: 15px;
  margin: 14px 0 6px;
}

.flow-step {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin: 10px 0;
}

.flow-step-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.flow-eq {
  font-family: 'Cambria Math', 'Times New Roman', serif;
  font-size: 16px;
  color: #1e40af;
}

.conn-form {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 10px 0;
}

.conn-form select {
  font: inherit;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}

.percent-input {
  width: 130px;
}

.stoich-table tr.invalid {
  background: var(--danger-soft);
}

.flow-account {
  border-top: 1px dashed var(--border);
  padding-top: 6px;
  margin-top: 10px;
}

.syntax-help h2 {
  margin-top: 0;
  font-size: 17px;
}

.syntax-help ul {
  margin: 0;
  padding-left: 20px;
  line-height: 1.8;
}

code {
  background: #f1f5f9;
  border-radius: 4px;
  padding: 1px 5px;
  font-family: 'Cambria Math', monospace;
}

@media (max-width: 760px) {
  .columns {
    grid-template-columns: 1fr;
  }
  .equals {
    transform: rotate(90deg);
  }
}
</style>
