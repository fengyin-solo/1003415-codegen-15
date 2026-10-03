<template>
  <section class="page" data-module="forestroad">
    <header class="page-head">
      <div>
        <h2>林区道路通行规则台</h2>
        <p class="page-desc">
          按道路等级、通行宽度、起点位置、终点位置与封闭原因判定建议通行状态，逐条给出判定标准；
          规则生效后联动调整巡护任务与无人机路线。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出道路清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="rule-panel">
      <h3>判定标准与优先级（冲突时人工封闭压过一切自动规则）</h3>
      <ol class="rule-list">
        <li v-for="rule in ruleBook" :key="rule.code" :class="{ 'rule-manual': rule.code === 'manual_close' }">
          <strong>{{ rule.name }}</strong>
          <span class="rule-criteria">{{ rule.criteria }}</span>
          <span class="rule-target">命中 → {{ rule.target }}</span>
        </li>
      </ol>
      <p class="rule-note">
        自动规则优先级：施工封闭 &gt; 巡检到期 &gt; 宽度限制 &gt; 起终点管控；
        通行状态只能沿合法方向切换：正常通行 ⇄ 限制通行 → 封闭 → 限制通行（封闭解除必须先复检，不能直接放行）。
        存量道路缺少巡检日期时按首次巡检（{{ baseline }}）兼容回填后再判定。
      </p>
    </section>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>道路编号</span>
        <input v-model="filters.keyword" placeholder="按道路编号/名称检索" />
      </label>
      <label class="filter-item">
        <span>起终点</span>
        <input v-model="filters.endpoint" placeholder="按起点/终点位置检索" />
      </label>
      <label class="filter-item">
        <span>通行状态</span>
        <select v-model="filters.status">
          <option value="">全部</option>
          <option v-for="s in statuses" :key="s" :value="s">{{ s }}</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table road-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>规则建议</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="row in filteredRows" :key="String(row.id)">
          <tr :class="{ 'row-closed': row.status === '封闭', 'row-locked': row.status === '限制通行' }">
            <td>{{ row['道路编号'] }}<span class="version-tag">v{{ versionOf(row) }}</span></td>
            <td>{{ row['道路名称'] }}</td>
            <td>{{ row['道路等级'] }}</td>
            <td>{{ row['通行宽度'] }}</td>
            <td>{{ row['起点位置'] }}</td>
            <td>{{ row['终点位置'] }}</td>
            <td>
              {{ row['最近巡检日'] }}
              <span v-if="row.decision.inspectionBackfilled || row['巡检回填']" class="backfill-tag">首次巡检回填</span>
            </td>
            <td>{{ row['封闭原因'] || '—' }}<span v-if="row['封闭类型']" class="closure-type">{{ row['封闭类型'] }}</span></td>
            <td>
              <span :class="['status-pill', statusClass(row.status)]">{{ row.status }}</span>
              <button class="link detail-link" type="button" @click="toggleDetail(row.id)">
                {{ expandedId === row.id ? '收起判定' : '查看判定' }}
              </button>
            </td>
            <td>
              <span :class="['status-pill', statusClass(row.decision.suggested)]">{{ row.decision.suggested }}</span>
              <small class="winner-text" v-if="row.decision.winner">（{{ row.decision.winner.name }}）</small>
            </td>
            <td class="row-actions">
              <button v-if="canManual(row)" class="link" type="button" @click="manualClose(row)">人工封闭</button>
              <button v-if="row.status !== '封闭'" class="link" type="button" @click="registerConstruction(row)">登记施工</button>
              <button v-if="row.decision.suggested !== row.status" class="link" type="button" @click="adopt(row)">采纳建议</button>
              <button v-if="row.status === '限制通行'" class="link" type="button" @click="recheck(row)">复检恢复</button>
              <button v-if="row.status === '封闭'" class="link danger" type="button" @click="revoke(row)">撤销封闭</button>
              <button
                v-if="row.status === '封闭'"
                class="link danger"
                type="button"
                title="模拟另一终端持有旧版本号同时撤销"
                @click="revokeStale(row)"
              >
                并发撤销模拟
              </button>
            </td>
          </tr>
          <tr v-if="expandedId === row.id" class="detail-row">
            <td :colspan="columns.length + 3">
              <table class="hit-table">
                <thead>
                  <tr><th>规则</th><th>判定标准</th><th>结果</th><th>命中说明</th></tr>
                </thead>
                <tbody>
                  <tr v-for="hit in row.decision.hits" :key="hit.code" :class="{ 'hit-on': hit.hit, 'hit-winner': hit === row.decision.winner }">
                    <td>{{ hit.name }}</td>
                    <td class="criteria-cell">{{ hit.criteria }}</td>
                    <td>{{ hit.hit ? (hit === row.decision.winner ? '命中·生效' : '命中') : '未命中' }}</td>
                    <td>{{ hit.detail }}</td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>
        </template>
        <tr v-if="!filteredRows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无符合条件的林区道路</td>
        </tr>
      </tbody>
    </table>

    <section class="ledger-panel">
      <h3>联动台账（规则生效后巡护任务与无人机路线的调整记录）</h3>
      <p v-if="!ledger.length" class="muted-cell">暂无联动记录；道路封闭或限制生效后，引用该道路的巡护任务、无人机路线会自动调整。</p>
      <table v-else class="data-table">
        <thead>
          <tr><th>时间</th><th>道路</th><th>道路状态</th><th>原因</th><th>联动调整</th></tr>
        </thead>
        <tbody>
          <tr v-for="entry in ledger" :key="entry.id">
            <td>{{ entry.time }}</td>
            <td>{{ entry.roadCode }}</td>
            <td>{{ entry.roadStatus }}</td>
            <td>{{ entry.reason }}</td>
            <td>
              <span v-for="(item, i) in entry.affected" :key="i" class="ledger-item">
                {{ item.module === 'patrol' ? '巡护' : '无人机' }} {{ item.code }}：{{ item.kind }}
                <template v-if="item.marker">（{{ item.marker.replace('【道路联动】', '') }}）</template>
              </span>
              <span v-if="!entry.affected.length" class="muted-cell">无在途任务受影响</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ filteredRows.length }} 条林区道路 · 数据版本随每次落库递增，撤销封闭走乐观锁（先落库的终端生效）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="okMessage" class="ok-text">{{ okMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import { downloadEntries, moduleMeta } from '@/api/local-service'
import { listRows } from '@/data/local-store'
import { readLedger } from '@/api/road-linkage'
import type { LinkageEntry } from '@/api/road-linkage'
import { FIRST_INSPECTION_BASELINE } from '@/data/road-rules'
import type { RuleCode } from '@/data/road-rules'
import { listRoadDesk, runRoadAction, type RoadDeskRow } from '@/api/road-service'

const meta = moduleMeta('forestroad')
const columns = ["道路编号", "道路名称", "道路等级", "通行宽度", "起点位置", "终点位置", "最近巡检日", "封闭原因"]
const statuses = ["正常通行", "限制通行", "封闭"]
const baseline = FIRST_INSPECTION_BASELINE

const ruleBook: { code: RuleCode; name: string; criteria: string; target: string }[] = [
  { code: 'manual_close', name: '人工封闭', criteria: '封闭原因含人工/应急/火险管控/戒严令等指令；与施工冲突时以人工封闭为准', target: '封闭' },
  { code: 'construction_close', name: '施工封闭', criteria: '封闭原因含施工/养护/水毁/塌方等施工类事由，施工期间封闭', target: '封闭' },
  { code: 'inspection_expired', name: '巡检到期', criteria: '最近巡检日超过道路等级对应周期（一级30天/二级60天/三级90天/等外120天），缺日期按首次巡检回填后计算', target: '限制通行' },
  { code: 'width_limit', name: '宽度限制', criteria: '实测通行宽度低于等级下限（一级4.0/二级3.5/三级3.0/等外2.5米），大型车辆绕行', target: '限制通行' },
  { code: 'endpoint_control', name: '起终点管控', criteria: '起点位置或终点位置位于管控区（核心火险管控区、封禁育林区卡口），凭证通行', target: '限制通行' },
]

const rows = ref<RoadDeskRow[]>([])
const ledger = ref<LinkageEntry[]>([])
const expandedId = ref<number | null>(null)
const errorMessage = ref('')
const okMessage = ref('')
const filters = ref({ keyword: '', endpoint: '', status: '' })

const filteredRows = computed(() =>
  rows.value.filter((row) => {
    const keyword = filters.value.keyword.trim()
    const endpoint = filters.value.endpoint.trim()
    const hitKeyword =
      !keyword ||
      String(row['道路编号']).includes(keyword) ||
      String(row['道路名称']).includes(keyword)
    const hitEndpoint =
      !endpoint ||
      String(row['起点位置']).includes(endpoint) ||
      String(row['终点位置']).includes(endpoint)
    const hitStatus = !filters.value.status || String(row.status) === filters.value.status
    return hitKeyword && hitEndpoint && hitStatus
  }),
)

const stats = computed(() => {
  const count = (status: string) => rows.value.filter((row) => String(row.status) === status).length
  const linked = (key: string) =>
    listRows(key).filter((item) => String(item['联动调整'] ?? '').startsWith('【道路联动】')).length
  return [
    { label: '正常通行', value: count('正常通行') },
    { label: '限制通行', value: count('限制通行') },
    { label: '封闭', value: count('封闭') },
    { label: '联动巡护任务', value: Number(linked('patrol') ?? 0) },
    { label: '联动无人机路线', value: Number(linked('drone') ?? 0) },
  ]
})

function versionOf(row: RoadDeskRow): number {
  const v = Number(row['版本'])
  return Number.isFinite(v) ? v : 0
}

function statusClass(status: string): string {
  if (status === '封闭') return 'pill-closed'
  if (status === '限制通行') return 'pill-locked'
  return 'pill-open'
}

function canManual(row: RoadDeskRow): boolean {
  return row.status !== '封闭' || row['封闭类型'] !== '人工'
}

function toggleDetail(id: number) {
  expandedId.value = expandedId.value === id ? null : id
}

function resetFilters() {
  filters.value = { keyword: '', endpoint: '', status: '' }
}

function exportRows() {
  downloadEntries(meta.key)
}

function report(result: ReturnType<typeof runRoadAction>): void {
  if (result.ok) {
    okMessage.value = result.message
    errorMessage.value = ''
  } else {
    errorMessage.value = result.message
    okMessage.value = ''
  }
  reload()
}

function askReason(title: string): string | null {
  const reason = window.prompt(title)
  return reason === null ? null : reason
}

function manualClose(row: RoadDeskRow) {
  const reason = askReason('请填写人工封闭原因（如戒严令、应急管控指令）：')
  if (reason === null) return
  report(runRoadAction(Number(row.id), '人工封闭', { reason }))
}

function registerConstruction(row: RoadDeskRow) {
  const reason = askReason('请填写施工封闭原因（路段、施工内容、预计完工时间）：')
  if (reason === null) return
  report(runRoadAction(Number(row.id), '登记施工', { reason }))
}

function adopt(row: RoadDeskRow) {
  report(runRoadAction(Number(row.id), '采纳建议'))
}

function recheck(row: RoadDeskRow) {
  report(runRoadAction(Number(row.id), '复检恢复'))
}

function revoke(row: RoadDeskRow) {
  // 携带页面当前看到的版本号；若另一终端已先撤销/变更，CAS 比对失败会被拒绝。
  report(runRoadAction(Number(row.id), '撤销封闭', { expectedVersion: versionOf(row) }))
}

function revokeStale(row: RoadDeskRow) {
  // 模拟第二个终端拿着上一版数据并发撤销：预期被乐观锁拒绝。
  report(runRoadAction(Number(row.id), '撤销封闭', { expectedVersion: versionOf(row) - 1 }))
}

function reload() {
  try {
    rows.value = listRoadDesk()
    ledger.value = readLedger()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '通行规则台数据读取失败'
  }
}

// 两个终端（浏览器标签页）并发时，别的终端落库后本页自动刷新到最新版本。
function onStorage(event: StorageEvent) {
  if (event.key?.startsWith('forest-fire-patrol:entries')) {
    reload()
  }
}

onMounted(() => {
  reload()
  window.addEventListener('storage', onStorage)
})
onUnmounted(() => window.removeEventListener('storage', onStorage))
</script>
