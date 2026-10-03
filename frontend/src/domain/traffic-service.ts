import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'
import {
  activeClosure,
  ADJUST_KEY,
  canSwitch,
  CLOSURE_KEY,
  evaluateRoad,
  type ClosureReason,
  type ClosureRecord,
  type ClosureSource,
  type TrafficState,
} from './traffic-rule'

/**
 * 通行规则台的应用服务：负责落库、合法方向校验、并发撤销、规则生效后的跨模块联动。
 * 纯前端没有数据库，localStorage 的写入即「落库」；用行版本号模拟乐观锁，
 * 用单调递增序号决定两个终端并发撤销时谁先落库。
 */

const VERSION_FIELD = '_roadVersion'
const CONSTRUCTION_FIELD = '施工登记'

export type RoadView = {
  row: EntryRow
  version: number
  state: TrafficState
  evaluation: ReturnType<typeof evaluateRoad>
  closure: ClosureRecord | null
}

export type RouteAdjustment = {
  id: number
  roadId: number
  roadName: string
  module: 'patrol' | 'drone'
  targetId: number
  targetCode: string
  action: 'reroute' | 'avoid'
  note: string
  state: TrafficState
  createdAt: string
  /** 已被后续放行撤销的联动保留痕迹，但标记为已解除 */
  resolved: boolean
  resolvedAt?: string
}

/* ---------------- 存储读写与存量规整 ---------------- */

function readClosures(): ClosureRecord[] {
  const rows = listRows(CLOSURE_KEY) as unknown as ClosureRecord[]
  return Array.isArray(rows) ? rows : []
}

function writeClosures(records: ClosureRecord[]): void {
  saveRows(CLOSURE_KEY, records as unknown as EntryRow[])
}

function readAdjustments(): RouteAdjustment[] {
  const rows = listRows(ADJUST_KEY) as unknown as RouteAdjustment[]
  return Array.isArray(rows) ? rows : []
}

function writeAdjustments(items: RouteAdjustment[]): void {
  saveRows(ADJUST_KEY, items as unknown as EntryRow[])
}

/**
 * 规整存量林区道路：
 * 1. 缺巡检日期由规则引擎按首次巡检回填（回填结果持久化并打兼容标记）；
 * 2. 老数据没有版本号，初始化为 0（乐观锁基线）。
 * 返回规整后的全部道路及回填条数。
 */
export function normalizeRoads(rows: EntryRow[] = listRows('forestroad')): {
  rows: EntryRow[]
  backfilled: number
} {
  let changed = false
  let backfilled = 0
  const next = rows.map((row) => {
    const updated: EntryRow = { ...row }
    const rawDate = String(updated['最近巡检日'] ?? '').trim()
    const date = new Date(`${rawDate}T00:00:00`)
    if (!rawDate || Number.isNaN(date.getTime())) {
      updated['最近巡检日'] = '2026-01-01'
      updated['巡检日期来源'] = '首次巡检兼容回填'
      backfilled += 1
      changed = true
    }
    if (typeof updated[VERSION_FIELD] !== 'number') {
      updated[VERSION_FIELD] = 0
      changed = true
    }
    return updated
  })
  if (changed) {
    saveRows('forestroad', next)
  }
  return { rows: next, backfilled }
}

/* ---------------- 查询与规则生效 ---------------- */

export function listRoadViews(): RoadView[] {
  const { rows } = normalizeRoads()
  const closures = readClosures()
  return rows.map((row) => {
    const evaluation = evaluateRoad(row, closures, {
      construction: String(row[CONSTRUCTION_FIELD] ?? '') === '是',
    })
    const closure = activeClosure(Number(row.id), closures)
    return {
      row,
      version: Number(row[VERSION_FIELD] ?? 0),
      state: evaluation.state,
      evaluation,
      closure,
    }
  })
}

function nextSeq(records: ClosureRecord[]): number {
  return records.reduce((max, item) => Math.max(max, item.seq), 0) + 1
}

function persistState(row: EntryRow, state: TrafficState): EntryRow {
  const updated: EntryRow = {
    ...row,
    status: state,
    '通行状态': state,
    [VERSION_FIELD]: Number(row[VERSION_FIELD] ?? 0) + 1,
    pending: state !== '封闭通行',
    abnormal: state === '封闭通行',
  }
  return updated
}

function applyState(roadId: number, state: TrafficState): {
  ok: boolean
  message: string
  view?: RoadView
} {
  const { rows } = normalizeRoads()
  const index = rows.findIndex((item) => Number(item.id) === roadId)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${roadId} 的林区道路` }
  }
  const current = String(rows[index].status) as TrafficState
  if (!canSwitch(current, state)) {
    return { ok: false, message: `通行状态不能从「${current}」直接切换为「${state}」，方向不合法` }
  }
  if (current === state) {
    return { ok: false, message: `道路已经是「${state}」，无需重复切换` }
  }
  rows[index] = persistState(rows[index], state)
  saveRows('forestroad', rows)
  const view = listRoadViews().find((item) => Number(item.row.id) === roadId)
  return {
    ok: true,
    message: `道路通行状态已由「${current}」切换为「${state}」`,
    view,
  }
}

/** 规则生效：把规则引擎的建议态按合法方向落到道路上，并驱动巡护/无人机联动 */
export function applyRoadRule(roadId: number, operator: string): ActionResult & { view?: RoadView } {
  const before = listRoadViews().find((item) => Number(item.row.id) === roadId)
  if (!before) {
    return { ok: false, message: `没有找到编号为 ${roadId} 的林区道路` }
  }
  const target = before.evaluation.state
  const switchResult = applyState(roadId, target)
  if (!switchResult.ok) {
    return { ok: false, message: switchResult.message }
  }
  const after = listRoadViews().find((item) => Number(item.row.id) === roadId)
  if (after && target !== '正常通行') {
    cascadeAdjust(after, operator)
  }
  return {
    ok: true,
    message: `${switchResult.message}；采纳规则「${before.evaluation.winner}」，已联动核查巡护任务与无人机路线`,
  }
}

/* ---------------- 人工封闭 / 撤销（含并发控制） ---------------- */

/**
 * 人工封闭：登记一条生效封闭记录（同一道路只保留一条生效），再按合法方向落封闭态。
 * 人工封闭永远凌驾自动规则。
 */
export function manualClose(
  roadId: number,
  reason: ClosureReason | string,
  operator: string,
): ActionResult & { view?: RoadView } {
  const roads = normalizeRoads().rows
  const road = roads.find((item) => Number(item.id) === roadId)
  if (!road) {
    return { ok: false, message: `没有找到编号为 ${roadId} 的林区道路` }
  }
  const closures = readClosures()
  if (activeClosure(roadId, closures)) {
    return { ok: false, message: '该道路已有生效中的封闭记录，不能重复封闭' }
  }
  const record: ClosureRecord = {
    seq: nextSeq(closures),
    roadId,
    source: 'manual' as ClosureSource,
    reason,
    operator,
    closedAt: new Date().toISOString(),
  }
  closures.push(record)
  writeClosures(closures)

  const result = applyState(roadId, '封闭通行')
  if (!result.ok) {
    // 状态方向不合法也要把封闭记录回滚，避免「有记录但没封路」
    writeClosures(readClosures().filter((item) => item.seq !== record.seq))
    return { ok: false, message: result.message }
  }
  const view = listRoadViews().find((item) => Number(item.row.id) === roadId)
  if (view) {
    cascadeAdjust(view, operator)
  }
  return { ok: true, message: `人工封闭已落库（序号${record.seq}），原因「${reason}」，已凌驾自动规则` }
}

/**
 * 撤销封闭（乐观锁）：终端必须带上它读到的版本号 expectedVersion。
 * 两个终端并发撤销同一条封闭时，先落库的会把版本号 +1，后到的校验失败，只允许一次成功。
 */
export function revokeClose(
  roadId: number,
  expectedVersion: number,
  operator: string,
): ActionResult & { view?: RoadView } {
  const { rows } = normalizeRoads()
  const index = rows.findIndex((item) => Number(item.id) === roadId)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${roadId} 的林区道路` }
  }
  const currentVersion = Number(rows[index][VERSION_FIELD] ?? 0)
  if (currentVersion !== expectedVersion) {
    return {
      ok: false,
      message: `并发冲突：道路版本已变为 ${currentVersion}（终端读到的是 ${expectedVersion}），本次撤销未落库，请刷新后重试`,
    }
  }

  const closures = readClosures()
  const active = activeClosure(roadId, closures)
  if (!active) {
    return { ok: false, message: '该道路没有生效中的封闭记录，无需撤销' }
  }

  // 先落库撤销流水（序号决定并发先后），再推进道路状态
  const revokeSeq = nextSeq(closures)
  active.revokedSeq = revokeSeq
  active.revokedAt = new Date().toISOString()
  active.revokedBy = operator
  writeClosures(closures)

  // 撤销后回到规则引擎建议态（人工/施工封闭解除后的自动结果）
  const reopened = listRoadViews().find((item) => Number(item.row.id) === roadId)
  const target: TrafficState = reopened ? reopened.evaluation.state : '正常通行'
  const switchResult = applyState(roadId, target)
  if (!switchResult.ok) {
    return { ok: false, message: `撤销流水已落库，但状态回退失败：${switchResult.message}` }
  }

  resolveAdjustments(roadId)
  const view = listRoadViews().find((item) => Number(item.row.id) === roadId)
  return {
    ok: true,
    message: `撤销封闭已落库（撤销序号${revokeSeq}，封闭序号${active.seq}），通行状态恢复为「${target}」`,
    view,
  }
}

/* ---------------- 跨模块联动：巡护任务 / 无人机路线 ---------------- */

function roadKeywords(view: RoadView): string[] {
  const row = view.row
  return [String(row['道路名称'] ?? ''), String(row['起点位置'] ?? ''), String(row['终点位置'] ?? '')]
    .map((text) => text.trim())
    .filter(Boolean)
}

function routeTouchesRoad(row: EntryRow, keywords: string[]): boolean {
  const haystacks =
    row.status === '待执行' || row.status === '执行中' || row.status === '飞行中'
      ? [String(row['巡护区域'] ?? ''), String(row['巡护路线'] ?? ''), String(row['飞行区域'] ?? ''), String(row['飞行路线'] ?? '')]
      : []
  return haystacks.some((text) => keywords.some((word) => word && text.includes(word)))
}

/**
 * 规则生效（封闭/限行）后联动调整：
 * - 待执行的巡护/无人机任务：改线绕行；
 * - 执行中/飞行中的任务：不强制打断，下发就近避让提醒。
 */
function cascadeAdjust(view: RoadView, operator: string): void {
  const keywords = roadKeywords(view)
  const state = view.state
  if (state === '正常通行' || keywords.length === 0) {
    return
  }
  const adjustments = readAdjustments()
  const stamp = new Date().toISOString()

  const touchModule = (module: 'patrol' | 'drone', codeField: string) => {
    const rows = listRows(module)
    let mutated = false
    for (const row of rows) {
      if (!routeTouchesRoad(row, keywords)) {
        continue
      }
      const targetId = Number(row.id)
      // 同一条道路对同一任务已有未解除的联动，就不重复生成
      const exists = adjustments.some(
        (item) =>
          item.roadId === Number(view.row.id) &&
          item.targetId === targetId &&
          item.module === module &&
          !item.resolved,
      )
      if (exists) {
        continue
      }
      const running = row.status === '执行中' || row.status === '飞行中'
      if (running) {
        row['路线调整'] = `因「${view.row['道路名称']}」${state}，现场就近避让，暂缓进入该路段`
      } else {
        row['路线调整'] = `因「${view.row['道路名称']}」${state}，已自动改线，绕行${view.row['起点位置']}至${view.row['终点位置']}路段`
        row['任务状态'] = '已按道路规则改线'
      }
      mutated = true
      adjustments.push({
        id: adjustments.length + 1,
        roadId: Number(view.row.id),
        roadName: String(view.row['道路名称'] ?? ''),
        module,
        targetId,
        targetCode: String(row[codeField] ?? ''),
        action: running ? 'avoid' : 'reroute',
        note: running
          ? '任务执行中，下发就近避让提醒'
          : '任务未开始，路线已自动绕行封闭/限行路段',
        state,
        createdAt: stamp,
        resolved: false,
      })
    }
    if (mutated) {
      saveRows(module, rows)
    }
  }

  touchModule('patrol', '任务编号')
  touchModule('drone', '任务编号')
  writeAdjustments(adjustments)
  void operator
}

/** 道路撤销封闭后，把它触发的联动调整标记解除（历史记录保留） */
function resolveAdjustments(roadId: number): void {
  const items = readAdjustments()
  const stamp = new Date().toISOString()
  let changed = false
  for (const item of items) {
    if (item.roadId === roadId && !item.resolved) {
      item.resolved = true
      item.resolvedAt = stamp
      changed = true
    }
  }
  if (changed) {
    writeAdjustments(items)
  }
}

export function listAdjustments(module?: 'patrol' | 'drone'): RouteAdjustment[] {
  const items = readAdjustments()
  return module ? items.filter((item) => item.module === module) : items
}

export function closureHistory(roadId?: number): ClosureRecord[] {
  const records = readClosures()
  const sorted = [...records].sort((a, b) => b.seq - a.seq)
  return roadId === undefined ? sorted : sorted.filter((item) => item.roadId === roadId)
}
