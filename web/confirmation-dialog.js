import { h, dataContent, button } from './workbench-core.js'

let sequence = 0

/** A themed, transient confirmation; every dismissal resolves false. */
export function confirmationDialog(message, { trigger, title = '删除研究员席位' } = {}) {
  return new Promise(resolve => {
    const id = 'wb-confirmation-' + (++sequence)
    const dialog = h('dialog', 'wb-confirm-dialog')
    dialog.setAttribute('role', 'alertdialog'); dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('aria-labelledby', id + '-title'); dialog.setAttribute('aria-describedby', id + '-description')
    const heading = h('h2', '', title); heading.id = id + '-title'
    const description = h('div', 'wb-confirm-dialog-body'); description.id = id + '-description'
    for (const [index, paragraph] of String(message).split(/\n\n+/).entries()) description.append((index === 0 ? dataContent : h)('p', index === 0 ? 'wb-confirm-dialog-name' : paragraph.includes('新预测无法启动') ? 'wb-confirm-dialog-warning' : '', paragraph))
    const cancel = button('取消', () => finish(false), 'wb-button')
    cancel.autofocus = true
    const approve = button('确认删除', () => finish(true), 'wb-button wb-confirm-delete')
    const close = button('×', () => finish(false), 'wb-confirm-close'); close.setAttribute('aria-label', '取消并关闭弹框')
    dialog.append(h('div', 'wb-confirm-dialog-heading', heading, close), description, h('div', 'wb-confirm-dialog-actions', cancel, approve))
    let settled = false; let overlay = null; let ownerObserver = null; const inertElements = []
    const onRouteChange = () => finish(false)
    const onCancel = event => { event.preventDefault(); finish(false) }
    const onClose = () => finish(false)
    const onKeyDown = event => {
      if (event.key === 'Escape') { event.preventDefault(); finish(false); return }
      if (event.key !== 'Tab') return
      const controls = [...dialog.querySelectorAll('button:not([disabled])')]
      const first = controls[0], last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    const onBackdrop = event => {
      if (event.target === overlay) { finish(false); return }
      if (event.target !== dialog) return
      const rect = dialog.getBoundingClientRect()
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) finish(false)
    }
    function finish(approved) {
      if (settled) return
      settled = true; ownerObserver?.disconnect()
      window.removeEventListener('hashchange', onRouteChange); window.removeEventListener('popstate', onRouteChange); window.removeEventListener('pagehide', onRouteChange)
      dialog.removeEventListener('cancel', onCancel); dialog.removeEventListener('close', onClose); dialog.removeEventListener('keydown', onKeyDown); dialog.removeEventListener('click', onBackdrop)
      overlay?.removeEventListener('click', onBackdrop)
      if (dialog.open && typeof dialog.close === 'function') dialog.close()
      if (overlay) overlay.remove(); else dialog.remove()
      for (const element of inertElements) element.removeAttribute('inert')
      resolve(approved === true)
      setTimeout(() => { if (trigger?.isConnected && !trigger.disabled) trigger.focus() }, 0)
    }
    function mountFallback() {
      dialog.classList.add('is-fallback'); dialog.setAttribute('open', '')
      overlay = h('div', 'wb-confirm-overlay', dialog); document.body.append(overlay)
      for (const element of [...document.body.children]) if (element !== overlay && !element.hasAttribute('inert')) { element.setAttribute('inert', ''); inertElements.push(element) }
      overlay.addEventListener('click', onBackdrop)
    }
    dialog.addEventListener('cancel', onCancel); dialog.addEventListener('close', onClose); dialog.addEventListener('keydown', onKeyDown); dialog.addEventListener('click', onBackdrop)
    window.addEventListener('hashchange', onRouteChange); window.addEventListener('popstate', onRouteChange); window.addEventListener('pagehide', onRouteChange)
    document.body.append(dialog)
    if (typeof dialog.showModal === 'function') { try { dialog.showModal() } catch { mountFallback() } }
    else mountFallback()
    cancel.focus()
    if (typeof MutationObserver === 'function') {
      ownerObserver = new MutationObserver(() => { if (!dialog.isConnected || (trigger && !trigger.isConnected)) finish(false) })
      ownerObserver.observe(document.body, { childList: true, subtree: true })
    }
    if (trigger && !trigger.isConnected) finish(false)
  })
}
