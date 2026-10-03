// 临时验证脚本：构建后可删除。用桩件模拟 localStorage / window，验证通行规则核心链路。
const storage = new Map<string, string>()
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  },
}

import { SEED_ROWS } from '../src/data/seed'
storage.set('forest-fire-patrol:entries', JSON.stringify({ forestroad: SEED_ROWS.forestroad, patrol: SEED_ROWS.patrol, drone: SEED_ROWS.drone }))

const { listRoadViews, applyRoadRule, manualClose, revokeClose, listAdjustments, normalizeRoads } = await import(
  '../src/domain/traffic-service'
)
const { canSwitch } = await import('../src/domain/traffic-rule')

let pass = 0
let fail = 0
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass += 1
    console.log(`  ✅ ${name}`)
  } else {
    fail += 1
    console.log(`  ❌ ${name}\n     expected ${e}\n     actual   ${a}`)
  }
}

console.log('1) 存量巡检日期回填')
const { backfilled } = normalizeRoads()
check('仅 FORE-0005 一条回填', backfilled, 1)

console.log('2) 规则引擎判定（今天 2026-10-03）')
const views = listRoadViews()
const byCode = Object.fromEntries(views.map((v) => [v.row['道路编号'], v]))
check('FORE-0001 正常', byCode['FORE-0001'].evaluation.winner, 'normal')
check('FORE-0002 宽度限制（3.2<3.5）', byCode['FORE-0002'].evaluation.winner, 'width-restricted')
check('FORE-0003 巡检+宽度同时命中取巡检优先', byCode['FORE-0003'].evaluation.winner, 'inspection-expired')
check('FORE-0004 施工封闭最高', byCode['FORE-0004'].evaluation.winner, 'construction-closed')
check('FORE-0005 缺日期回填后超期→巡检到期', byCode['FORE-0005'].evaluation.winner, 'inspection-expired')
check('FORE-0005 回填标记', byCode['FORE-0005'].evaluation.inspectBackfilled, true)
check('FORE-0006 正常', byCode['FORE-0006'].evaluation.winner, 'normal')
check('施工/巡检/宽度建议态', [byCode['FORE-0002'].state, byCode['FORE-0003'].state, byCode['FORE-0004'].state], ['限制通行', '限制通行', '封闭通行'])

console.log('3) 规则生效 + 跨模块联动（FORE-0004 施工封闭）')
applyRoadRule(4, '值班员')
const patr1r = listAdjustments('patrol').find((a) => a.targetCode === 'PATR-0001')
const dron1r = listAdjustments('drone').find((a) => a.targetCode === 'DRON-0001')
check('命中待执行巡护任务→改线', patr1r?.action, 'reroute')
check('命中待执行无人机→改线', dron1r?.action, 'reroute')
check('施工封闭共产生2条联动', listAdjustments().length, 2)

console.log('4) FORE-0001 规则生效（正常态，无联动）')
applyRoadRule(1, '值班员')
check('正常道路不新增联动', listAdjustments().length, 2)

console.log('5) FORE-0002 限行生效→执行中任务避让')
applyRoadRule(2, '值班员')
const patr2 = listAdjustments('patrol').find((a) => a.targetCode === 'PATR-0002')
const dron2 = listAdjustments('drone').find((a) => a.targetCode === 'DRON-0002')
check('执行中巡护→避让', patr2?.action, 'avoid')
check('飞行中无人机→避让', dron2?.action, 'avoid')

console.log('6) 人工封闭凌驾自动规则')
const mc = manualClose(2, '火情封控', '张指挥')
check('人工封闭成功', mc.ok, true)
const v2 = listRoadViews().find((v) => Number(v.row.id) === 2)!
check('人工封闭覆盖宽度限制', v2.evaluation.winner, 'manual-closure')
check('人工封闭建议态', v2.state, '封闭通行')
check('重复封闭被拒', manualClose(2, '临时管制', '李队长').ok, false)

console.log('7) 状态机合法方向')
check('正常可封', canSwitch('正常通行', '封闭通行'), true)
check('封不能直接回限制以外？允许封→限制/正常', canSwitch('封闭通行', '正常通行'), true)
check('正常不能跳过限制？正常可到限制', canSwitch('正常通行', '限制通行'), true)

console.log('8) 两个终端并发撤销，只允许先落库一次')
const v2b = listRoadViews().find((v) => Number(v.row.id) === 2)!
const baseVersion = v2b.version
const rA = revokeClose(2, baseVersion, '终端A')
const rB = revokeClose(2, baseVersion, '终端B')
check('终端A 撤销成功', rA.ok, true)
check('终端B 同版本撤销被拒', rB.ok, false)
const v2c = listRoadViews().find((v) => Number(v.row.id) === 2)!
check('撤销后版本号+1', v2c.version, baseVersion + 1)
check('撤销后回到自动规则（宽度限制）', v2c.state, '限制通行')
check('人工凌驾解除', v2c.evaluation.manualOverride, false)
const unresolved = listAdjustments().filter((a) => !a.resolved).length
check('道路2联动标记解除（保留道路4两条）', unresolved, 2)

console.log('9) 撤销已开放道路被拒')
check('无封闭记录撤销被拒', revokeClose(1, v2c.version, '终端A').ok, false)

console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail > 0) {
  process.exit(1)
}
