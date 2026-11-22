export function roomShellTarget(value = '') {
  const raw = String(value || '#/room')
  const url = new URL(raw.startsWith('#') ? raw.slice(1) : raw, 'https://room.invalid')
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const hash = '#' + url.pathname + url.search
  if (!parts.length || parts[0] === 'room') return { kind: 'idle', hash: '#/room', parts, query: url.searchParams }
  if (parts[0] === 'course' && parts[1] && parts[1] !== 'new') return { kind: 'scene', id: parts[1], hash, parts, query: url.searchParams }
  return { kind: 'overlay', hash, parts, query: url.searchParams }
}

/** Scene and workspace generations are independent; this controller has no write operations. */
export function createRoomShellNavigation(hooks) {
  let sceneSerial = 0, overlaySerial = 0, sceneId = null, sceneHash = '#/room', overlayHash = null, overlayOpen = false, idleMounted = false
  const state = {
    get sceneSerial() { return sceneSerial }, get overlaySerial() { return overlaySerial },
    get sceneId() { return sceneId }, get sceneHash() { return sceneHash }, get overlayHash() { return overlayHash }, get overlayOpen() { return overlayOpen },
    isSceneCurrent: token => token === sceneSerial,
    isOverlayCurrent: token => overlayOpen && token === overlaySerial,
    rememberSceneHash(value) {
      if (!value) return
      const target = roomShellTarget(value)
      if ((target.kind === 'scene' && target.id === sceneId) || (target.kind === 'idle' && sceneId === null)) sceneHash = target.hash
    },
    closeOverlay({ restore = true, focus = true } = {}) {
      const wasOpen = overlayOpen
      overlayOpen = false; overlayHash = null; overlaySerial++
      if (wasOpen) hooks.closeOverlay?.({ focus })
      if (restore) hooks.replaceHash?.(sceneHash)
      if (focus && wasOpen) hooks.restoreFocus?.()
    },
    async navigate(value, { previousHash, forceOverlay = false, forceScene = false } = {}) {
      state.rememberSceneHash(previousHash)
      const target = roomShellTarget(value)
      if (target.kind === 'overlay') {
        if (!idleMounted && sceneId === null) { idleMounted = true; hooks.showIdle?.() }
        if (overlayOpen && overlayHash === target.hash && !forceOverlay) { hooks.revealOverlay?.(); return }
        const token = ++overlaySerial
        overlayOpen = true; overlayHash = target.hash
        hooks.prepareOverlay?.(target)
        await hooks.renderOverlay?.(target, token)
        return
      }
      state.closeOverlay({ restore: false, focus: false })
      const oldHash = sceneHash
      sceneHash = target.hash
      if (target.kind === 'idle') {
        if (sceneId !== null || !idleMounted) { sceneId = null; sceneSerial++; hooks.clearScene?.(); idleMounted = true; hooks.showIdle?.(); hooks.sceneChanged?.() }
        return
      }
      if (sceneId === target.id && !forceScene) {
        if (oldHash !== target.hash) hooks.selectRun?.(target.query.get('runId'))
        hooks.sceneChanged?.(); return
      }
      sceneId = target.id; idleMounted = false
      const token = ++sceneSerial
      hooks.clearScene?.(); hooks.sceneChanged?.()
      await hooks.mountScene?.(target, token)
    },
    dispose() { state.closeOverlay({ restore: false, focus: false }); sceneSerial++; hooks.clearScene?.() },
  }
  return state
}

/** Preserve records changed locally while a read was in flight, plus newly created records. */
export function mergeRoomHistory(incoming, current, baseline) {
  const id = value => value.requestId ?? value.id
  const before = new Map(baseline.map(value => [id(value), value]))
  const now = new Map(current.map(value => [id(value), value]))
  const result = incoming.map(value => now.has(id(value)) && now.get(id(value)) !== before.get(id(value)) ? now.get(id(value)) : value)
  const known = new Set(result.map(id))
  for (const value of current) if (!known.has(id(value)) && !before.has(id(value))) result.push(value)
  return result
}
