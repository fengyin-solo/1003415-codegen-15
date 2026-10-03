import type { EntryRow } from '@/data/types'

/**
 * 林区道路通行规则引擎（纯函数，不碰存储；存储与联动放 traffic-service）。
 *
 * 判定依据：道路等级、通行宽度、起点位置、终点位置、最近巡检日、封闭原因。
 * 自动规则优先级（由高到低，命中即停）：施工封闭 > 巡检到期 > 宽度限制。
 * 人工封闭是现场管控指令，优先级最高，命中时覆盖一切自动规则。
 */

export const ROAD_KEY = 'forestroad'
export const CLOSURE_KEY = 'traffic-closure'
export const ADJUST_KEY = 'traffic-adjust'

/** 建议通行状态 */
export type TrafficState = '正常通行' | '限制通行' | '封闭通行'
/** 管控来源 */
export type ClosureSource = 'manual' | 'construction'
/** 命中的规则类型；顺序即自动规则的优先级（人工封闭不在此列，它永远最高） */
export type RuleCode =
  | 'manual-closure'
  | 'construction-closed'
  | 'inspection-expired'
  | 'width-restricted'
  | 'normal'

export const RULE_PRIORITY: RuleCode[] = [
  'construction-closed',
  'inspection-expired',
  'width-restricted',
  'normal',
]

export const RULE_LABEL: Record<RuleCode, string> = {
  'manual-closure': '人工封闭',
  'construction-closed': '施工封闭',
  'inspection-expired': '巡检到期',
  'width-restricted': '宽度限制',
  normal: '未命中限制',
}

export const ROAD_GRADES = ['一级道路', '二级道路', '三级道路'] as const
export type RoadGrade = (typeof ROAD_GRADES)[number]

/** 每个等级的判定阈值与建议处置，全部可以在规则台展示给现场人员 */
export type GradePolicy = {
  grade: RoadGrade
  /** 通行宽度低于该米数触发宽度限制 */
  minWidth: number
  /** 最近巡检日距今天数超过该值视为巡检到期 */
  inspectCycleDays: number
  widthAdvice: string
  inspectAdvice: string
}

export const GRADE_POLICIES: GradePolicy[] = [
  {
    grade: '一级道路',
    minWidth: 4.0,
    inspectCycleDays: 30,
    widthAdvice: '宽度不足4.0m，大型消防车辆交会困难，建议限制通行并安排错车点',
    inspectAdvice: '一级道路巡检周期30天，超期未巡检，建议限制通行并补排巡检',
  },
  {
    grade: '二级道路',
    minWidth: 3.5,
    inspectCycleDays: 45,
    widthAdvice: '宽度不足3.5m，消防水车通行受限，建议限制为小型车辆单向通行',
    inspectAdvice: '二级道路巡检周期45天，超期未巡检，建议限制通行并补排巡检',
  },
  {
    grade: '三级道路',
    minWidth: 3.0,
    inspectCycleDays: 60,
    widthAdvice: '宽度不足3.0m，仅满足小型巡护车辆通行，建议限制通行',
    inspectAdvice: '三级道路巡检周期60天，超期未巡检，建议限制通行并补排巡检',
  },
]

/** 封闭通行的合法封闭原因（人工封闭登记时选择） */
export const CLOSURE_REASONS = [
  '现场施工',
  '地质灾害',
  '极端天气',
  '火情封控',
  '临时管制',
] as const
export type ClosureReason = (typeof CLOSURE_REASONS)[number]

export type ClosureRecord = {
  /** 单调递增序号，模拟数据库行版本/落库先后 */
  seq: number
  roadId: number
  source: ClosureSource
  reason: string
  operator: string
  closedAt: string
  /** 撤销序号，存在即已撤销 */
  revokedSeq?: number
  revokedAt?: string
  revokedBy?: string
}

/** 单条自动规则的判定明细 */
export type RuleHit = {
  code: RuleCode
  hit: boolean
  /** 该条规则在这条道路上的判定标准（现场值 vs 阈值），未配置等级时也会写明 */
  criterion: string
}

export type RoadEvaluation = {
  state: TrafficState
  /** 最终采纳的规则 */
  winner: RuleCode
  /** 是否被人工封闭覆盖（人工凌驾自动规则） */
  manualOverride: boolean
  hits: RuleHit[]
  /** 每条道路的判定结论，给现场人员看 */
  advice: string
  widthMeters: number | null
  grade: string
  inspectDate: string
  inspectBackfilled: boolean
  inspectOverdueDays: number | null
}

/* ---------------- 字段取值与存量兼容 ---------------- */

export function fieldText(row: EntryRow, field: string): string {
  return String(row[field] ?? '').trim()
}

/** 通行宽度解析成米：支持「3.5米 / 3.5m / 3.5」写法；解析失败返回 null */
export function parseWidthMeters(raw: string): number | null {
  const matched = raw.match(/-?\d+(\.\d+)?/)
  if (!matched) {
    return null
  }
  const value = Number(matched[0])
  return Number.isFinite(value) && value > 0 ? value : null
}

export function policyOf(grade: string): GradePolicy | null {
  return GRADE_POLICIES.find((item) => item.grade === grade) ?? null
}

/** 巡检超期天数：以「今天」为基准，返回正数表示超期天数，未超期为 0 */
export function inspectOverdueDays(dateText: string, today: Date, cycleDays: number): number {
  const date = new Date(`${dateText}T00:00:00`)
  if (Number.isNaN(date.getTime())) {
    return 0
  }
  const dayMs = 24 * 60 * 60 * 1000
  const elapsed = Math.floor((today.getTime() - date.getTime()) / dayMs)
  return Math.max(0, elapsed - cycleDays)
}

/**
 * 存量道路缺少巡检日期时，按首次巡检兼容回填：统一回填为启用首日并打标。
 * marked 为持久化字段「巡检日期来源」里已记录的回填标记（回填落库后日期本身已合法，靠它识别）。
 */
export const FIRST_INSPECT_DATE = '2026-01-01'
export function backfillInspectDate(
  dateText: string,
  marked = false,
): { date: string; backfilled: boolean } {
  const date = new Date(`${dateText}T00:00:00`)
  if (dateText && !Number.isNaN(date.getTime()) && !marked) {
    return { date: dateText, backfilled: false }
  }
  return {
    date: dateText && !Number.isNaN(date.getTime()) ? dateText : FIRST_INSPECT_DATE,
    backfilled: true,
  }
}

/* ---------------- 规则判定 ---------------- */

/** 当前生效（未撤销）的封闭记录：同一道路只允许一条生效 */
export function activeClosure(roadId: number, closures: ClosureRecord[]): ClosureRecord | null {
  return (
    closures.find((item) => item.roadId === roadId && item.revokedSeq === undefined) ?? null
  )
}

export function evaluateRoad(
  row: EntryRow,
  closures: ClosureRecord[],
  options: { today?: Date; construction?: boolean } = {},
): RoadEvaluation {
  const today = options.today ?? new Date()
  const grade = fieldText(row, '道路等级')
  const widthRaw = fieldText(row, '通行宽度')
  const widthMeters = parseWidthMeters(widthRaw)
  const fill = backfillInspectDate(
    fieldText(row, '最近巡检日'),
    fieldText(row, '巡检日期来源').includes('回填'),
  )
  const policy = policyOf(grade)
  const start = fieldText(row, '起点位置')
  const end = fieldText(row, '终点位置')

  // 施工封闭：施工登记在有效期，或存在施工来源且未撤销的封闭记录
  const constructionClosure =
    options.construction === true ||
    closures.some(
      (item) =>
        item.roadId === Number(row.id) &&
        item.source === 'construction' &&
        item.revokedSeq === undefined,
    )
  const manual = activeClosure(Number(row.id), closures.filter((c) => c.source === 'manual'))
  const overdueDays = policy
    ? inspectOverdueDays(fill.date, today, policy.inspectCycleDays)
    : 0

  const hits: RuleHit[] = []

  hits.push({
    code: 'construction-closed',
    hit: constructionClosure,
    criterion: constructionClosure
      ? `起点「${start}」至终点「${end}」路段处于施工封闭状态（封闭原因：施工），建议封闭通行`
      : `起点「${start}」至终点「${end}」无施工封闭记录，施工封闭规则未命中`,
  })

  hits.push({
    code: 'inspection-expired',
    hit: !!policy && overdueDays > 0,
    criterion: policy
      ? `${grade}巡检周期${policy.inspectCycleDays}天；最近巡检日${fill.date}` +
        (fill.backfilled ? '（存量缺日期，按首次巡检回填）' : '') +
        (overdueDays > 0 ? `，已超期${overdueDays}天` : '，未超期')
      : `道路等级「${grade || '未填写'}」未配置巡检周期，巡检到期规则不参与判定`,
  })

  hits.push({
    code: 'width-restricted',
    hit: !!policy && widthMeters !== null && widthMeters < policy.minWidth,
    criterion: policy
      ? `${grade}最低通行宽度${policy.minWidth}m；登记宽度${
          widthMeters === null ? `「${widthRaw || '空'}」无法解析` : `${widthMeters}m`
        }` + (policy && widthMeters !== null && widthMeters < policy.minWidth ? '，低于阈值' : '，满足要求')
      : `道路等级「${grade || '未填写'}」未配置宽度阈值，宽度限制规则不参与判定`,
  })

  // 自动规则按固定优先级取最高命中
  const autoWinner =
    hits.find((hit) => hit.hit && RULE_PRIORITY.includes(hit.code))?.code ?? 'normal'

  const manualOverride = manual !== null
  const winner: RuleCode = manualOverride ? 'manual-closure' : autoWinner
  const state: TrafficState =
    winner === 'manual-closure'
      ? '封闭通行'
      : winner === 'construction-closed'
        ? '封闭通行'
        : winner === 'normal'
          ? '正常通行'
          : '限制通行'

  let advice: string
  if (manualOverride && manual) {
    advice = `人工封闭生效（原因：${manual.reason}，操作人：${manual.operator}），凌驾自动规则，禁止一切车辆通行`
  } else if (autoWinner === 'construction-closed') {
    advice = '道路施工封闭，自动建议封闭通行；待施工结束后由人工或联动撤销'
  } else if (autoWinner === 'inspection-expired' && policy) {
    advice = policy.inspectAdvice
  } else if (autoWinner === 'width-restricted' && policy) {
    advice = policy.widthAdvice
  } else {
    advice = `起点「${start}」至终点「${end}」各项指标满足${grade || '当前等级'}通行要求，建议正常通行`
  }

  return {
    state,
    winner,
    manualOverride,
    hits,
    advice,
    widthMeters,
    grade,
    inspectDate: fill.date,
    inspectBackfilled: fill.backfilled,
    inspectOverdueDays: policy ? overdueDays : null,
  }
}

/* ---------------- 合法方向状态机 ---------------- */

/**
 * 通行状态只允许按合法方向切换。
 * 正常/限制 -> 封闭（封闭下行）
 * 封闭 -> 限制/正常（撤销封闭时按规则引擎的建议态上行，不允许跳过校验）
 * 正常 <-> 限制（随自动规则结果互转）
 */
export const LEGAL_TRANSITIONS: Record<TrafficState, TrafficState[]> = {
  正常通行: ['限制通行', '封闭通行'],
  限制通行: ['正常通行', '封闭通行'],
  封闭通行: ['限制通行', '正常通行'],
}

export function canSwitch(from: TrafficState, to: TrafficState): boolean {
  return from === to || LEGAL_TRANSITIONS[from].includes(to)
}
