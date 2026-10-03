<template>
  <section class="page" data-module="forestroad">
    <header class="page-head">
      <div>
        <h2>林区道路管理</h2>
        <p class="page-desc">维护林区道路台账，围绕道路等级、通行宽度、起点位置、终点位置与巡检日期登记；通行状态由「通行规则台」统一判定与切换。</p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn primary" to="/traffic-rule">前往通行规则台</RouterLink>
        <button class="btn" type="button" @click="exportRows">导出林区道路清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p v-if="backfilled > 0" class="compat-banner">
      存量兼容：{{ backfilled }} 条道路缺少巡检日期，已按首次巡检（2026-01-01）回填。
    </p>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.state" class="legend-item">
        {{ item.state }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>规则建议</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="view in filteredViews" :key="String(view.row.id)">
          <td v-for="column in columns" :key="column">{{ view.row[column] ?? '—' }}</td>
          <td>{{ view.state }}</td>
          <td>
            <span class="tag" :class="winnerClass(view.evaluation.winner)">
              {{ ruleLabel[view.evaluation.winner] }}
            </span>
            <span class="cell-sub">{{ view.evaluation.advice }}</span>
          </td>
        </tr>
        <tr v-if="!filteredViews.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无符合条件的林区道路</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ filteredViews.length }} 条林区道路记录 · 封闭、撤销、规则生效请到通行规则台操作</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, moduleMeta } from '@/api/local-service'
import { listRoadViews, type RoadView } from '@/domain/traffic-service'
import { RULE_LABEL } from '@/domain/traffic-rule'

const meta = moduleMeta('forestroad')
const columns = ["道路编号", "道路名称", "起点位置", "终点位置", "道路等级", "通行宽度", "最近巡检日", "巡检日期来源"]
const statuses = ["正常通行", "限制通行", "封闭通行"]
const ruleLabel = RULE_LABEL

const views = ref<RoadView[]>([])
const backfilled = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["道路编号", "道路名称", "起点位置"]

const filteredViews = computed(() => {
  const pairs = Object.entries(filters.value).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return views.value
  }
  return views.value.filter((view) =>
    pairs.every(([field, value]) => String(view.row[field] ?? '').includes(value.trim())),
  )
})

const statusSummary = computed(() =>
  statuses.map((state) => ({
    state,
    count: views.value.filter((view) => view.state === state).length,
  })),
)

const stats = computed(() => [
  { label: '道路总条数', value: views.value.length },
  { label: '限行段数', value: views.value.filter((view) => view.state === '限制通行').length },
  { label: '封闭段数', value: views.value.filter((view) => view.state === '封闭通行').length },
])

function winnerClass(code: string): string {
  if (code === 'manual-closure' || code === 'construction-closed') {
    return 'danger'
  }
  if (code === 'inspection-expired' || code === 'width-restricted') {
    return 'warn'
  }
  return 'ok'
}

function resetFilters() {
  filters.value = {}
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  errorMessage.value = ''
  try {
    views.value = listRoadViews()
    backfilled.value = views.value.filter((view) => view.evaluation.inspectBackfilled).length
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '林区道路列表读取失败'
  }
}

onMounted(reload)
</script>
