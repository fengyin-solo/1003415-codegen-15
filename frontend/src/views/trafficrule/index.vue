<template>
  <section class="page" data-module="traffic-rule">
    <header class="page-head">
      <div>
        <h2>通行规则台</h2>
        <p class="page-desc">
          按道路等级、通行宽度、起点位置、终点位置与封闭原因判定建议通行状态，规则生效后联动调整巡护任务与无人机路线。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="reload">重新判定</button>
      </div>
    </header>

    <p v-if="backfilled > 0" class="compat-banner">
      存量兼容：{{ backfilled }} 条林区道路缺少巡检日期，已按首次巡检（2026-01-01）回填并标记「首次巡检兼容回填」。
    </p>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="item.cls">{{ item.value }}</strong>
      </article>
    </div>

    <section class="rule-panel">
      <h3>判定标准与自动规则优先级</h3>
      <p class="rule-note">
        自动规则同时命中时按固定优先级采纳：<b>施工封闭 &gt; 巡检到期 &gt; 宽度限制</b>；
        <b>人工封闭凌驾全部自动规则</b>（现场管控指令优先），撤销人工封闭后再回到自动规则重新判定。
      </p>
      <table class="data-table">
        <thead>
          <tr>
            <th>道路等级</th>
            <th>宽度限制阈值</th>
            <th>巡检周期</th>
            <th>宽度命中处置</th>
            <th>巡检命中处置</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="policy in gradePolicies" :key="policy.grade">
            <td>{{ policy.grade }}</td>
            <td>低于 {{ policy.minWidth.toFixed(1) }}m → 限制通行</td>
            <td>{{ policy.inspectCycleDays }} 天，超期 → 限制通行</td>
            <td>{{ policy.widthAdvice }}</td>
            <td>{{ policy.inspectAdvice }}</td>
          </tr>
        </tbody>
      </table>
      <p class="rule-note">
        施工封闭：道路存在生效施工登记/施工封闭记录 → 封闭通行；
        人工封闭：登记封闭原因（{{ closureReasons.join('、') }}）→ 封闭通行。
        起点位置、终点位置用于唯一标识路段并匹配巡护/无人机路线。
      </p>
    </section>

    <p class="status-legend">
      <span v-for="item in legend" :key="item.state" class="legend-item" :class="item.cls">
        {{ item.state }}：{{ item.count }}
      </span>
    </p>

    <table class="data-table">
      <thead>
        <tr>
          <th>道路编号 / 名称</th>
          <th>起点 → 终点</th>
          <th>等级</th>
          <th>通行宽度</th>
          <th>最近巡检日</th>
          <th>封闭情况</th>
          <th>当前状态</th>
          <th>规则建议</th>
          <th>每条道路判定标准</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="view in views" :key="String(view.row.id)" :class="stateRowClass(view.state)">
          <td>
            <div>{{ view.row['道路编号'] }}</div>
            <div class="cell-sub">{{ view.row['道路名称'] }}</div>
          </td>
          <td>{{ view.row['起点位置'] }} → {{ view.row['终点位置'] }}</td>
          <td>{{ view.evaluation.grade || '未填写' }}</td>
          <td>
            {{ view.row['通行宽度'] }}
            <div v-if="view.evaluation.widthMeters !== null" class="cell-sub">
              解析 {{ view.evaluation.widthMeters }}m
            </div>
          </td>
          <td>
            {{ view.evaluation.inspectDate }}
            <div v-if="view.evaluation.inspectBackfilled" class="tag warn">首次巡检回填</div>
            <div
              v-else-if="view.evaluation.inspectOverdueDays !== null && view.evaluation.inspectOverdueDays > 0"
              class="tag warn"
            >
              已超期 {{ view.evaluation.inspectOverdueDays }} 天
            </div>
          </td>
          <td>
            <template v-if="view.closure">
              <div class="tag danger">{{ view.closure.source === 'manual' ? '人工封闭' : '施工封闭' }}</div>
              <div class="cell-sub">{{ view.closure.reason }}</div>
            </template>
            <template v-else-if="String(view.row['施工登记'] ?? '') === '是'">
              <div class="tag danger">施工封闭（自动）</div>
            </template>
            <span v-else class="cell-sub">无</span>
          </td>
          <td><span class="state-chip" :class="chipClass(view.state)">{{ view.state }}</span></td>
          <td>
            <div class="tag" :class="winnerClass(view.evaluation.winner)">
              {{ ruleLabel[view.evaluation.winner] }}
              <template v-if="view.evaluation.manualOverride">（覆盖自动规则）</template>
            </div>
          </td>
          <td class="criterion-cell">
            <ul class="hit-list">
              <li v-for="hit in view.evaluation.hits" :key="hit.code" :class="{ hit: hit.hit }">
                <span class="hit-dot" :class="{ on: hit.hit }"></span>
                <b>{{ ruleLabel[hit.code] }}：</b>{{ hit.criterion }}
              </li>
            </ul>
            <p class="advice">{{ view.evaluation.advice }}</p>
          </td>
          <td class="row-actions vertical">
            <button class="btn small primary" type="button" @click="onApply(view)">规则生效</button>
            <button
              class="btn small"
              type="button"
              :disabled="view.closure !== null || String(view.row['施工登记'] ?? '') === '是'"
              @click="openClose(view)"
            >
              人工封闭
            </button>
            <button
              class="btn small"
              type="button"
              :disabled="view.closure === null"
              @click="onRevoke(view, view.version)"
            >
              撤销封闭
            </button>
          </td>
        </tr>
        <tr v-if="!views.length">
          <td colspan="10" class="empty-state">暂无林区道路数据</td>
        </tr>
      </tbody>
    </table>

    <section class="rule-panel" v-if="adjustments.length">
      <h3>联动调整记录（巡护任务 / 无人机路线）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>模块</th>
            <th>任务编号</th>
            <th>触发路段</th>
            <th>道路状态</th>
            <th>调整方式</th>
            <th>说明</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in adjustments" :key="item.id">
            <td>{{ item.module === 'patrol' ? '巡护任务' : '无人机巡查' }}</td>
            <td>{{ item.targetCode }}</td>
            <td>{{ item.roadName }}</td>
            <td>{{ item.state }}</td>
            <td>{{ item.action === 'reroute' ? '自动改线绕行' : '执行中就近避让' }}</td>
            <td>{{ item.note }}</td>
            <td>
              <span class="tag" :class="item.resolved ? 'ok' : 'warn'">
                {{ item.resolved ? '道路已放行，联动解除' : '生效中' }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="rule-panel demo-panel">
      <h3>并发撤销演示（两个终端同时撤销同一条封闭）</h3>
      <p class="rule-note">
        选择一条已封闭道路，终端 A、B 基于同一版本号各自点击撤销；先落库的一次成功并把版本号 +1，
        另一次因乐观锁版本不一致被拒绝。
      </p>
      <div class="demo-bar">
        <label class="filter-item">
          <span>演示道路</span>
          <select v-model="demoRoadId">
            <option v-for="view in closedViews" :key="String(view.row.id)" :value="Number(view.row.id)">
              {{ view.row['道路名称'] }}（版本 {{ view.version }}）
            </option>
          </select>
        </label>
        <button class="btn" type="button" :disabled="!demoRoadId" @click="runConcurrentRevoke">
          终端A、B 同时撤销
        </button>
      </div>
      <ul v-if="demoLogs.length" class="demo-log">
        <li v-for="(log, index) in demoLogs" :key="index" :class="log.ok ? 'ok' : 'fail'">{{ log.text }}</li>
      </ul>
    </section>

    <!-- 人工封闭原因登记 -->
    <div v-if="closing" class="modal-mask" @click.self="closing = null">
      <div class="modal-box">
        <h3>人工封闭 · {{ closing.view.row['道路名称'] }}</h3>
        <p class="rule-note">起点 {{ closing.view.row['起点位置'] }} → 终点 {{ closing.view.row['终点位置'] }}</p>
        <label class="filter-item">
          <span>封闭原因</span>
          <select v-model="closing.reason">
            <option v-for="reason in closureReasons" :key="reason" :value="reason">{{ reason }}</option>
          </select>
        </label>
        <label class="filter-item">
          <span>操作人</span>
          <input v-model="closing.operator" placeholder="值班员姓名" />
        </label>
        <p v-if="closing.message" class="error-text">{{ closing.message }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closing = null">取消</button>
          <button class="btn primary" type="button" @click="confirmClose">确认封闭</button>
        </div>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ views.length }} 条林区道路 · 通行状态仅按合法方向切换</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  applyRoadRule,
  closureHistory,
  listAdjustments,
  listRoadViews,
  manualClose,
  revokeClose,
  type RoadView,
  type RouteAdjustment,
} from '@/domain/traffic-service'
import {
  CLOSURE_REASONS,
  GRADE_POLICIES,
  RULE_LABEL,
  type ClosureReason,
  type TrafficState,
} from '@/domain/traffic-rule'

const gradePolicies = GRADE_POLICIES
const ruleLabel = RULE_LABEL
const closureReasons = [...CLOSURE_REASONS]

const views = ref<RoadView[]>([])
const adjustments = ref<RouteAdjustment[]>([])
const backfilled = ref(0)
const message = ref('')
const messageOk = ref(true)

type ClosingState = { view: RoadView; reason: ClosureReason; operator: string; message: string }
const closing = ref<ClosingState | null>(null)

const demoRoadId = ref<number | null>(null)
const demoLogs = ref<{ ok: boolean; text: string }[]>([])

const legend = computed(() => {
  const states: TrafficState[] = ['正常通行', '限制通行', '封闭通行']
  return states.map((state) => ({
    state,
    count: views.value.filter((view) => view.state === state).length,
    cls: chipClass(state),
  }))
})

const stats = computed(() => [
  { label: '道路总数', value: views.value.length, cls: '' },
  {
    label: '正常通行',
    value: views.value.filter((view) => view.state === '正常通行').length,
    cls: 'num-ok',
  },
  {
    label: '限制通行',
    value: views.value.filter((view) => view.state === '限制通行').length,
    cls: 'num-warn',
  },
  {
    label: '封闭通行',
    value: views.value.filter((view) => view.state === '封闭通行').length,
    cls: 'num-danger',
  },
  {
    label: '联动任务/路线',
    value: adjustments.value.filter((item) => !item.resolved).length,
    cls: 'num-warn',
  },
])

const closedViews = computed(() =>
  views.value.filter((view) => view.state === '封闭通行' && view.closure !== null),
)

function chipClass(state: TrafficState): string {
  if (state === '封闭通行') {
    return 'chip-danger'
  }
  if (state === '限制通行') {
    return 'chip-warn'
  }
  return 'chip-ok'
}

function stateRowClass(state: TrafficState): string {
  if (state === '封闭通行') {
    return 'row-danger'
  }
  if (state === '限制通行') {
    return 'row-warn'
  }
  return ''
}

function winnerClass(code: string): string {
  if (code === 'manual-closure' || code === 'construction-closed') {
    return 'danger'
  }
  if (code === 'inspection-expired' || code === 'width-restricted') {
    return 'warn'
  }
  return 'ok'
}

function flash(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
}

function reload() {
  views.value = listRoadViews()
  adjustments.value = listAdjustments()
  backfilled.value = views.value.filter((view) => view.evaluation.inspectBackfilled).length
}

function onApply(view: RoadView) {
  const result = applyRoadRule(Number(view.row.id), '值班员')
  reload()
  flash(result.ok, result.message)
}

function openClose(view: RoadView) {
  closing.value = { view, reason: '现场施工', operator: '', message: '' }
}

function confirmClose() {
  if (!closing.value) {
    return
  }
  if (!closing.value.operator.trim()) {
    closing.value.message = '请填写操作人，人工封闭须留痕'
    return
  }
  const result = manualClose(
    Number(closing.value.view.row.id),
    closing.value.reason,
    closing.value.operator.trim(),
  )
  if (!result.ok) {
    closing.value.message = result.message
    return
  }
  closing.value = null
  reload()
  flash(true, result.message)
}

function onRevoke(view: RoadView, expectedVersion: number) {
  const result = revokeClose(Number(view.row.id), expectedVersion, '值班员')
  reload()
  flash(result.ok, result.message)
}

/** 两个终端在同一版本基线上并发撤销：模拟同一事件循环里的两次带相同版本号的落库请求 */
function runConcurrentRevoke() {
  if (demoRoadId.value === null) {
    return
  }
  const roadId = demoRoadId.value
  const target = views.value.find((view) => Number(view.row.id) === roadId)
  if (!target) {
    return
  }
  const baseVersion = target.version
  const historyBefore = closureHistory(roadId).length

  // 两次请求携带同一版本号，顺序提交即模拟先/后落库
  const resultA = revokeClose(roadId, baseVersion, '终端A')
  const resultB = revokeClose(roadId, baseVersion, '终端B')
  const historyAfter = closureHistory(roadId).length

  demoLogs.value = [
    {
      ok: resultA.ok,
      text: `终端A 携带版本号 ${baseVersion} 撤销：${resultA.ok ? '✅ 成功落库' : `❌ ${resultA.message}`}`,
    },
    {
      ok: resultB.ok,
      text: `终端B 携带版本号 ${baseVersion} 撤销：${resultB.ok ? '✅ 成功落库' : `❌ 被拒绝（${resultB.message}）`}`,
    },
    {
      ok: true,
      text: `封闭流水由 ${historyBefore} 条变为 ${historyAfter} 条：仅先落库的一次产生了撤销记录`,
    },
  ]
  reload()
  demoRoadId.value = null
}

onMounted(reload)
</script>
