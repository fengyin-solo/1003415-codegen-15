<template>
  <section v-if="items.length" class="adjust-banner">
    <h4>道路通行规则联动调整（{{ items.length }}）</h4>
    <ul>
      <li v-for="item in items" :key="item.id" :class="{ resolved: item.resolved }">
        <span class="tag" :class="item.resolved ? 'ok' : 'warn'">
          {{ item.resolved ? '已解除' : item.state }}
        </span>
        <b>{{ item.targetCode }}</b>
        受「{{ item.roadName }}」{{ item.action === 'reroute' ? '自动改线绕行' : '就近避让' }}：{{ item.note }}
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'

import { listAdjustments } from '@/domain/traffic-service'
import type { RouteAdjustment } from '@/domain/traffic-service'

const props = defineProps<{ module: 'patrol' | 'drone'; tick?: number }>()

const items = computed<RouteAdjustment[]>(() => {
  void props.tick
  return listAdjustments(props.module)
})
</script>
