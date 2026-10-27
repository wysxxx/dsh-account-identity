import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const tick = async () => { for (let i = 0; i < 30; i++) await new Promise(setImmediate) }
function makeForm(initial, defaults = {}) {
  let snapshot = initial
  const listeners = new Set(), writes = []
  const form = {
    allowed: true, writes,
    getSnapshot: () => snapshot,
    subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    publish(value) { snapshot = value; for (const fn of [...listeners]) fn() },
    async set(key, value) {
      writes.push({ key, value, accepted: form.allowed })
      if (!form.allowed) return false
      if (snapshot?.value?.[key] !== value) form.publish({ status: 'ready', value: { ...snapshot?.value, [key]: value } })
      if (form.afterSet) await form.afterSet(key)
      return true
    },
    async unset(key) {
      if (!form.allowed) return false
      const value = { ...snapshot?.value }; delete value[key]
      form.publish({ status: 'ready', value: { ...defaults, ...value } }); return true
    },
  }
  return form
}
function boot({ themeReady = true, themeName = 'Original Theme', displayName = 'Custom Name', avatarDataUrl = '', receipt = '', themeAllowed = true, identityAllowed = true, receiptGate } = {}) {
  const defaults = { enabled: true, displayName, avatarDataUrl, themeNameState: receipt }
  const identity = makeForm({ status: 'ready', value: defaults }, { themeNameState: '' })
  const theme = makeForm(themeReady ? { status: 'ready', value: { username: themeName } } : undefined)
  const absent = makeForm(undefined)
  identity.allowed = identityAllowed; theme.allowed = themeAllowed
  if (receiptGate) identity.afterSet = (key) => key === 'themeNameState' ? receiptGate : undefined
  const components = [], cleanups = []
  let plugin
  const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useEffect: () => {}, useRef: () => ({ current: null }), useState: (x) => [x, () => {}] }
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: (row) => {
    plugin = row.factory((id) => {
      if (id === 'react') return react
      throw new Error('Unexpected dependency: ' + id)
    })
  } } }, console, Set, Date, Boolean, Error }, { timeout: 1000 })
  const ctx = {
    effect(fn) { const stop = fn(); if (typeof stop === 'function') cleanups.push(stop) },
    locale: { register: () => () => {}, bind: () => (x) => x, getSnapshot: () => ({ active: 'en' }) },
    configForms: { get: (id) => id === 'account-identity' ? identity : id === 'ui-skin-claude-style' ? theme : absent },
    remote: {
      account: { getProfile: async () => ({ ok: true, value: { status: 'ready', value: {
        name: 'Account Name', contact: 'Synthetic Contact', avatarUrl: 'https://example.invalid/original.png',
      } } }) },
      $on: () => () => {},
      $stream: () => ({ async *[Symbol.asyncIterator]() { yield { value: { status: 'credential-stored' }, accept() {} } }, dispose() {} }),
    },
    slots: { inject: (_, fn) => fn(), register: (desc, component) => { components.push({ desc, component }); return () => {} } },
  }
  plugin.apply(ctx)
  return { identity, theme, components, async dispose() { for (const stop of cleanups.reverse()) await stop() } }
}
const checks = []
async function check(name, run) { await run(); checks.push(name); console.log('PASS ' + name) }
await check('launcher and popup use own classes and public overlay registration', async () => {
  const f = boot(); await tick()
  const row = f.components.find((x) => x.desc.name === 'settings.launcher')
  assert.ok(row)
  const injected = row.desc.inject()
  const props = { wide: true, settingsShortcut: { keys: ['⌘', ','], aria: 'Meta+,' }, openSettings() {}, t: (x) => x,
    useIdentity: (s) => s(injected.hooks.identity.getSnapshot()), useAccount: (s) => s(injected.hooks.account.getSnapshot()),
    useThemePresence: (s) => s(injected.hooks.themePresence.getSnapshot()), account: injected.account, overlays: injected.overlays }
  const tree = row.component(props)
  const button = tree.props.children.find((node) => node?.type === 'button')
  assert.ok(button); assert.equal(button.props['aria-expanded'], false)
  assert.equal(button.props['aria-haspopup'], 'menu'); assert.equal(button.props['data-signed-out'], false)
  assert.equal(typeof button.props.onKeyDown, 'function')
  assert.ok(f.components.find((x) => x.desc.name === 'shell.overlay' && x.desc.id === 'account-identity-menu'))
  await f.dispose()
})
await check('theme arriving after identity receives the name', async () => {
  const f = boot({ themeReady: false }); await tick()
  assert.equal(f.theme.writes.length, 0)
  f.theme.publish({ status: 'ready', value: { username: 'Late Original' } }); await tick()
  assert.equal(f.theme.getSnapshot().value.username, 'Custom Name'); await f.dispose()
  assert.equal(f.theme.getSnapshot().value.username, 'Late Original')
})
await check('refused theme write retries on a later update', async () => {
  const f = boot({ themeAllowed: false }); await tick()
  assert.equal(f.theme.getSnapshot().value.username, 'Original Theme')
  f.theme.allowed = true; f.theme.publish(f.theme.getSnapshot()); await tick()
  assert.equal(f.theme.getSnapshot().value.username, 'Custom Name'); await f.dispose()
})
await check('avatar-only customization leaves theme username untouched', async () => {
  const f = boot({ displayName: '', avatarDataUrl: 'synthetic-image' }); await tick()
  assert.equal(f.theme.writes.length, 0); await f.dispose()
})
await check('pause restores original username and resume reapplies custom name', async () => {
  const f = boot(); await tick(); await f.identity.set('enabled', false); await tick()
  assert.equal(f.theme.getSnapshot().value.username, 'Original Theme')
  assert.equal(f.identity.getSnapshot().value.themeNameState, '')
  await f.identity.set('enabled', true); await tick()
  assert.equal(f.theme.getSnapshot().value.username, 'Custom Name'); await f.dispose()
})
await check('saved ownership receipt survives a fresh plugin load', async () => {
  const receipt = JSON.stringify({ version: 1, entryId: 'ui-skin-claude-style', original: 'Before Plugin', applied: 'Custom Name', previous: 'Before Plugin' })
  const f = boot({ themeName: 'Custom Name', receipt }); await tick()
  await f.identity.set('enabled', false); await tick()
  assert.equal(f.theme.getSnapshot().value.username, 'Before Plugin'); await f.dispose()
})
await check('independent theme edit becomes the value restored on pause', async () => {
  const f = boot(); await tick(); await f.theme.set('username', 'New User Preference'); await tick()
  assert.equal(f.theme.getSnapshot().value.username, 'Custom Name')
  await f.identity.set('enabled', false); await tick()
  assert.equal(f.theme.getSnapshot().value.username, 'New User Preference'); await f.dispose()
})
await check('theme edit during receipt persistence is preserved for later restore', async () => {
  let release
  const receiptGate = new Promise((r) => { release = r })
  const f = boot({ receiptGate }); await tick()
  await f.theme.set('username', 'Concurrent Preference')
  release(); await tick()
  assert.equal(f.theme.getSnapshot().value.username, 'Custom Name')
  await f.identity.set('enabled', false); await tick()
  assert.equal(f.theme.getSnapshot().value.username, 'Concurrent Preference'); await f.dispose()
})
await check('ownership must be saved before another plugin is changed', async () => {
  const f = boot({ identityAllowed: false }); await tick()
  assert.equal(f.theme.writes.length, 0); await f.dispose()
})
await check('changing only name keeps original account avatar', async () => {
  const f = boot({ avatarDataUrl: '' }); await tick()
  const row = f.components.find((x) => x.desc.name === 'settings.launcher'), injected = row.desc.inject()
  const tree = row.component({ wide: true, openSettings() {}, t: (x) => x, account: injected.account, overlays: injected.overlays,
    useIdentity: (s) => s(injected.hooks.identity.getSnapshot()), useAccount: (s) => s(injected.hooks.account.getSnapshot()),
    useThemePresence: (s) => s(injected.hooks.themePresence.getSnapshot()) })
  const button = tree.props.children.find((x) => x?.type === 'button')
  const picture = button.props.children[0].props.children[0]
  assert.equal(picture.props.src, 'https://example.invalid/original.png'); await f.dispose()
})
await check('runtime dependency and styling contract excludes host internals', async () => {
  assert.deepEqual([...source.matchAll(/require\('([^']+)'\)/g)].map((x) => x[1]), ['react'])
  assert.doesNotMatch(source, /createPortal|document\.body\.append|hjANda_|--dsw-(?!alias-)/)
  assert.doesNotMatch(source, /(?:background|color):(?:#|rgba?\()/)
  assert.match(source, /role: 'presentation'/)
  assert.match(source, /'aria-keyshortcuts': settingsShortcut\?\.aria/)
})

// Pure event-lifetime and geometry tests supplement, rather than emulate, the real-browser suite.
let helpers
vm.runInNewContext(source.replace('module.exports = { apply, inject }', 'module.exports = { menuPosition, positionInSurface, observeComposition, cropRect, createOverlayStore, loadAvatar, encodeAvatar }'), {
  window: { __ModuleLoader__: { load: (row) => { helpers = row.factory((id) => {
    assert.equal(id, 'react'); return {}
  }) } } }, Set, Date, Boolean, Error,
}, { timeout: 1000 })
await check('composition closing key is protected once, then released', async () => {
  // Node 24's boolean capture removal differs from the DOM; normalize its options.
  class BrowserEventTarget extends EventTarget {
    addEventListener(type, listener, capture) { return super.addEventListener(type, listener, capture === true ? { capture: true } : capture) }
    removeEventListener(type, listener, capture) { return super.removeEventListener(type, listener, capture === true ? { capture: true } : capture) }
  }
  const target = new BrowserEventTarget(); target.defaultView = new BrowserEventTarget()
  const guard = helpers.observeComposition(target)
  target.dispatchEvent(new Event('compositionstart'))
  assert.equal(guard.guards({ keyCode: 27 }), true)
  target.dispatchEvent(new Event('compositionend'))
  assert.equal(guard.guards({ keyCode: 27, isComposing: false }), true)
  target.dispatchEvent(new Event('keyup'))
  assert.equal(guard.guards({ keyCode: 27 }), false)
  target.dispatchEvent(new Event('compositionstart')); target.defaultView.dispatchEvent(new Event('blur'))
  assert.equal(guard.guards({ keyCode: 27 }), false)
  guard.dispose(); target.dispatchEvent(new Event('compositionstart'))
  assert.equal(guard.guards({ keyCode: 27 }), false)
})
await check('menu placement flips below near the top and stays within viewport', async () => {
  const anchor = { top: 10, bottom: 46, left: 980, width: 30 }
  const position = helpers.menuPosition(anchor, { width: 220, height: 300 }, 1024, 768)
  assert.ok(position.top > anchor.bottom)
  assert.ok(position.left + position.minWidth <= 1024 - 12)
  assert.ok(position.top + 300 <= 768 - 12)
})
await check('short viewport constrains menu height above its anchor', async () => {
  const anchor = { top: 74, bottom: 110, left: 6, width: 280 }
  const position = helpers.menuPosition(anchor, { width: 300, height: 300 }, 320, 120)
  assert.ok(position.top >= 12); assert.ok(position.maxHeight <= anchor.top - 12)
  assert.ok(position.left >= 12); assert.ok(position.maxWidth <= 296)
})
await check('inherited zoom is converted once into overlay CSS units', async () => {
  const width = 1382, height = 804
  for (const zoom of [.75, 1, 1.5, 2]) {
    const popup = { width: 220 * zoom, height: 76 * zoom }
    const anchor = { left: 15, top: 735, bottom: 789, width: 244 }
    const surface = { left: 0, top: 0, width, height }
    const position = helpers.positionInSurface(anchor, popup, surface, width / zoom, height / zoom, width, height)
    assert.ok(position.top * zoom >= 0)
    assert.ok(position.top * zoom + Math.min(popup.height, position.maxHeight * zoom) <= height)
    assert.ok(position.left * zoom + position.minWidth * zoom <= width)
    assert.ok(position.top * zoom < anchor.top)
  }
})

await check('crop begins centred and preserves the selected off-centre subject', async () => {
  const first = helpers.cropRect(3200, 1800, { zoom: 1 })
  assert.equal(first.x, 700); assert.equal(first.y, 0); assert.equal(first.edge, 1800)
  const chosen = helpers.cropRect(3200, 1800, { zoom: 3, cx: 700, cy: 500 })
  assert.equal(chosen.x, 400); assert.equal(chosen.y, 200); assert.equal(chosen.edge, 600)
})
await check('crop movement clamps to image edges at each zoom', async () => {
  for (const [w, h] of [[3200,1800], [1800,3200], [2400,2400], [1,1]]) {
    for (const zoom of [1,2,4]) for (const [cx,cy] of [[-1e6,-1e6], [1e6,1e6], [w/2,h/2]]) {
      const r = helpers.cropRect(w,h,{zoom,cx,cy})
      assert.ok(r.x >= 0 && r.y >= 0)
      assert.ok(r.x+r.edge <= w+1e-9 && r.y+r.edge <= h+1e-9)
      assert.equal(r.edge,Math.min(w,h)/zoom)
    }
  }
})
await check('independent overlay owners cannot erase another active surface', async () => {
  const surface=helpers.createOverlayStore(), ownerA={}, ownerB={}
  surface.show(ownerA,'crop')
  surface.show(ownerB,null); assert.equal(surface.observable.getSnapshot().content,'crop')
  surface.clear(ownerB); assert.equal(surface.observable.getSnapshot().content,'crop')
  surface.clear(ownerA); assert.equal(surface.observable.getSnapshot(),null)
})
await check('switch and avatar masks declare real round corners and border-box thumb', async () => {
  assert.match(source,/switchThumb\{box-sizing:border-box;/)
  assert.match(source,/switchTrack\{[^']*corner-shape:round/)
  assert.match(source,/__avatar\{[^']*corner-shape:round/)
  assert.match(source,/__picture\{[^']*corner-shape:round/)
  assert.match(source,/root\.showModal\(\)/)
})

function imageHelpers(createBitmap, document) {
  let result
  vm.runInNewContext(source.replace('module.exports = { apply, inject }', 'module.exports = { loadAvatar, encodeAvatar }'), {
    window: { __ModuleLoader__: { load: (row) => { result = row.factory(() => ({})) } } },
    createImageBitmap: createBitmap, document,
  }, { timeout:1000 })
  return result
}
await check('large editing bitmap is resized with aspect ratio and original released', async () => {
  const original={width:7200,height:3600,closed:0,close(){this.closed++}}
  const resized={width:4096,height:2048,closed:0,close(){this.closed++}}
  let options
  const image=imageHelpers(async (input,opts)=> {if(opts){assert.equal(input,original);options=opts;return resized}return original})
  const result=await image.loadAvatar({})
  assert.equal(options.resizeWidth,4096);assert.equal(options.resizeHeight,2048)
  assert.equal(original.closed,1);assert.equal(resized.closed,0);assert.equal(result.bitmap,resized)
})
await check('invalid image dimensions release decoded bitmap', async () => {
  const bitmap={width:10000,height:10000,closed:0,close(){this.closed++}}
  const image=imageHelpers(async()=>bitmap)
  await assert.rejects(image.loadAvatar({}),/dimensions unsupported/)
  assert.equal(bitmap.closed,1)
})
await check('failed bitmap resize releases original without leaking ownership', async () => {
  const bitmap={width:7200,height:3600,closed:0,close(){this.closed++}}
  const image=imageHelpers(async(_,opts)=> {if(opts)throw Error('resize failed');return bitmap})
  await assert.rejects(image.loadAvatar({}),/resize failed/);assert.equal(bitmap.closed,1)
})
await check('export uses chosen off-centre square and exactly 128 pixels', async () => {
  let args
  const canvas={width:0,height:0,getContext(){return {drawImage(...v){args=v}}},toDataURL(type){assert.equal(type,'image/png');return 'data:image/png;synthetic'}}
  const image=imageHelpers(()=>{}, {createElement(name){assert.equal(name,'canvas');return canvas}})
  const bitmap={};const result=image.encodeAvatar({bitmap,width:3200,height:1800},{zoom:3,cx:700,cy:500})
  assert.equal(result,'data:image/png;synthetic');assert.equal(canvas.width,128);assert.equal(canvas.height,128)
  assert.deepEqual(args,[bitmap,400,200,600,600,0,0,128,128])
})
console.log(JSON.stringify({passed:checks.length,failed:0,scope:'state, compliance, crop geometry, decode ownership and export contract; browser pixel validation separate'}))
