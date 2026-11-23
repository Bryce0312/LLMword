const chineseCharacters = /\p{Script=Han}/u
export const hasChineseText = value => typeof value === 'string' && chineseCharacters.test(value)

const languagePair = { sourceLanguage: 'zh', targetLanguage: 'en' }
const maximumEntries = 256
const maximumLength = 12000

// Presentation only. The browser's on-device translator gets display text, never form values.
export function createLocalTranslator(window) {
  const api = window?.Translator
  const cache = new Map()
  let ready
  let instance
  let closed = false
  let pending = 0

  function prepare() {
    if (closed || ready || typeof api?.create !== 'function') return ready
    // A fresh language pack may only be enabled by a real click. Call create
    // during that click, before an asynchronous availability check loses activation.
    const create = async () => {
      if (!window.navigator?.userActivation?.isActive && await api.availability(languagePair) !== 'available') return null
      if (closed) return null
      const translator = await api.create(languagePair)
      if (closed) { translator.destroy?.(); return null }
      instance = translator
      return translator
    }
    const attempt = create().catch(() => null)
    ready = attempt
    void attempt.then(translator => { if (!translator && ready === attempt) ready = undefined })
    return attempt
  }

  function translate(text) {
    const source = text.trim()
    if (!source || source.length > maximumLength || closed) return
    if (cache.has(source)) return cache.get(source)
    if (pending >= maximumEntries) return
    const promise = prepare()
    if (!promise) return
    pending++
    const result = promise.then(translator => translator?.translate(source)).then(output => {
      const english = typeof output === 'string' ? output.trim() : ''
      if (!english || hasChineseText(english)) return null
      return english
    }).catch(() => null).finally(() => { pending-- })
    cache.set(source, result)
    void result.then(output => {
      if (!output && cache.get(source) === result) cache.delete(source)
    })
    if (cache.size > maximumEntries) cache.delete(cache.keys().next().value)
    return result
  }

  return {
    prepare, translate,
    dispose() {
      closed = true
      instance?.destroy?.()
      cache.clear()
    },
  }
}
