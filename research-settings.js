import { h, dateContent, dataContent, button, header, api, write, sourceLink } from './workbench-core.js'
import { PREDICTION_TOKEN_BUDGET_PRESETS, predictionBudgetPayload, createPredictionBudgetEditor, receivePredictionBudget, researchPricingPresentation } from './research-settings-model.js'

export function researchSettingsPanel() {
  let editor = createPredictionBudgetEditor()
  let loading = false; let saving = false; let ready = false; let message = ''; let failed = false
  const panel = h('section', 'wb-paper wb-research-settings')
  panel.setAttribute('aria-label', '预测任务预算与模型价格')
  const form = h('form', 'wb-research-settings-row'); form.noValidate = true
  const title = header('单次预测任务token总预算')
  const modes = h('div', 'wb-budget-modes'); modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', '预测预算模式')
  const limited = button('有限', () => changeMode('limited'), 'wb-budget-mode')
  const unlimited = button('无限', () => changeMode('unlimited'), 'wb-budget-mode')
  modes.append(limited, unlimited)
  const limit = h('input'); limit.type = 'text'; limit.name = 'maxTotalTokens'; limit.maxLength = 16
  limit.setAttribute('inputmode', 'numeric'); limit.setAttribute('aria-label', '单次预测 token 总预算')
  limit.setAttribute('role', 'combobox'); limit.setAttribute('aria-autocomplete', 'none'); limit.setAttribute('aria-haspopup', 'listbox')
  limit.setAttribute('aria-controls', 'wb-prediction-token-budgets'); limit.setAttribute('aria-expanded', 'false'); limit.autocomplete = 'off'
  let optionsOpen = false; let activeOption = -1
  const suggestions = h('div', 'wb-budget-options'); suggestions.id = 'wb-prediction-token-budgets'; suggestions.hidden = true
  suggestions.setAttribute('role', 'listbox'); suggestions.setAttribute('aria-label', '预设 token 总预算')
  const optionNodes = PREDICTION_TOKEN_BUDGET_PRESETS.map((amount, index) => {
    const option = dataContent('div', 'wb-budget-option', String(amount)); option.id = 'wb-prediction-token-option-' + index
    option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false')
    option.addEventListener('pointerdown', event => event.preventDefault())
    option.addEventListener('click', () => chooseBudget(index))
    suggestions.append(option); return option
  })
  const toggleOptions = button('▾', () => {
    if (limit.disabled) return
    if (optionsOpen) closeBudgetOptions()
    else { optionsOpen = true; activeOption = Math.max(0, PREDICTION_TOKEN_BUDGET_PRESETS.findIndex(amount => String(amount) === limit.value)); renderBudgetOptions() }
    limit.focus()
  }, 'wb-budget-toggle')
  toggleOptions.setAttribute('aria-label', '展开全部预算预设'); toggleOptions.setAttribute('aria-controls', suggestions.id); toggleOptions.setAttribute('aria-expanded', 'false')
  const amountField = h('div', 'wb-budget-amount', limit, toggleOptions, suggestions)
  amountField.addEventListener('focusout', event => { if (!amountField.contains(event.relatedTarget)) closeBudgetOptions() })
  limit.addEventListener('keydown', event => {
    if (limit.disabled) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      if (!optionsOpen) {
        optionsOpen = true
        const selected = PREDICTION_TOKEN_BUDGET_PRESETS.findIndex(amount => String(amount) === limit.value)
        activeOption = selected >= 0 ? selected : direction > 0 ? 0 : optionNodes.length - 1
      } else activeOption = Math.max(0, Math.min(optionNodes.length - 1, activeOption + direction))
      renderBudgetOptions()
    } else if (event.key === 'Enter' && optionsOpen) { event.preventDefault(); chooseBudget(activeOption) }
    else if (event.key === 'Escape' && optionsOpen) { event.preventDefault(); closeBudgetOptions() }
    else if (event.key === 'Tab') closeBudgetOptions()
  })
  const save = h('button', 'wb-button wb-primary wb-budget-save', '保存预算'); save.type = 'submit'
  const pricing = h('aside', 'wb-budget-pricing'); pricing.setAttribute('aria-label', '当前连接模型 token 单价')
  const status = h('p', 'wb-budget-status'); status.setAttribute('role', 'status')
  const refresh = button('刷新设置', () => { void load() }, 'wb-text-button')
  const note = h('p', 'wb-budget-note', '保存后仅对新建预测任务生效，已有任务与历史预算保持原值。无限仅取消整轮 token 总量限制，单次输出、调用次数和超时限制仍生效。')
  form.append(modes, amountField, save, pricing)
  panel.append(form, h('div', 'wb-budget-feedback', status, refresh), note)

  function savedSummary() {
    return !editor.saved ? '尚未读取已保存预算' : editor.saved.mode === 'unlimited' ? '当前已保存：无限' : '当前已保存：有限 ' + editor.saved.maxTotalTokens.toLocaleString('zh-CN') + ' tokens'
  }
  function update() {
    limited.setAttribute('aria-pressed', String(editor.mode === 'limited')); unlimited.setAttribute('aria-pressed', String(editor.mode === 'unlimited'))
    limited.disabled = saving; unlimited.disabled = saving
    if (limit.value !== editor.limitText) limit.value = editor.limitText
    limit.disabled = saving || editor.mode === 'unlimited'
    toggleOptions.disabled = limit.disabled
    if (limit.disabled) closeBudgetOptions()
    else renderBudgetOptions()
    save.disabled = loading || saving || !ready || !editor.dirty
    save.textContent = saving ? '正在保存…' : '保存预算'
    refresh.disabled = loading || saving
    status.dataset.state = failed ? 'error' : 'normal'
    status.textContent = message || (loading ? '正在读取预算设置…' : editor.dirty ? '有未保存的预算修改。' : savedSummary())
  }
  function renderBudgetOptions() {
    suggestions.hidden = !optionsOpen
    limit.setAttribute('aria-expanded', String(optionsOpen)); toggleOptions.setAttribute('aria-expanded', String(optionsOpen))
    toggleOptions.setAttribute('aria-label', optionsOpen ? '收起预算预设' : '展开全部预算预设')
    for (const [index, option] of optionNodes.entries()) {
      option.setAttribute('aria-selected', String(String(PREDICTION_TOKEN_BUDGET_PRESETS[index]) === limit.value))
      option.classList.toggle('is-active', optionsOpen && index === activeOption)
    }
    if (optionsOpen && optionNodes[activeOption]) limit.setAttribute('aria-activedescendant', optionNodes[activeOption].id)
    else limit.removeAttribute('aria-activedescendant')
  }
  function closeBudgetOptions() { optionsOpen = false; activeOption = -1; renderBudgetOptions() }
  function chooseBudget(index) {
    if (limit.disabled || !Number.isInteger(index) || index < 0 || index >= PREDICTION_TOKEN_BUDGET_PRESETS.length) return
    editor = { ...editor, limitText: String(PREDICTION_TOKEN_BUDGET_PRESETS[index]), dirty: true }
    message = ''; failed = false; closeBudgetOptions(); update(); limit.focus()
  }
  function changeMode(mode) {
    if (saving) return
    editor = { ...editor, mode, dirty: true }; message = ''; failed = false; update()
  }
  limit.addEventListener('input', () => { editor = { ...editor, limitText: limit.value, dirty: true }; message = ''; failed = false; update() })
  function renderPricing(connection) {
    const view = researchPricingPresentation(connection)
    pricing.dataset.state = view.status
    pricing.replaceChildren(h('strong', 'wb-budget-price-model', ...(view.model ? ['模型：', dataContent('span', '', view.model)] : ['当前模型单价'])))
    if (view.status !== 'available') { pricing.append(h('p', '', view.message)); return }
    pricing.append(h('small', '', view.unit + (view.periodLabel ? ' · ' + view.periodLabel : '')))
    const priceTable = h('table', 'wb-budget-price-table'); priceTable.setAttribute('aria-label', '模型每百万 token 单价')
    const columns = ['时段', '输入命中', '输入未命中', '输出'].map(label => { const cell = h('th', '', label); cell.scope = 'col'; return cell })
    const body = h('tbody')
    for (const row of view.rows) {
      const name = h('th', '', row.label); name.scope = 'row'
      body.append(h('tr', '', name, row.values.split(' / ').map(value => dataContent('td', '', value))))
    }
    priceTable.append(h('thead', '', h('tr', '', columns)), body); pricing.append(priceTable)
    if (view.schedule) pricing.append(h('small', 'wb-budget-price-schedule', view.schedule))
    const source = sourceLink({ url: view.sourceUrl }); if (source) source.textContent = '价格来源'
    pricing.append(h('div', 'wb-budget-price-meta', source, view.checkedAt ? h('small', '', '更新 ', dateContent(view.checkedAt)) : null))
  }
  async function load() {
    if (loading || saving) return
    loading = true; message = ''; failed = false; update()
    const [budget, provider] = await Promise.allSettled([api('/course/settings'), api('/course/provider-connection')])
    if (budget.status === 'fulfilled') {
      try { editor = receivePredictionBudget(editor, budget.value); ready = true }
      catch { message = '预算设置读取不完整，请重新读取；当前输入已保留。'; failed = true }
    } else { message = '预算设置读取失败，请重试；当前输入已保留。'; failed = true }
    if (provider.status === 'fulfilled') renderPricing(provider.value)
    else { pricing.dataset.state = 'unavailable'; pricing.replaceChildren(h('strong', '', '当前模型单价'), h('p', '', '暂未取得当前模型价格，请刷新设置重试。')) }
    loading = false; update()
  }
  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (loading || saving || !ready || !editor.dirty) return
    let payload
    try { payload = predictionBudgetPayload(editor.mode, editor.limitText) }
    catch (error) { failed = true; message = error.message; update(); limit.focus(); return }
    saving = true; failed = false; message = ''; update()
    try {
      const response = await api('/course/settings', write('PUT', payload))
      editor = receivePredictionBudget(editor, response, { committed: true })
      message = '预算已保存，仅对新建预测任务生效。'
    } catch { failed = true; message = '预算保存失败，原设置保持不变。' + savedSummary() + '；当前输入已保留，请重试。' }
    finally { saving = false; update() }
  })
  renderPricing(); update(); void load()
  return h('section', 'wb-research-settings-section', title, panel)
}
