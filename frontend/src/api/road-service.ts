import { MODULE_BY_KEY } from '@/data/modules'
import { FIRST_INSPECTION_BASELINE, evaluateRoad, evaluateRoads, isValidDate } from '@/data/road-rules'
import { invalidateCache, listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta } from '@/data/types'
import { appendLinkage, rebuildLinkageMarkers } from './road-linkage'

export const ROAD_KEY = 'forestroad'

export type RoadActionResult = ActionResult & {
  version?: number
  linked?: number
}

export function roadMeta(): ModuleMeta {
  const meta = MODULE_BY_KEY.get(ROAD_KEY)
  if (!meta) throw new Error('林区道路模块未登记')
  return meta
}

// 合法方向校验：模块声明了 legalTransitions 就只能沿有向图切换。
export function isLegalTransition(meta: ModuleMeta, from: string, to: string): boolean {
  if (from === to) return false
  const graph = meta.legalTransitions
  if (!graph) return true
  return (graph[from] ?? []).includes(to)
}

function roadVersion(row: EntryRow): number {
  const v = Number(row['版本'])
  return Number.isFinite(v) ? v : 0
}

// 存量道路缺少巡检日期时的首次巡检兼容回填：补齐一次并落库，带回填标记。
function backfillInspectionDates(rows: EntryRow[]): EntryRow[] {
  let changed = false
  const next = rows.map((row) => {
    if (isValidDate(row['最近巡检日'])) return row
    changed = true
    return {
      ...row,
      最近巡检日: FIRST_INSPECTION_BASELINE,
      巡检回填: '首次巡检回填',
    }
  })
  if (changed) saveRows(ROAD_KEY, next)
  return changed ? next : rows
}

export type RoadDeskRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  decision: ReturnType<typeof evaluateRoad>
  [field: string]: string | number | boolean | ReturnType<typeof evaluateRoad>
}

export function listRoadDesk(): RoadDeskRow[] {
  const rows = backfillInspectionDates(listRows(ROAD_KEY))
  const decisions = evaluateRoads(rows)
  return rows.map((row) => ({ ...row, decision: decisions.get(Number(row.id))! }))
}

function closureTypeOf(row: EntryRow): string {
  return String(row['封闭类型'] ?? '')
}

function persistRoad(rows: EntryRow[], index: number, next: EntryRow): void {
  const updated = [...rows]
  updated[index] = next
  saveRows(ROAD_KEY, updated)
  // 规则生效后：巡护任务与无人机路线跟着调整。
  const affected = rebuildLinkageMarkers(String(next['道路编号']))
  void appendLinkage({
    roadCode: String(next['道路编号']),
    roadStatus: String(next.status),
    reason: String(next['封闭原因'] ?? '道路状态变更'),
    affected,
  })
}

function baseUpdate(row: EntryRow, status: string): EntryRow {
  return {
    ...row,
    status,
    pending: status !== '正常通行',
    abnormal: status === '封闭',
    版本: roadVersion(row) + 1,
  }
}

type RoadActionOptions = {
  reason?: string
  // 撤销封闭时的乐观锁版本号：必须与页面读到的版本一致，先落库的终端赢。
  expectedVersion?: number
}

export function runRoadAction(id: number, action: string, options: RoadActionOptions = {}): RoadActionResult {
  const meta = roadMeta()
  // 先丢掉内存缓存重读：多标签页（多终端）场景下拿到别的终端刚落库的版本。
  invalidateCache()
  const rows = listRows(ROAD_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) return { ok: false, message: `没有找到编号为 ${id} 的林区道路` }
  const row = rows[index]
  const current = String(row.status)
  const reason = (options.reason ?? '').trim()

  if (action === '人工封闭') {
    if (!reason) return { ok: false, message: '人工封闭必须填写封闭原因（如戒严令、应急管控指令）' }
    if (current === '封闭') {
      // 施工封闭与人工封闭冲突时以人工封闭为准，但同类型不重复落库（避免空转刷版本）。
      if (closureTypeOf(row) === '人工') {
        return { ok: false, message: '该道路已处于人工封闭，不用重复登记；封闭原因有变化请先撤销再重新封闭' }
      }
      const next = { ...baseUpdate(row, '封闭'), 封闭原因: reason, 封闭类型: '人工' }
      persistRoad(rows, index, next)
      return { ok: true, message: `施工封闭已由人工封闭接管（人工优先），封闭原因「${reason}」`, version: roadVersion(next) }
    }
    const next = { ...baseUpdate(row, '封闭'), 封闭原因: reason, 封闭类型: '人工' }
    persistRoad(rows, index, next)
    return { ok: true, message: `已人工封闭，封闭原因「${reason}」，优先级高于施工封闭`, version: roadVersion(next) }
  }

  if (action === '登记施工') {
    if (!reason) return { ok: false, message: '登记施工必须填写施工封闭原因' }
    if (current === '封闭' && closureTypeOf(row) === '人工') {
      return { ok: false, message: '当前为人工封闭，冲突时以人工封闭为准，施工登记不得覆盖；如需施工请先撤销人工封闭' }
    }
    if (current === '封闭' && closureTypeOf(row) === '施工') {
      return { ok: false, message: '该道路已处于施工封闭，不用重复登记' }
    }
    if (!isLegalTransition(meta, current, '封闭')) {
      return { ok: false, message: `当前状态「${current}」不允许切换到「封闭」` }
    }
    const next = { ...baseUpdate(row, '封闭'), 封闭原因: reason, 封闭类型: '施工' }
    persistRoad(rows, index, next)
    return { ok: true, message: `施工封闭已登记，原因「${reason}」`, version: roadVersion(next) }
  }

  if (action === '采纳建议') {
    const decision = evaluateRoad(row)
    const target = decision.suggested
    if (target === current) {
      return { ok: false, message: `当前状态已是「${current}」，与规则建议一致，无需采纳` }
    }
    if (!isLegalTransition(meta, current, target)) {
      return { ok: false, message: `「${current} → ${target}」不是合法切换方向，建议只能从严，不能借规则放行` }
    }
    const winner = decision.winner
    const closureType = target === '封闭' ? (winner?.code === 'manual_close' ? '人工' : '施工') : closureTypeOf(row)
    const next = {
      ...baseUpdate(row, target),
      封闭原因: target === '封闭' ? String(row['封闭原因'] ?? winner?.detail ?? '规则判定封闭') : String(row['封闭原因'] ?? ''),
      封闭类型: closureType,
    }
    persistRoad(rows, index, next)
    return {
      ok: true,
      message: `已采纳规则建议：${winner?.name ?? '无命中'}，状态切换为「${target}」`,
      version: roadVersion(next),
    }
  }

  if (action === '复检恢复') {
    if (current !== '限制通行') {
      return { ok: false, message: `只有「限制通行」的道路复检通过后才能恢复，当前为「${current}」` }
    }
    const today = new Date().toISOString().slice(0, 10)
    const next = {
      ...baseUpdate(row, '正常通行'),
      status: '正常通行',
      最近巡检日: today,
      巡检回填: '',
      封闭原因: '',
      封闭类型: '',
    }
    persistRoad(rows, index, next)
    return { ok: true, message: `复检通过，巡检日更新为 ${today}，道路恢复正常通行`, version: roadVersion(next) }
  }

  if (action === '撤销封闭') {
    // 并发撤销：两个终端同时撤销时只允许先落库的一次。
    // 后到的终端拿着旧版本号提交，CAS 比对先于状态校验失败，保证冲突必被识别。
    const expected = options.expectedVersion
    if (expected === undefined) {
      return { ok: false, message: '撤销封闭必须携带版本号' }
    }
    const actual = roadVersion(row)
    if (expected !== actual) {
      return {
        ok: false,
        message: `版本冲突：您看到的是第 ${expected} 版，道路已被另一终端先落库为第 ${actual} 版，本次撤销被拒绝，请刷新后重试`,
      }
    }
    if (current !== '封闭') {
      return { ok: false, message: `只有「封闭」状态可以撤销，当前为「${current}」` }
    }
    // 合法方向：封闭只能先回到限制通行复检，不能直接放行。
    const target = '限制通行'
    const next = { ...baseUpdate(row, target), 封闭原因: '', 封闭类型: '' }
    persistRoad(rows, index, next)
    return { ok: true, message: '撤销成功：封闭已解除，道路转为「限制通行」，复检通过后方可恢复正常', version: roadVersion(next) }
  }

  return { ok: false, message: `未登记的道路动作「${action}」` }
}
