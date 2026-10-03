import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 道路规则生效后的联动：巡护任务与无人机路线随道路通行状态调整。
// 联动标记直接写回对应模块记录（页面可见），同时记一份台账可审计、可回查。

const LEDGER_KEY = 'forest-fire-patrol:road-linkage:v2'

export type LinkageEntry = {
  id: number
  time: string
  roadCode: string
  roadStatus: string
  reason: string
  affected: { module: 'patrol' | 'drone'; code: string; marker: string; kind: '绕行' | '限行关注' | '解除恢复' }[]
}

export type AffectedRef = { module: 'patrol' | 'drone'; id: number; code: string; route: string }

const LINK_MODULES: { key: 'patrol' | 'drone'; routeField: string; codeField: string; activeStatuses: string[] }[] = [
  { key: 'patrol', routeField: '巡护路线', codeField: '任务编号', activeStatuses: ['待执行', '执行中'] },
  { key: 'drone', routeField: '飞行路线', codeField: '任务编号', activeStatuses: ['待执行', '飞行中'] },
]

const ROAD_CODE_RE = /FORE-\d{4}/g

export function findRoadRefs(route: string): string[] {
  return Array.from(new Set(route.match(ROAD_CODE_RE) ?? []))
}

// 收集所有引用了某条道路的、尚未终结的巡护任务/无人机任务。
export function collectAffected(roadCode: string): AffectedRef[] {
  const result: AffectedRef[] = []
  for (const conf of LINK_MODULES) {
    for (const row of listRows(conf.key)) {
      const route = String(row[conf.routeField] ?? '')
      if (!route.includes(roadCode) || !conf.activeStatuses.includes(String(row.status))) continue
      result.push({ module: conf.key, id: Number(row.id), code: String(row[conf.codeField]), route })
    }
  }
  return result
}

function buildMarker(ref: AffectedRef, roads: EntryRow[]): string {
  const byCode = new Map(roads.map((road) => [String(road['道路编号']), road]))
  const closed: string[] = []
  const restricted: string[] = []
  for (const code of findRoadRefs(ref.route)) {
    const road = byCode.get(code)
    if (!road) continue
    if (String(road.status) === '封闭') closed.push(code)
    else if (String(road.status) === '限制通行') restricted.push(code)
  }
  if (closed.length) {
    return `【道路联动】${closed.join('、')} 封闭，暂停进入该路段，改走备用路线`
  }
  if (restricted.length) {
    return `【道路联动】${restricted.join('、')} 限制通行，按限宽/凭证要求安排`
  }
  return ''
}

// 依据当前全部道路状态，重算巡护任务与无人机路线的联动标记；
// 返回本次重算发生变化的引用（用于记台账）。
export function rebuildLinkageMarkers(changedRoadCode: string): LinkageEntry['affected'] {
  const roads = listRows('forestroad')
  const changes: LinkageEntry['affected'] = []
  for (const conf of LINK_MODULES) {
    const rows = listRows(conf.key)
    let mutated = false
    const next = rows.map((row) => {
      if (!conf.activeStatuses.includes(String(row.status))) return row
      const ref: AffectedRef = {
        module: conf.key,
        id: Number(row.id),
        code: String(row[conf.codeField]),
        route: String(row[conf.routeField] ?? ''),
      }
      if (!ref.route.includes(changedRoadCode)) return row
      const marker = buildMarker(ref, roads)
      const before = String(row['联动调整'] ?? '')
      if (marker === before) return row
      mutated = true
      const road = roads.find((item) => String(item['道路编号']) === changedRoadCode)
      const kind = marker.startsWith('【道路联动】') && marker.includes('封闭')
        ? '绕行'
        : marker
          ? '限行关注'
          : '解除恢复'
      changes.push({ module: conf.key, code: ref.code, marker, kind })
      return { ...row, 联动调整: marker }
    })
    if (mutated) saveRows(conf.key, next)
  }
  return changes
}

export function appendLinkage(entry: Omit<LinkageEntry, 'id' | 'time'>): LinkageEntry {
  const ledger = readLedger()
  const record: LinkageEntry = {
    ...entry,
    id: (ledger[0]?.id ?? 0) + 1,
    time: new Date().toLocaleString('zh-CN', { hour12: false }),
  }
  writeLedger([record, ...ledger].slice(0, 100))
  return record
}

export function readLedger(): LinkageEntry[] {
  if (typeof window === 'undefined' || !window.localStorage) return []
  try {
    return (JSON.parse(window.localStorage.getItem(LEDGER_KEY) ?? '[]') as LinkageEntry[])
  } catch {
    return []
  }
}

function writeLedger(ledger: LinkageEntry[]): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger))
  }
}

// 供页面展示各模块受影响的任务数。
export function linkageSummary(): { patrol: number; drone: number } {
  const count = (key: 'patrol' | 'drone'): number =>
    listRows(key).filter((row) => String(row['联动调整'] ?? '').startsWith('【道路联动】')).length
  return { patrol: count('patrol'), drone: count('drone') }
}
