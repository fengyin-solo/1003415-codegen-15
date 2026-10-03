import type { EntryRow } from './types'

// 通行规则台的判定模型：每条规则都给出「判定标准」，命中后产出建议通行状态；
// 多条同时命中时按 priority 取最高优先级（数字越小优先级越高）。

export type RoadStatus = '正常通行' | '限制通行' | '封闭'

export type RuleCode =
  | 'manual_close'
  | 'construction_close'
  | 'inspection_expired'
  | 'width_limit'
  | 'endpoint_control'

export type RuleHit = {
  code: RuleCode
  name: string
  priority: number
  /** 这条规则针对当前这条道路的具体判定标准（阈值已代入）。 */
  criteria: string
  hit: boolean
  /** 命中原因；未命中时说明为什么放行。 */
  detail: string
  suggested: RoadStatus
}

export type RoadDecision = {
  roadId: number
  roadCode: string
  hits: RuleHit[]
  /** 优先级最高的命中规则；全部未命中则为 null，表示建议正常通行。 */
  winner: RuleHit | null
  suggested: RoadStatus
  /** 巡检日期是否由「首次巡检兼容回填」补齐。 */
  inspectionBackfilled: boolean
  backfilledDate: string | null
}

// 按道路等级配置：巡检周期（天）、通行宽度下限（米，低于则宽度限制）、终点管控区。
type GradePolicy = {
  grade: string
  inspectionCycleDays: number
  minWidthMeter: number
  controlEndpoints: string[]
}

export const GRADE_POLICIES: GradePolicy[] = [
  { grade: '一级路', inspectionCycleDays: 30, minWidthMeter: 4.0, controlEndpoints: ['核心火险管控区'] },
  { grade: '二级路', inspectionCycleDays: 60, minWidthMeter: 3.5, controlEndpoints: ['核心火险管控区'] },
  { grade: '三级路', inspectionCycleDays: 90, minWidthMeter: 3.0, controlEndpoints: ['核心火险管控区', '封禁育林区'] },
  { grade: '等外路', inspectionCycleDays: 120, minWidthMeter: 2.5, controlEndpoints: ['封禁育林区'] },
]

export function policyOfGrade(grade: string): GradePolicy {
  return GRADE_POLICIES.find((item) => item.grade === grade) ?? GRADE_POLICIES[GRADE_POLICIES.length - 1]
}

// 自动规则的优先级（人工封闭不在此列，它永远压过自动规则）：
// 施工封闭 > 巡检到期 > 宽度限制 > 起终点管控
const RULE_PRIORITY: Record<Exclude<RuleCode, 'manual_close'>, number> = {
  construction_close: 10,
  inspection_expired: 20,
  width_limit: 30,
  endpoint_control: 40,
}

// 存量林区道路缺少巡检日期时，按「首次巡检」兼容回填到这个基准日；
// 回填后再正常参与巡检到期判定（基准日距今均已超过各等级周期，命中到期规则）。
export const FIRST_INSPECTION_BASELINE = '2026-01-01'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isValidDate(value: unknown): value is string {
  return typeof value === 'string' && DATE_RE.test(value) && !Number.isNaN(Date.parse(value))
}

function parseWidth(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const matched = value.match(/\d+(\.\d+)?/)
  return matched ? Number(matched[0]) : null
}

function daysBetween(from: string, to: Date): number {
  return Math.floor((to.getTime() - Date.parse(`${from}T00:00:00`)) / 86_400_000)
}

/** 巡检日期缺失/不可解析时按首次巡检兼容回填，返回可参与判定的日期与回填标记。 */
export function resolveInspectionDate(row: EntryRow, now: Date = new Date()): { date: string; backfilled: boolean } {
  const raw = row['最近巡检日']
  if (isValidDate(raw)) {
    return { date: raw, backfilled: false }
  }
  // 回填日期不晚于今天，避免与当前时间冲突。
  const baseline = FIRST_INSPECTION_BASELINE > toDateKey(now) ? toDateKey(now) : FIRST_INSPECTION_BASELINE
  return { date: baseline, backfilled: true }
}

function toDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

// 封闭原因归一化：先判人工，再判施工，都不命中视为无封闭。
function classifyClosure(reason: string): 'manual' | 'construction' | null {
  const text = reason.trim()
  if (!text) return null
  if (/(人工|火险管控|应急|火情|戒严|命令)/.test(text)) return 'manual'
  if (/(施工|修路|养护|水毁|塌方|架桥|铺管)/.test(text)) return 'construction'
  return null
}

export function evaluateRoad(row: EntryRow, now: Date = new Date()): RoadDecision {
  const grade = String(row['道路等级'] ?? '')
  const policy = policyOfGrade(grade)
  const width = parseWidth(row['通行宽度'])
  const start = String(row['起点位置'] ?? '')
  const end = String(row['终点位置'] ?? '')
  const reason = String(row['封闭原因'] ?? '')
  const closure = classifyClosure(reason)
  const inspection = resolveInspectionDate(row, now)
  const overdueDays = daysBetween(inspection.date, now)
  const expired = overdueDays > policy.inspectionCycleDays
  const widthHit = width !== null && width < policy.minWidthMeter
  const endpointHit = policy.controlEndpoints.some((zone) => start.includes(zone) || end.includes(zone))

  const hits: RuleHit[] = [
    {
      code: 'manual_close',
      name: '人工封闭',
      priority: 0,
      criteria: `封闭原因含人工/应急/火险管控等指令（当前原因：${reason || '无'}）`,
      hit: closure === 'manual',
      detail: closure === 'manual' ? `命中人工封闭原因「${reason}」，人工封闭优先于一切自动规则` : '未登记人工封闭原因',
      suggested: '封闭',
    },
    {
      code: 'construction_close',
      name: '施工封闭',
      priority: RULE_PRIORITY.construction_close,
      criteria: `封闭原因含施工/养护/水毁等施工类事由（当前原因：${reason || '无'}）`,
      hit: closure === 'construction',
      detail: closure === 'construction' ? `命中施工封闭原因「${reason}」，施工期间封闭` : '无施工类封闭原因',
      suggested: '封闭',
    },
    {
      code: 'inspection_expired',
      name: '巡检到期',
      priority: RULE_PRIORITY.inspection_expired,
      criteria: `${grade}巡检周期 ${policy.inspectionCycleDays} 天，最近巡检日超过周期即到期`,
      hit: expired,
      detail: expired
        ? `最近巡检日 ${inspection.date}，已超期 ${overdueDays - policy.inspectionCycleDays} 天`
        : `最近巡检日 ${inspection.date}，周期内剩余 ${policy.inspectionCycleDays - overdueDays} 天`,
      suggested: '限制通行',
    },
    {
      code: 'width_limit',
      name: '宽度限制',
      priority: RULE_PRIORITY.width_limit,
      criteria: `${grade}通行宽度下限 ${policy.minWidthMeter.toFixed(1)} 米，实测低于下限即限宽`,
      hit: widthHit,
      detail: widthHit
        ? `实测宽度 ${width?.toFixed(1)} 米，低于下限 ${policy.minWidthMeter.toFixed(1)} 米，大型车辆绕行`
        : width === null
          ? '通行宽度未登记，不参与限宽判定'
          : `实测宽度 ${width.toFixed(1)} 米，满足下限`,
      suggested: '限制通行',
    },
    {
      code: 'endpoint_control',
      name: '起终点管控',
      priority: RULE_PRIORITY.endpoint_control,
      criteria: `起点或终点位于${grade}管控区（${policy.controlEndpoints.join('、')}），凭证通行`,
      hit: endpointHit,
      detail: endpointHit ? '起终点命中管控区，凭通行证通行' : '起终点不在管控区',
      suggested: '限制通行',
    },
  ]

  const winner = hits.filter((item) => item.hit).sort((a, b) => a.priority - b.priority)[0] ?? null

  return {
    roadId: Number(row.id),
    roadCode: String(row['道路编号'] ?? `#${row.id}`),
    hits,
    winner,
    suggested: winner ? winner.suggested : '正常通行',
    inspectionBackfilled: inspection.backfilled,
    backfilledDate: inspection.backfilled ? inspection.date : null,
  }
}

export function evaluateRoads(rows: EntryRow[], now: Date = new Date()): Map<number, RoadDecision> {
  return new Map(rows.map((row) => [Number(row.id), evaluateRoad(row, now)]))
}

export const RULE_ORDER: RuleCode[] = [
  'manual_close',
  'construction_close',
  'inspection_expired',
  'width_limit',
  'endpoint_control',
]
