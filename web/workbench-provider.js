import { h, button, header, api, write } from './workbench-core.js'
import { COURSE_PROVIDER_DEFAULTS, COURSE_PROVIDER_PRESETS, courseProviderSettings, courseProviderModelForUrl, courseProviderPresentation, courseProviderError, saveCourseProviderKey, syncCourseProviderCredential } from './course-provider.mjs'
import { probeCourseCapability } from './course-capability.mjs'

export async function providerConnectionView(ctx) {
  const isActive = () => { try { return typeof ctx.isActive !== 'function' || ctx.isActive() === true } catch { return false } }
  let current; let saving = false; let reading = false; let settingsEdited = false; let credentialEdited = false
  const panel = h('section', 'wb-paper cc-provider-panel')
  const state = h('div', 'cc-provider-status'); state.setAttribute('role', 'status')
  const message = h('p', 'cc-provider-message'); message.hidden = true; message.setAttribute('role', 'status')
  const credential = h('input'); credential.type = 'password'; credential.name = 'apiKey'; credential.autocomplete = 'off'; credential.spellcheck = false
  credential.setAttribute('aria-label', 'DeepSeek API Key'); credential.placeholder = '输入自己的 DeepSeek API Key'; credential.maxLength = 512
  credential.addEventListener('input', () => { credentialEdited = true })
  const endpoint = h('input'); endpoint.type = 'url'; endpoint.name = 'url'; endpoint.autocomplete = 'off'; endpoint.spellcheck = false; endpoint.required = true
  endpoint.setAttribute('aria-label', 'DeepSeek URL'); endpoint.setAttribute('list', 'cc-provider-urls')
  const model = h('input'); model.type = 'text'; model.name = 'model'; model.autocomplete = 'off'; model.spellcheck = false; model.required = true
  model.setAttribute('aria-label', 'DeepSeek model'); model.setAttribute('list', 'cc-provider-models')
  const urls = h('datalist'); urls.id = 'cc-provider-urls'
  const models = h('datalist'); models.id = 'cc-provider-models'
  for (const preset of COURSE_PROVIDER_PRESETS) {
    const urlOption = h('option'); urlOption.value = preset.url; urlOption.label = preset.model; urls.append(urlOption)
    const modelOption = h('option'); modelOption.value = preset.model; models.append(modelOption)
  }
  function syncSettings() {
    if (!isActive() || settingsEdited) return
    const settings = courseProviderSettings(current)
    endpoint.value = settings.url; model.value = settings.model
  }
  function changeUrl() {
    if (!isActive()) return
    settingsEdited = true
    const presetModel = courseProviderModelForUrl(endpoint.value)
    if (presetModel) model.value = presetModel
  }
  endpoint.addEventListener('input', changeUrl); endpoint.addEventListener('change', changeUrl)
  model.addEventListener('input', () => { settingsEdited = true }); model.addEventListener('change', () => { settingsEdited = true })
  syncSettings()
  const form = h('form', 'cc-provider-form'); form.autocomplete = 'off'
  const save = h('button', 'wb-button wb-primary', '保存供后续任务使用'); save.type = 'submit'; save.disabled = true
  const refresh = button('刷新连接状态', load, 'wb-text-button')
  const restore = button('恢复原设置', () => {
    if (!isActive() || saving || reading) return
    endpoint.value = COURSE_PROVIDER_DEFAULTS.url
    model.value = COURSE_PROVIDER_DEFAULTS.model
    credential.value = ''
    settingsEdited = true
    credentialEdited = true
    message.textContent = '已恢复项目默认设置。输入对应的 API Key 并保存后生效。'
    message.hidden = false
  }, 'wb-text-button')
  function update() {
    if (!isActive()) return
    const view = courseProviderPresentation(current)
    state.replaceChildren(h('strong', '', view.label), h('p', '', view.sourceLabel), h('p', '', view.taskState), h('p', '', view.actionHint), h('p', '', view.verificationHint))
    save.disabled = saving || reading
    credential.disabled = saving || reading
    endpoint.disabled = saving || reading; model.disabled = saving || reading
    refresh.disabled = saving || reading; restore.disabled = saving || reading
    save.textContent = saving ? '正在保存…' : '保存供后续任务使用'
  }
  async function load() {
    if (!isActive() || reading || saving) return
    reading = true; update()
    try {
      const result = await api('/course/provider-connection')
      if (!isActive()) return
      current = result; ctx.onDataConnected?.()
      if (!isActive()) return
      syncSettings(); syncCourseProviderCredential(credential, current, { edited: credentialEdited, isActive }); message.hidden = true
    } catch (error) {
      if (!isActive()) return
      current = undefined; syncCourseProviderCredential(credential, current, { edited: credentialEdited, isActive })
      message.textContent = courseProviderError(error); message.hidden = false
    } finally { reading = false; update() }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (!isActive() || saving || reading) return
    saving = true; update(); message.hidden = true
    try {
      const result = await saveCourseProviderKey(credential, body => api('/course/provider-connection', write('POST', body)), { url: endpoint.value, model: model.value }, { isActive })
      if (!isActive()) return
      current = result; ctx.onDataConnected?.()
      if (!isActive()) return
      credentialEdited = false; settingsEdited = false; syncSettings()
      const savedView = courseProviderPresentation(current)
      message.textContent = savedView.configured && savedView.connection === 'connected'
        ? 'Key 已保存，/models 连接校验成功。密码框已保留，可直接编辑。'
        : savedView.connection === 'failed'
          ? 'Key 已保存，但连接校验失败：当前为“已配置，未连接”。请检查 Key、账户权限或网络后重新保存。'
          : 'Key 已保存，连接状态待校验。'
      message.hidden = false
      if (ctx.cache) { ctx.cache.courseCapability = null; ctx.cache.courseAvailable = false }
      try {
        const capability = await probeCourseCapability()
        if (!isActive()) return
        if (ctx.setCourseCapability) ctx.setCourseCapability(capability)
        else if (ctx.cache) { ctx.cache.courseCapability = capability; ctx.cache.courseAvailable = capability.available }
      } catch { if (isActive()) message.textContent += '连接设置已保存，但能力状态未能刷新；请刷新网页后再开始。' }
    } catch (error) { if (isActive()) { credentialEdited = false; message.textContent = error.code === 'EMPTY_API_KEY' ? '请先输入 DeepSeek API Key。' : courseProviderError(error); message.hidden = false } }
    finally { saving = false; update() }
  })
  form.append(h('label', 'wb-field', h('span', 'wb-field-label', 'DeepSeek API Key'), credential), h('label', 'wb-field', h('span', 'wb-field-label', 'DeepSeek URL'), endpoint), urls, h('label', 'wb-field', h('span', 'wb-field-label', 'DeepSeek model'), model), models, h('div', 'wb-actions', save, refresh, restore))
  panel.append(h('h2', '', '接入你自己的模型'), state, form, message,
    h('p', 'cc-provider-note', '官方 DeepSeek 接口的 Key 可用于模型与资料服务；校园或自定义 URL 只配置模型，未配置官方资料服务时，官方搜索与网页读取不可用。模型连接成功不代表资料服务可用。提交时暂时清空输入框；连接校验成功后以密码圆点保留，可直接编辑。同一网页内切换工作区仍可保留，刷新网页后不保留。Key 只缓存在当前文档内存，不写入浏览器本地或会话存储，后台状态接口不返回 Key；服务器会话与环境变量单独维护。'),
    h('p', 'cc-provider-note', '更换 Key 前，正在运行、排队或持续监听的旧任务需要先“停止跟踪”；否则点击保存会被拒绝，原 Key 保持不变，并在下方提示。因服务故障而暂停、且没有下次唤醒安排的任务不必停止；保存后仍需你手动重试。'),
    h('p', 'cc-provider-note', '此处只保存连接设置，不会启动预测、自动重试失败任务或消耗模型调用额度。'))
  await load()
  if (!isActive()) return []
  return [header('模型连接', '使用你自己的 DeepSeek API Key，供研究员真实调用模型与资料服务。'), panel]
}
