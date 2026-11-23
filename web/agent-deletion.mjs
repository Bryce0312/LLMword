/** A deletion can only be requested after the user confirms this specific seat. */
export function createAgentDeletionAction(agent, { confirm, request, availableCount }) {
  let pending = false
  return async function deleteSeat() {
    if (pending) return { deleted: false, busy: true }
    if (!agent?.agentSpecId || !Number.isSafeInteger(agent.specVersion) || agent.specVersion < 1) throw Object.assign(new Error('研究员定义版本缺失，请刷新后再试。'), { code: 'AGENT_DELETE_INVALID_VERSION' })
    pending = true
    try {
      const name = agent.name || agent.agentSpecId
      const count = typeof availableCount === 'function' ? availableCount() : availableCount
      const consequence = agent.agentSpecId === 'verification' ? '\n\n删除后将缺少核验席，新预测无法启动。' : Number.isSafeInteger(count) && count <= 3 ? '\n\n删除后可用研究员将不足三类，新预测无法启动。' : ''
      let approved
      try { approved = await confirm('确认删除研究员“' + name + '”？\n\n确认后，该席位不再用于新任务；已保存的历史定义、运行与报告保留。' + consequence) }
      catch { return { deleted: false, cancelled: true } }
      if (approved !== true) return { deleted: false, cancelled: true }
      const result = await request('/agents/' + encodeURIComponent(agent.agentSpecId), { method: 'DELETE', body: { expectedVersion: agent.specVersion } })
      if (result?.deleted !== true || result.agentSpecId !== agent.agentSpecId) throw Object.assign(new Error('删除结果未确认，请刷新列表核对。'), { code: 'AGENT_DELETE_UNCONFIRMED' })
      return result
    } finally { pending = false }
  }
}

export function agentDeletionError(error = {}) {
  if (error.code === 'AGENT_DELETE_INVALID_VERSION') return '研究员定义版本缺失，席位未删除。请刷新后再试。'
  if (error.code === 'AGENT_DELETE_UNCONFIRMED') return '服务未确认删除结果，当前列表暂不移除。请刷新列表核对。'
  if (error.status === 401 || error.status === 403) return '没有删除该研究员席位的权限，席位未移除。'
  if (error.status === 404) return '找不到该研究员席位，请刷新列表核对。'
  if (error.code === 'AGENT_IN_USE') return '仍有调查正在运行或排队，请待其结束或停止后再删除。'
  if (error.status === 409) return '研究员定义已更新或当前不允许删除，席位未移除。请刷新列表后重试。'
  return '删除未能确认，当前列表暂不移除。请刷新核对后重试。'
}
