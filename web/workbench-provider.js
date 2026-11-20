import { h, link, button, header, api, write, route } from './workbench-core.js'
import { courseProviderPresentation, courseProviderError, saveCourseProviderKey } from './course-provider.mjs'
import { probeCourseCapability } from './course-capability.mjs'

export async function providerConnectionView(ctx) {
  let current; let saving = false; let reading = false
  const panel = h('section', 'wb-paper cc-provider-panel')
  const state = h('div', 'cc-provider-status'); state.setAttribute('role', 'status')
  const message = h('p', 'cc-provider-message'); message.hidden = true; message.setAttribute('role', 'status')
  const credential = h('input'); credential.type = 'password'; credential.name = 'apiKey'; credential.autocomplete = 'off'; credential.spellcheck = false
  credential.setAttribute('aria-label', 'DeepSeek API Key'); credential.placeholder = '输入自己的 DeepSeek API Key'; credential.maxLength = 512
  const form = h('form', 'cc-provider-form'); form.autocomplete = 'off'
  const save = h('button', 'wb-button wb-primary', '保存供后续任务使用'); save.type = 'submit'; save.disabled = true
  const refresh = button('刷新连接状态', load, 'wb-text-button')
  function connectionStatus(text, failed = false) {
    if (route().parts[0] !== 'model-connection') return
    const node = document.getElementById('wb-connection'); if (!node) return
    node.textContent = text
    if (failed) node.dataset.state = 'reconnecting'
    else delete node.dataset.state
  }
  function update() {
    const view = courseProviderPresentation(current)
    state.replaceChildren(h('strong', '', view.label), h('p', '', view.sourceLabel), h('p', '', view.taskState), h('p', '', view.actionHint), h('p', '', view.verificationHint))
    save.disabled = saving || reading
    credential.disabled = saving || reading
    refresh.disabled = saving || reading
    save.textContent = saving ? '正在保存…' : '保存供后续任务使用'
  }
  async function load() {
    if (reading || saving) return
    reading = true; update()
    connectionStatus('正在读取模型配置')
    try { current = await api('/course/provider-connection'); message.hidden = true; connectionStatus('模型配置已读取') }
    catch (error) { current = undefined; message.textContent = courseProviderError(error); message.hidden = false; connectionStatus('模型配置读取失败', true) }
    finally { reading = false; update() }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (saving || reading) return
    saving = true; update(); message.hidden = true
    try {
      current = await saveCourseProviderKey(credential, body => api('/course/provider-connection', write('POST', body)))
      const savedView = courseProviderPresentation(current)
      connectionStatus('模型配置已保存')
      message.textContent = savedView.connection === 'connected'
        ? 'Key 已保存，/models 连接校验成功。'
        : savedView.connection === 'failed'
          ? 'Key 已保存，但连接校验失败：当前为“已配置，未连接”。请检查 Key、账户权限或网络后重新保存。'
          : 'Key 已保存，连接状态待校验。'
      message.hidden = false
      if (ctx.cache) { ctx.cache.courseCapability = null; ctx.cache.courseAvailable = false }
      try {
        const capability = await probeCourseCapability()
        if (ctx.setCourseCapability) ctx.setCourseCapability(capability)
        else if (ctx.cache) { ctx.cache.courseCapability = capability; ctx.cache.courseAvailable = capability.available }
      } catch { message.textContent += '连接设置已保存，但能力状态未能刷新；请刷新网页后再开始。'; connectionStatus('配置已保存，能力状态待刷新', true) }
    } catch (error) { message.textContent = error.code === 'EMPTY_API_KEY' ? '请先输入 DeepSeek API Key。' : courseProviderError(error); message.hidden = false; if (error.code !== 'EMPTY_API_KEY') connectionStatus('模型配置未能保存', true) }
    finally { credential.value = ''; saving = false; update() }
  })
  form.append(h('label', 'wb-field', h('span', 'wb-field-label', 'DeepSeek API Key'), credential), h('div', 'wb-actions', save, refresh))
  panel.append(h('h2', '', '接入你自己的模型'), state, form, message,
    h('p', 'cc-provider-note', '这个 Key 同时用于 DeepSeek 模型、搜索和网页读取。输入框提交后立即清空；页面不会回显 Key，也不把它写入浏览器本地存储。Key 仅在服务器当前进程的会话内存中保存，重启后需重新填写；服务端环境变量单独维护。'),
    h('p', 'cc-provider-note', '更换 Key 前，正在运行、排队或持续监听的旧任务需要先“停止跟踪”；否则点击保存会被拒绝，原 Key 保持不变，并在下方提示。因服务故障而暂停、且没有下次唤醒安排的任务不必停止；保存后仍需你手动重试。'),
    h('p', 'cc-provider-note', '此处只保存连接设置，不会启动预测、自动重试失败任务或消耗模型调用额度。'))
  await load()
  return [header('模型连接', '使用你自己的 DeepSeek API Key，供研究员真实调用模型与资料服务。', link('返回任务公告栏', '#/predictions', 'wb-button')), panel]
}
