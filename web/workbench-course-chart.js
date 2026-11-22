import { h, fmt, empty, dataContent } from './workbench-core.js'
import { courseForecastPoints } from './course-projection.mjs'
const ns = 'http://www.w3.org/2000/svg'
function svgNode(name, attributes, text) { const el = document.createElementNS(ns, name); for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, value); if (text) el.textContent = text; return el }
export function courseChart(records, contract = {}) {
  const points = courseForecastPoints(records, { predictionId: contract.predictionId, predictionVersion: contract.version, targetAt: contract.targetAt })
  const box = h('section', 'wb-paper cc-chart-panel', h('h2', '', '判断怎样变化'), h('p', 'wb-muted', '横轴放大已观察时间。右侧未来区独立留白，不按未来时长比例，不画外推线。'))
  if (!points.length) { box.append(empty('还没有概率发布点', '报告、定时检查和等待状态都不会被填成 50% 或虚构曲线。')); return box }
  const left = 47; const right = 565; const top = 24; const bottom = 183
  const first = Date.parse(points[0].publishedAt)
  const now = Date.now()
  const end = Math.max(now, first + 1)
  const x = (date) => left + (date - first) / (end - first) * (right - left)
  const y = (probability) => bottom - probability * (bottom - top)
  const svg = svgNode('svg', { viewBox: '0 0 700 230', role: 'img', 'aria-label': '事件发生概率的历史更新轨迹，未来区留白' })
  const nowX = Math.min(right, x(now))
  svg.append(svgNode('rect', { x: 582, y: top, width: 94, height: bottom - top, fill: '#e6cda0' }))
  for (const value of [0, .5, 1]) { const lineY = y(value); svg.append(svgNode('line', { x1: left, x2: right, y1: lineY, y2: lineY, stroke: '#c2a77b', 'stroke-dasharray': '3 4' }), svgNode('text', { x: 4, y: lineY + 4 }, Math.round(value * 100) + '%')) }
  let path = 'M' + x(first) + ',' + y(points[0].probabilityYes)
  points.slice(1).forEach((point) => { path += 'H' + x(Date.parse(point.publishedAt)) + 'V' + y(point.probabilityYes) })
  if (points.length > 1) svg.append(svgNode('path', { d: path, stroke: '#557f72', 'stroke-width': 3, fill: 'none' }))
  for (const point of points) {
    const dot = svgNode('circle', { cx: x(Date.parse(point.publishedAt)), cy: y(point.probabilityYes), r: 5, fill: '#805936', stroke: '#f7e6ba', 'stroke-width': 2 })
    dot.append(svgNode('title', {}, fmt(point.publishedAt) + '：' + Math.round(point.probabilityYes * 100) + '%')); svg.append(dot)
  }
  svg.append(svgNode('line', { x1: nowX, x2: nowX, y1: top, y2: bottom, stroke: '#947555', 'stroke-dasharray': '4 4' }), svgNode('text', { x: right - 48, y: 210 }, '本图截至'), svgNode('text', { x: 590, y: 59 }, '未来未绘制'), svgNode('text', { x: 590, y: 78 }, '不按比例'))
  const precise = (raw) => new Date(raw).toLocaleString('zh-CN', { hour12: false })
  box.append(h('div', 'cc-chart-scroll', svg), h('p', 'wb-muted', '本图截至 ' + precise(now) + '；固定目标为 ' + fmt(contract.targetAt ?? points[0].targetAt)))
  const list = h('div', 'cc-chart-points')
  for (const point of points) {
    const item = h('details', '', h('summary', '', precise(point.publishedAt) + ' · Yes ' + Math.round(point.probabilityYes * 100) + '%'), dataContent('p', '', point.summary ?? point.rationale ?? '本次发布未提供公开摘要。'), h('small', '', '固定目标：' + fmt(point.targetAt ?? contract.targetAt)))
    item.dataset.forecastId = point.forecastId; list.append(item)
  }
  box.append(list); return box
}
