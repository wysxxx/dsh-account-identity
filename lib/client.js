window.__ModuleLoader__.load({
  id: 'dsh-account-identity',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { createElement: h, useEffect, useLayoutEffect, useRef, useState } = React

    /** Host settings entry id, which is also the Client's settings namespace. */
    const ENTRY_ID = 'account-identity'

    /**
     * Priority below the shipped launcher's implicit 0. A `single` slot renders
     * the lowest priority; registering at the same priority throws.
     */
    const SHADOW_PRIORITY = -1

    /** Rejected above this size before any decode is attempted. */
    const MAX_SOURCE_BYTES = 8 * 1024 * 1024

    /** Longest edge of the stored square, in pixels. */
    const AVATAR_EDGE = 128

    /** Longest accepted display name, matching the Host schema. */
    const NAME_LIMIT = 40

    /** Services the launcher, the notices, the settings row, and the account calls need. */
    const inject = ['slots', 'locale', 'remote', 'remote.account', 'configForms']

    /**
     * Build the identity metadata the account Remote methods require.
     *
     * The shipped value is inlined by its own build; this plugin reads the
     * release the running page booted from, so it reports the truth for whatever
     * build hosts it rather than a frozen number. The Host forwards the value as
     * a request header without validating its content.
     * @param ctx - the Client plugin context.
     * @returns metadata accepted by the Host.
     */
    function clientMetadata(ctx) {
      const boot = typeof window === 'undefined' ? undefined : window.__DSH_BOOT__
      const version = boot && boot.release && typeof boot.release.version === 'string'
        ? boot.release.version
        : ''
      return {
        version: version !== '' ? version : 'unknown',
        locale: ctx.locale.getSnapshot().active,
        timezoneOffsetSeconds: -(new Date().getTimezoneOffset() * 60),
      }
    }

    /**
     * Read the accepted value section of the plugin settings form.
     * @param form - the form returned by `ctx.configForms.get`.
     * @returns current display name and avatar data URL, empty when unset.
     */
    function readSettings(form) {
      const snapshot = form && typeof form.getSnapshot === 'function' ? form.getSnapshot() : undefined
      const section = snapshot ? snapshot.value : undefined
      return {
        // Absent means "not written yet", which is the enabled default.
        enabled: section === undefined || section.enabled !== false,
        displayName: section && typeof section.displayName === 'string' ? section.displayName : '',
        avatarDataUrl: section && typeof section.avatarDataUrl === 'string' ? section.avatarDataUrl : '',
      }
    }

    /**
     * Whether the configured override changes what the sidebar shows.
     * @param settings - current values.
     * @returns whether to occupy the launcher slot.
     */
    function hasOverride(settings) {
      if (!settings.enabled) return false
      return settings.displayName.trim() !== '' || settings.avatarDataUrl !== ''
    }

    /**
     * Build a tiny observable over a mutable cell.
     * @param read - returns the current value.
     * @returns the observable plus a publish function.
     */
    function createCell(read) {
      const listeners = new Set()
      let published = read()
      return {
        observable: {
          getSnapshot: () => published,
          subscribe: (listener) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
        },
        publish: () => {
          published = read()
          for (const listener of [...listeners]) listener()
        },
      }
    }

    /** One selection model is shared by rendering, pointer/keyboard moves and PNG export. */
    function cropRect(width, height, selection) {
      const zoom = Math.max(1, Math.min(4, Number(selection.zoom) || 1))
      const edge = Math.min(width, height) / zoom
      const cx = Math.max(edge / 2, Math.min(width - edge / 2,
        Number.isFinite(selection.cx) ? selection.cx : width / 2))
      const cy = Math.max(edge / 2, Math.min(height - edge / 2,
        Number.isFinite(selection.cy) ? selection.cy : height / 2))
      return { x: cx - edge / 2, y: cy - edge / 2, edge, cx, cy, zoom }
    }

    /** Decode locally, cap the editing surface, and transfer ownership to the setting page. */
    async function loadAvatar(file) {
      let bitmap = await createImageBitmap(file)
      try {
        if (bitmap.width <= 0 || bitmap.height <= 0 || bitmap.width * bitmap.height > 40 * 1024 * 1024)
          throw new Error('account-identity: image dimensions unsupported')
        const ratio = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height))
        if (ratio < 1) {
          const resized = await createImageBitmap(bitmap, { resizeWidth: Math.max(1, Math.round(bitmap.width * ratio)),
            resizeHeight: Math.max(1, Math.round(bitmap.height * ratio)), resizeQuality: 'high' })
          bitmap.close(); bitmap = resized
        }
        return { bitmap, width: bitmap.width, height: bitmap.height }
      } catch (cause) { bitmap.close(); throw cause }
    }

    /** Store only the chosen square, never the original file or a baked circular mask. */
    function encodeAvatar(source, selection) {
      const rect = cropRect(source.width, source.height, selection)
      const canvas = document.createElement('canvas')
      canvas.width = AVATAR_EDGE; canvas.height = AVATAR_EDGE
      const context = canvas.getContext('2d')
      if (!context) throw new Error('account-identity: no 2D context')
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high'
      context.drawImage(source.bitmap, rect.x, rect.y, rect.edge, rect.edge, 0, 0, AVATAR_EDGE, AVATAR_EDGE)
      return canvas.toDataURL('image/png')
    }

    /** Native top layer keeps this plugin-owned dialog above the host settings dialog. */
    function AvatarCropDialog({ source, busy, error, onCancel, onConfirm, returnFocus, t }) {
      const initial = () => ({ zoom: 1, cx: source.width / 2, cy: source.height / 2 })
      const [selection, setSelection] = useState(initial)
      const [limits, setLimits] = useState(undefined)
      const dialog = useRef(null), stage = useRef(null), canvas = useRef(null), preview = useRef(null)
      const drag = useRef(null), latest = useRef({ busy, onCancel }), composition = useRef(null), resizeCrop = useRef(null)
      latest.current = { busy, onCancel }
      const rect = cropRect(source.width, source.height, selection)
      const move = (dx, dy) => {
        const view = stage.current?.getBoundingClientRect()
        if (!view || view.width <= 0) return
        setSelection((old) => {
          const r = cropRect(source.width, source.height, old)
          return cropRect(source.width, source.height, { zoom: r.zoom,
            cx: r.cx - dx * r.edge / (view.width * .72), cy: r.cy - dy * r.edge / (view.height * .72) })
        })
      }
      const setZoom = (zoom) => setSelection((old) => cropRect(source.width, source.height, { ...old, zoom }))

      useLayoutEffect(() => {
        const root = dialog.current
        if (!root) return
        const previousFocus = document.activeElement
        if (!root.open) root.showModal()
        stage.current?.focus({ preventScroll: true })
        const resize = () => {
          const box = root.getBoundingClientRect()
          // Preserve fractional CSS widths: offsetWidth rounds them and can
          // feed a different zoom back into the observer on narrow viewports.
          const cssWidth = parseFloat(getComputedStyle(root).width)
          const scale = cssWidth > 0 ? box.width / cssWidth : 1
          const maxWidth = Math.max(160, Math.floor((window.innerWidth - 32) / scale))
          const maxHeight = Math.max(160, Math.floor((window.innerHeight - 32) / scale))
          const nonImageHeight = root.scrollHeight - (stage.current?.offsetHeight || 0)
            + root.offsetHeight - root.clientHeight
          const edge = Math.max(96, Math.min(320, Math.floor(maxHeight - nonImageHeight))) + 'px'
          setLimits((old) => old?.maxWidth === maxWidth && old?.maxHeight === maxHeight
            && old?.['--dsh-account-identity-crop-edge'] === edge ? old
            : { maxWidth, maxHeight, '--dsh-account-identity-crop-edge': edge })
        }
        resizeCrop.current = resize
        resize(); window.addEventListener('resize', resize)
        const layoutObserver = new ResizeObserver(resize); layoutObserver.observe(root)
        composition.current = observeComposition(document)
        // Host modals listen on document. Own only Escape/Tab here, before
        // that handler, while our native top-layer dialog owns the interaction.
        const keyboard = (event) => {
          if (!root.open || !['Escape', 'Tab'].includes(event.key)) return
          if (!root.contains(event.target) && !root.contains(document.activeElement) && document.activeElement !== document.body) return
          event.preventDefault(); event.stopImmediatePropagation()
          if (composition.current?.guards(event)) return
          if (event.key === 'Escape') {
            if (!latest.current.busy) latest.current.onCancel()
            return
          }
          const items = focusableIn(root), index = items.indexOf(document.activeElement)
          const nextIndex = index < 0 ? (event.shiftKey ? items.length - 1 : 0)
            : (index + (event.shiftKey ? -1 : 1) + items.length) % items.length
          const next = items.length ? items[nextIndex] : root
          next.focus({ preventScroll: true })
        }
        window.addEventListener('keydown', keyboard, true)
        return () => {
          composition.current?.dispose(); composition.current = null
          resizeCrop.current = null; layoutObserver.disconnect()
          window.removeEventListener('resize', resize)
          window.removeEventListener('keydown', keyboard, true)
          const active = document.activeElement
          const shouldReturn = root.contains(active) || active === document.body
          if (root.open) root.close()
          if (shouldReturn) queueMicrotask(() => {
            const target = returnFocus.current
            if (target?.isConnected && !target.disabled &&
                (document.activeElement === previousFocus || document.activeElement === document.body || root.contains(document.activeElement)))
              target.focus({ preventScroll: true })
          })
        }
      }, [])

      useLayoutEffect(() => { resizeCrop.current?.() }, [error])

      useLayoutEffect(() => {
        const root = stage.current
        if (!root) return
        const draw = () => {
          const size = root.clientWidth
          if (!size) return
          const pixelRatio = Math.min(2, window.devicePixelRatio || 1)
          const target = canvas.current
          const pixels = Math.max(1, Math.round(size * pixelRatio))
          if (target.width !== pixels) { target.width = pixels; target.height = pixels }
          const ctx = target.getContext('2d')
          const r = cropRect(source.width, source.height, selection)
          const scale = size * .72 / r.edge
          ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
          ctx.clearRect(0, 0, size, size)
          ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'
          ctx.drawImage(source.bitmap, size / 2 - r.cx * scale, size / 2 - r.cy * scale,
            source.width * scale, source.height * scale)
          const small = preview.current.getContext('2d')
          small.clearRect(0, 0, 64, 64); small.imageSmoothingQuality = 'high'
          small.drawImage(source.bitmap, r.x, r.y, r.edge, r.edge, 0, 0, 64, 64)
        }
        draw()
        const observer = new ResizeObserver(draw); observer.observe(root)
        return () => observer.disconnect()
      }, [source, selection])

      return h('dialog', { ref: dialog, className: 'dsh-account-identity__cropDialog',
        style: limits, 'aria-label': t('cropTitle'), 'aria-describedby': 'account-identity-crop-help',
        onKeyDown: (event) => {
          event.stopPropagation()
          if (composition.current?.guards(event)) { if (event.key === 'Escape') event.preventDefault(); return }
          if (event.key === 'Escape') {
            event.preventDefault(); if (!busy) onCancel(); return
          }
          if (event.target !== stage.current || busy || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return
          event.preventDefault()
          const distance = (stage.current?.getBoundingClientRect().width || 0) * (event.shiftKey ? .08 : .02)
          move(event.key === 'ArrowLeft' ? -distance : event.key === 'ArrowRight' ? distance : 0,
            event.key === 'ArrowUp' ? -distance : event.key === 'ArrowDown' ? distance : 0)
        },
        onCancel: (event) => { event.preventDefault(); if (!busy) onCancel() },
        onClose: () => { if (!busy) onCancel() },
        onPointerDown: (event) => {
          if (event.target !== event.currentTarget || busy) return
          const box = event.currentTarget.getBoundingClientRect()
          if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onCancel()
        },
      },
        h('h3', { className: 'dsh-account-identity__dialogTitle' }, t('cropTitle')),
        h('p', { id: 'account-identity-crop-help', className: 'dsh-account-identity__cropHelp' }, t('cropHelp')),
        h('div', { ref: stage, className: 'dsh-account-identity__cropStage', tabIndex: 0,
          role: 'group', 'aria-label': t('cropPosition'),
          onPointerDown: (event) => {
            if (busy || (event.pointerType === 'mouse' && event.button !== 0) || drag.current) return
            event.preventDefault(); event.currentTarget.focus({ preventScroll: true })
            event.currentTarget.setPointerCapture(event.pointerId)
            drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
          },
          onPointerMove: (event) => {
            const previous = drag.current
            if (!previous || previous.id !== event.pointerId || busy) return
            move(event.clientX - previous.x, event.clientY - previous.y)
            drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
          },
          onPointerUp: () => { drag.current = null },
          onPointerCancel: () => { drag.current = null },
          onLostPointerCapture: () => { drag.current = null },
        }, h('canvas', { ref: canvas, 'aria-hidden': true }),
          h('div', { className: 'dsh-account-identity__cropWindow', 'aria-hidden': true })),
        h('div', { className: 'dsh-account-identity__cropControls' },
          h('label', { className: 'dsh-account-identity__cropZoom' },
            h('span', null, t('cropZoom')),
            h('input', { type: 'range', min: 1, max: 4, step: .01, value: rect.zoom, disabled: busy,
              'aria-label': t('cropZoom'), 'aria-valuetext': Math.round(rect.zoom * 100) + '%',
              onChange: (event) => setZoom(Number(event.target.value)) })),
          h('canvas', { ref: preview, width: 64, height: 64, role: 'img',
            'aria-label': t('cropPreview'), className: 'dsh-account-identity__cropPreview' })),
        error && h('div', { role: 'alert', className: 'dsh-account-identity__error' }, error),
        h('div', { className: 'dsh-account-identity__dialogActions' },
          h('button', { type: 'button', className: 'dsh-account-identity__button', disabled: busy,
            onClick: () => setSelection(initial()) }, t('cropReset')),
          h('button', { type: 'button', className: 'dsh-account-identity__button', disabled: busy,
            onClick: onCancel }, t('cancel')),
          h('button', { type: 'button', className: 'dsh-account-identity__button dsh-account-identity__buttonPrimary', disabled: busy,
            onClick: () => onConfirm(selection) }, busy ? t('cropSaving') : t('cropConfirm'))))
    }

    /** Independent surfaces only withdraw their own content. No resource lives in a module factory. */
    function createOverlayStore() {
      let value = null
      const cell = createCell(() => value)
      return {
        observable: cell.observable,
        show(owner, content) {
          if (content === null && value?.owner !== owner) return
          value = content === null ? null : { owner, content }; cell.publish()
        },
        clear(owner) { if (value?.owner === owner) { value = null; cell.publish() } },
      }
    }

    /**
     * Register the launcher, the notices, and the settings row.
     * @param ctx - the Client plugin context.
     */
    function apply(ctx) {
      ctx.effect(
        () => ctx.locale.register('account-identity', { zh: ZH, en: EN }),
        'account-identity: dictionaries',
      )
      const t = ctx.locale.bind('account-identity')

      const form = ctx.configForms.get(ENTRY_ID)

      const overlays = createOverlayStore()
      const cropOverlays = createOverlayStore()
      for (const [id, surface] of [['account-identity-menu', overlays], ['account-identity-crop', cropOverlays]]) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id, locale: 'account-identity',
          inject: () => ({ hooks: { overlay: surface.observable } }),
        }, AccountOverlay))
      }

      // ---- configured identity -------------------------------------------
      const settingsCell = createCell(() => readSettings(form))
      ctx.effect(
        () => form.subscribe(settingsCell.publish),
        'account-identity: settings subscription',
      )

      // ---- account state --------------------------------------------------
      //
      // `settings.launcher` exposes no account hook, so the launcher reads the
      // account itself. The stream supplies sign-in state; the profile read
      // supplies the account name used when only the picture is overridden.
      //
      // `known: false` means the first frame has not arrived yet. The launcher
      // stays withdrawn until the state is known, so a signed-out session never
      // shows a shadowed row it would have to retract a moment later.
      let accountState = { known: false, signedIn: false, name: null, contact: null, avatarUrl: null }
      let profileRevision = 0
      const accountCell = createCell(() => accountState)
      const readProfile = async () => {
        const revision = ++profileRevision
        try {
          const result = await ctx.remote.account.getProfile(clientMetadata(ctx))
          if (revision !== profileRevision || !accountState.signedIn) return
          if (!result.ok) return
          const profile = result.value
          if (!profile || profile.status !== 'ready') return
          accountState = {
            ...accountState,
            name: profile.value.name,
            contact: profile.value.contact,
            avatarUrl: profile.value.avatarUrl || null,
          }
          accountCell.publish()
        } catch (cause) {
          // A failed profile read keeps the last known name; the account stream
          // republishes on the next frame and retries.
        }
      }
      ctx.effect(() => {
        const stream = ctx.remote.$stream({
          name: 'account-identity account',
          open: (signal) => ctx.remote.account.watch(signal),
          ended: () => new Error('account-identity: account stream ended'),
        })
        let stopped = false
        ;(async () => {
          try {
            for await (const frame of stream) {
              if (stopped) break
              const view = frame.value
              const signedIn = Boolean(view) && view.status === 'credential-stored'
              profileRevision += 1
              accountState = {
                known: true,
                signedIn,
                name: signedIn ? accountState.name : null,
                contact: signedIn ? accountState.contact : null,
                avatarUrl: signedIn ? accountState.avatarUrl : null,
              }
              accountCell.publish()
              if (typeof frame.accept === 'function') frame.accept()
              if (signedIn) void readProfile()
            }
          } catch (cause) {
            // A dropped stream leaves the last known state; reconnection replays
            // a complete frame because `watch` always opens with one.
          }
        })()
        return () => {
          stopped = true
          profileRevision += 1
          stream.dispose()
        }
      }, 'account-identity: account stream')

      // ---- notices the shipped launcher used to own -----------------------
      //
      // Both events fire at most once per occurrence and are never replayed, so
      // they are subscribed here at plugin level: the shadowed launcher is by
      // design unmounted while signed out, and a component that happens to be
      // unmounted when they fire would miss them entirely.
      const noticeState = { expired: 0, model: 0 }
      const noticeCell = createCell(() => ({ expired: noticeState.expired, model: noticeState.model }))
      ctx.effect(
        () => ctx.remote.$on('deepseek-account/session-expired', () => {
          noticeState.expired += 1
          noticeCell.publish()
        }),
        'account-identity: session expiry notice',
      )
      ctx.effect(
        () => ctx.remote.$on('deepseek-account/model-sign-in-required', () => {
          noticeState.model += 1
          noticeCell.publish()
        }),
        'account-identity: model sign-in notice',
      )

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'account-identity.notices',
        locale: 'account-identity',
        inject: () => ({
          hooks: { notices: noticeCell.observable },
          dismiss: (kind) => {
            if (kind === 'expired') noticeState.expired = 0
            else noticeState.model = 0
            noticeCell.publish()
          },
        }),
      }, AccountNotices))

      // ---- theme interoperability -----------------------------------------
      // The theme adapter retains semantic menu markers, not host hash classes.
      // The local menu owns positioning, focus and dismissal in shell.overlay.
      const THEME_ENTRY_IDS = ['ui-skin-claude-style', 'dsh-claude-style']
      const themeForms = THEME_ENTRY_IDS.map((id) => ({ id, form: ctx.configForms.get(id) }))
      const liveTheme = () => themeForms.find(({ form: candidate }) => {
        const snapshot = candidate.getSnapshot()
        return snapshot?.status === 'ready' && snapshot.value !== undefined
      })
      const themeCell = createCell(() => liveTheme() !== undefined)
      ctx.effect(() => {
        const stops = themeForms.map(({ form: candidate }) => candidate.subscribe(themeCell.publish))
        return () => { for (const stop of stops) stop() }
      }, 'account-identity: theme presence')

      // The theme also writes the label itself. Borrow its username preference
      // while a custom name is enabled, recording the original before writing.
      // The receipt survives reloads; pause/reset restores only a value we own.
      // Avatar-only use never changes the theme's name.
      const readNameReceipt = () => {
        try {
          const receipt = JSON.parse(form.getSnapshot()?.value?.themeNameState || 'null')
          return receipt?.version === 1 && typeof receipt.entryId === 'string'
            && typeof receipt.original === 'string' && typeof receipt.applied === 'string'
            ? receipt : null
        } catch { return null }
      }
      ctx.effect(() => {
        let stopped = false
        let dirty = false
        let running = null
        const restore = async (receipt) => {
          const savedReceipt = form.getSnapshot()?.value?.themeNameState
          const target = themeForms.find(({ id }) => id === receipt.entryId)
          const snapshot = target?.form.getSnapshot()
          if (snapshot?.status !== 'ready') return false
          const current = snapshot.value?.username || ''
          if (current === receipt.applied || current === receipt.previous) {
            if (!(await target.form.set('username', receipt.original))) return false
          }
          // Do not erase a newer receipt saved while the remote write settled.
          if (form.getSnapshot()?.value?.themeNameState !== savedReceipt) return false
          // An independent edit is left alone rather than overwritten.
          return await form.unset('themeNameState')
        }
        const reconcile = async () => {
          const settings = readSettings(form)
          const desired = settings.enabled ? settings.displayName.trim() : ''
          let receipt = readNameReceipt()
          if (desired === '') return receipt === null || await restore(receipt)
          const target = liveTheme()
          if (target === undefined) return false
          if (receipt !== null && receipt.entryId !== target.id) {
            if (!(await restore(receipt))) return false
            receipt = null
          }
          const current = target.form.getSnapshot().value.username || ''
          const owned = receipt !== null
            && [receipt.applied, receipt.previous, receipt.original].includes(current)
          const original = receipt === null || !owned ? current : receipt.original
          if (receipt === null || receipt.applied !== desired || receipt.original !== original) {
            const next = { version: 1, entryId: target.id, original,
              applied: desired, previous: receipt?.applied ?? current }
            if (!(await form.set('themeNameState', JSON.stringify(next)))) return false
            receipt = next
          }
          // Saving the receipt is asynchronous: a user may have changed either
          // preference in the meantime. Reconcile again using that new value.
          const latestSettings = readSettings(form)
          const latestDesired = latestSettings.enabled ? latestSettings.displayName.trim() : ''
          if (stopped || liveTheme()?.id !== target.id || latestDesired !== desired
            || (target.form.getSnapshot()?.value?.username || '') !== current) {
            dirty = !stopped
            return true
          }
          if (current === desired) return true
          // A refused write remains retryable on a subsequent source update.
          return await target.form.set('username', desired)
        }
        const schedule = () => {
          if (stopped) return
          dirty = true
          if (running !== null) return
          running = Promise.resolve().then(async () => {
            try {
              while (dirty && !stopped) {
                dirty = false
                if (!(await reconcile())) { dirty = false; break }
              }
            } catch { dirty = false }
            finally { running = null }
          })
        }
        const stops = [form.subscribe(schedule), ...themeForms.map(({ form: candidate }) => candidate.subscribe(schedule))]
        schedule()
        return async () => {
          stopped = true
          for (const stop of stops) stop()
          await running
          const receipt = readNameReceipt()
          if (receipt !== null) {
            try { await restore(receipt) } catch { /* receipt remains for the next load */ }
          }
        }
      }, 'account-identity: reversible theme name')

      //
      // Occupied only while an override exists. Otherwise the registration is
      // withdrawn and the shipped launcher returns with its sign-in flow,
      // onboarding, and bonus stack — none of which is reimplemented here.
      ctx.slots.inject('settings.launcher', () => {
        let unregister
        const update = () => {
          const wanted = hasOverride(readSettings(form)) && accountState.known && accountState.signedIn
          if (wanted && unregister === undefined) {
            unregister = ctx.slots.register({
              name: 'settings.launcher',
              priority: SHADOW_PRIORITY,
              locale: 'account-identity',
              inject: () => ({
                hooks: {
                  identity: settingsCell.observable,
                  account: accountCell.observable,
                  themePresence: themeCell.observable,
                },
                overlays,
                account: {
                  signOut: () => ctx.remote.account.signOut(clientMetadata(ctx)),
                  runningTasks: () => ctx.remote.account.hasRunningAccountTasks(),
                },
              }),
            }, AccountLauncher)
          } else if (!wanted && unregister !== undefined) {
            unregister()
            unregister = undefined
          }
        }
        const stopSettings = form.subscribe(update)
        const stopAccount = accountCell.observable.subscribe(update)
        update()
        return () => {
          stopSettings()
          stopAccount()
          if (unregister !== undefined) unregister()
        }
      })

      // ---- the settings page -----------------------------------------------
      //
      // A page of its own rather than a row in General: this plugin replaces the
      // account row, so it needs room for the enable switch, the name, and the
      // picture, and it should be reachable by name instead of being buried among
      // shipped preferences.
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'account-identity',
        order: 45,
        label: () => t('pageTitle'),
        locale: 'account-identity',
        inject: () => ({
          hooks: { identity: settingsCell.observable },
          // `set`/`unset` resolve to whether the Host accepted the write; a
          // refusal is a normal outcome rather than a thrown error, so it is
          // turned into a rejection here for every caller to report.
          save: async (field, value) => {
            if (!(await form.set(field, value))) throw new Error('account-identity: write refused')
          },
          reset: async () => {
            if (!(await form.unset('displayName'))) throw new Error('account-identity: write refused')
            if (!(await form.unset('avatarDataUrl'))) throw new Error('account-identity: write refused')
          },
          loadAvatar, encodeAvatar, cropOverlays,
          maxBytes: MAX_SOURCE_BYTES,
        }),
      }, IdentityPage))
    }

    // ---- components --------------------------------------------------------

    /**
     * Stylesheet element. A packaged bundle cannot load a stylesheet module, so
     * the CSS ships as an element rendered by each surface that needs it.
     * @returns the style element.
     */
    function StyleSheet() {
      return h('style', { 'data-plugin': 'dsh-account-identity' }, CSS)
    }

    /**
     * Notices rendered in the frame-wide overlay.
     * @param props - the pending notices and a dismiss callback.
     * @returns one row per pending notice, or null.
     */
    function AccountNotices({ useNotices, dismiss, t }) {
      const pending = useNotices((value) => value)
      const rows = []
      if (pending.expired > 0) {
        rows.push(h(NoticeRow, {
          key: 'expired-' + pending.expired,
          text: t('sessionExpired'),
          onDone: () => dismiss('expired'),
        }))
      }
      if (pending.model > 0) {
        rows.push(h(NoticeRow, {
          key: 'model-' + pending.model,
          text: t('modelSignInRequired'),
          onDone: () => dismiss('model'),
        }))
      }
      if (rows.length === 0) return null
      return h('div', { className: 'dsh-account-identity__notices' }, h(StyleSheet), rows)
    }

    /**
     * One auto-dismissing notice.
     * @param props - copy and the completion callback.
     * @returns the notice element.
     */
    function NoticeRow({ text, onDone }) {
      useEffect(() => {
        const timer = setTimeout(onDone, 6000)
        return () => clearTimeout(timer)
      }, [onDone])
      return h('div', { className: 'dsh-account-identity__notice', role: 'status' }, text)
    }

    /**
     * The sidebar account row.
     *
     * Own class names and semantic account/menu markers keep the theme adapter
     * independent of host CSS hashes. The popup itself renders in shell.overlay.
     * @param props - sidebar geometry, settings navigation, identity, and the account face.
     * @returns the account button, its menu, and any sign-out confirmation.
     */
    function AccountLauncher({ wide, settingsOpen, settingsShortcut, openSettings, useIdentity, useAccount, useThemePresence, overlays, account, t }) {
      const identity = useIdentity((value) => value)
      const state = useAccount((value) => value)
      const themeActive = useThemePresence((value) => value)
      const openState = useState(false)
      const isOpen = openState[0]
      const setOpen = openState[1]
      const impactState = useState(undefined)
      const signOutImpact = impactState[0]
      const setSignOutImpact = impactState[1]
      const busyState = useState(false)
      const busy = busyState[0]
      const setBusy = busyState[1]
      const failState = useState(false)
      const signOutFailed = failState[0]
      const setSignOutFailed = failState[1]
      const trigger = useRef(null)
      const owner = useRef({})
      const initialFocus = useRef('first')
      useEffect(() => () => overlays.clear(owner.current), [overlays])
      const actionGeneration = useRef(0)
      useEffect(() => () => { actionGeneration.current += 1 }, [])
      useEffect(() => {
        if (settingsOpen) {
          actionGeneration.current += 1
          setOpen(false); setSignOutImpact(undefined); setSignOutFailed(false); setBusy(false)
        }
      }, [settingsOpen])

      const configuredName = identity.displayName.trim()
      const picture = identity.avatarDataUrl || state.avatarUrl || undefined
      const accountName = state.name || state.contact || t('signedIn')
      const label = configuredName !== '' ? configuredName : accountName

      const requestSignOut = async () => {
        const generation = ++actionGeneration.current
        setOpen(false)
        setBusy(true)
        setSignOutFailed(false)
        try {
          const result = await account.runningTasks()
          if (generation === actionGeneration.current) setSignOutImpact(result.ok ? result.value : 'unknown')
        } catch (cause) {
          if (generation === actionGeneration.current) setSignOutImpact('unknown')
        } finally {
          if (generation === actionGeneration.current) { setBusy(false); setOpen(false) }
        }
      }

      const confirmSignOut = async () => {
        setBusy(true)
        try {
          const result = await account.signOut()
          if (!result.ok) throw result.error
          setSignOutImpact(undefined)
        } catch (cause) {
          setSignOutFailed(true)
        } finally {
          setBusy(false)
        }
      }

      const closeMenu = (restore) => {
        setOpen(false)
        if (restore && trigger.current?.isConnected) trigger.current.focus({ preventScroll: true })
      }
      const select = (id) => {
        if (id === 'settings') {
          closeMenu(true)
          openSettings()
        } else if (id === 'signout') void requestSignOut()
      }
      useEffect(() => {
        const content = signOutImpact !== undefined
          ? h(SignOutDialog, { t, running: signOutImpact, busy, failed: signOutFailed, anchor: trigger,
            onCancel: () => { setSignOutImpact(undefined); setSignOutFailed(false) }, onConfirm: confirmSignOut })
          : isOpen ? h(LauncherMenu, { anchor: trigger, initialFocus: initialFocus.current,
            settingsShortcut, busy, onClose: closeMenu, onSelect: select, t }) : null
        overlays.show(owner.current, content)
      }, [isOpen, signOutImpact, busy, signOutFailed, settingsShortcut, openSettings, t, wide, label, overlays])

      return h('div', { className: 'dsh-account-identity__launcher', 'data-dsh-account-identity-launcher': '' },
        h(StyleSheet),
        h('button', {
          ref: trigger, type: 'button', className: 'dsh-account-identity__trigger',
          'data-collapsed': !wide,
          ...(themeActive ? { 'data-dsh-claude-account-host-row': '' } : {}),
          'data-signed-out': !state.signedIn, 'aria-haspopup': 'menu',
          'aria-expanded': isOpen, 'aria-label': t('menu'),
          onClick: () => { initialFocus.current = 'first'; setOpen((value) => !value) },
          onKeyDown: (event) => {
            if (isComposing(event) || !['ArrowDown', 'ArrowUp'].includes(event.key)) return
            event.preventDefault(); initialFocus.current = event.key === 'ArrowUp' ? 'last' : 'first'; setOpen(true)
          },
        },
          h('span', { className: 'dsh-account-identity__avatar',
            'data-avatar-status': picture === undefined ? 'absent' : 'ready' }, h(AccountPicture, { src: picture })),
          wide && h('span', { className: 'dsh-account-identity__label' }, label),
        ),
      )
    }


    /** Plugin-owned popup. Its DOM is mounted only by the public shell.overlay slot. */
    function AccountOverlay({ useOverlay }) {
      const value = useOverlay((snapshot) => snapshot)
      if (value === null) return null
      return h(React.Fragment, null, h(StyleSheet), value.content)
    }

    function isComposing(event) {
      return event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229
    }

    /** Match the host's composition lifetime, including the trailing closing key. */
    function observeComposition(target) {
      let active = false, trailing = false
      const start = () => { active = true; trailing = false }
      const end = () => { active = false; trailing = true }
      const release = () => { trailing = false }
      const blur = () => { active = false; trailing = false }
      target.addEventListener('compositionstart', start, true)
      target.addEventListener('compositionend', end, true)
      target.addEventListener('keyup', release, true)
      target.defaultView?.addEventListener('blur', blur)
      return {
        guards(event) { const result = active || trailing || isComposing(event); trailing = false; return result },
        dispose() {
          target.removeEventListener('compositionstart', start, true)
          target.removeEventListener('compositionend', end, true)
          target.removeEventListener('keyup', release, true)
          target.defaultView?.removeEventListener('blur', blur)
        },
      }
    }

    /** All focusable controls, including controls inserted by the theme's footer adapter. */
    function focusableIn(root) {
      return [...root.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')]
        .filter((node) => !node.disabled && node.getAttribute('aria-disabled') !== 'true'
          && node.tabIndex >= 0 && !node.closest('[hidden], [inert], [aria-hidden="true"]')
          && node.getClientRects().length > 0)
    }

    /** Placement depends solely on our own anchor and popup, never on another plugin's DOM. */
    function menuPosition(anchor, popup, width, height) {
      const margin = 12, gap = 4
      const availableAbove = Math.max(0, anchor.top - margin - gap)
      const availableBelow = Math.max(0, height - anchor.bottom - margin - gap)
      const above = popup.height <= availableAbove || availableAbove >= availableBelow
      const maxHeight = above ? availableAbove : availableBelow
      const actualHeight = Math.min(popup.height, maxHeight)
      const maxWidth = Math.max(0, width - margin * 2)
      const minWidth = Math.min(Math.max(220, anchor.width), maxWidth)
      const actualWidth = Math.min(Math.max(popup.width, minWidth), maxWidth)
      return {
        left: Math.max(margin, Math.min(anchor.left, width - margin - actualWidth)),
        top: Math.max(margin, above ? anchor.top - gap - actualHeight : anchor.bottom + gap),
        minWidth, maxWidth, maxHeight,
      }
    }

    /** Convert viewport rectangles into our overlay's local CSS units (including inherited zoom). */
    function positionInSurface(anchor, popup, surface, width, height, viewportWidth, viewportHeight) {
      const scaleX = surface.width / width || 1, scaleY = surface.height / height || 1
      return menuPosition({
        left: (anchor.left - surface.left) / scaleX,
        top: (anchor.top - surface.top) / scaleY,
        bottom: (anchor.bottom - surface.top) / scaleY,
        width: anchor.width / scaleX,
      }, { width: popup.width / scaleX, height: popup.height / scaleY },
      Math.min(width, (viewportWidth - surface.left) / scaleX),
      Math.min(height, (viewportHeight - surface.top) / scaleY))
    }

    /** A deliberately small local account menu, with no host-private modal stack or imports. */
    function LauncherMenu({ anchor, initialFocus, settingsShortcut, busy, onClose, onSelect, t }) {
      const panel = useRef(null)
      const surface = useRef(null)
      const [position, setPosition] = useState(null)
      const focused = useRef(false)
      const latest = useRef({ onClose })
      latest.current = { onClose }

      useLayoutEffect(() => {
        if (position === null || focused.current || !panel.current) return
        const items = [...panel.current.querySelectorAll('[data-account-identity-item]')].filter((node) => !node.disabled)
        ;((initialFocus === 'last' ? items.at(-1) : items[0]) || panel.current).focus({ preventScroll: true })
        focused.current = true
      }, [position, initialFocus])

      useLayoutEffect(() => {
        const root = panel.current, button = anchor.current, frameRoot = surface.current
        if (!root || !button || !frameRoot) { latest.current.onClose(false); return }
        let stopped = false, frame
        const sync = () => {
          if (stopped) return
          if (!button.isConnected || button.getClientRects().length === 0) {
            latest.current.onClose(false); return
          }
          const rect = button.getBoundingClientRect()
          const next = positionInSurface(rect, root.getBoundingClientRect(), frameRoot.getBoundingClientRect(),
            frameRoot.clientWidth, frameRoot.clientHeight, window.innerWidth, window.innerHeight)
          setPosition((previous) => previous && Object.keys(next).every((key) => Math.abs(previous[key] - next[key]) < .5)
            ? previous : next)
        }
        sync()
        // Track our anchor during sidebar transitions, not just resize events.
        const follow = () => { sync(); if (!stopped) frame = requestAnimationFrame(follow) }
        frame = requestAnimationFrame(follow)
        const observer = new ResizeObserver(sync)
        observer.observe(root); observer.observe(button); observer.observe(frameRoot)
        window.addEventListener('resize', sync)
        window.addEventListener('scroll', sync, true)
        window.visualViewport?.addEventListener('resize', sync)
        return () => {
          stopped = true; cancelAnimationFrame(frame); observer.disconnect()
          window.removeEventListener('resize', sync)
          window.removeEventListener('scroll', sync, true)
          window.visualViewport?.removeEventListener('resize', sync)
        }
      }, [anchor])

      useEffect(() => {
        const root = panel.current, button = anchor.current
        if (!root || !button) return
        const inside = (target) => target instanceof Node && (root.contains(target) || button.contains(target))
        const close = (restore) => {
          const active = document.activeElement
          latest.current.onClose(restore && (inside(active) || active === document.body))
        }
        const composition = observeComposition(document)

        const pointer = (event) => { if (!inside(event.target)) close(false) }
        const focus = (event) => { if (!inside(event.target)) close(false) }
        const blur = () => close(false)
        let search = '', searchAt = 0
        const keydown = (event) => {
          if (composition.guards(event) || event.defaultPrevented) return
          // A host dialog that takes focus wins; no copied private modal stack.
          if (!inside(document.activeElement) && document.activeElement !== document.body) return
          const active = document.activeElement
          if (event.key === 'Escape') {
            event.preventDefault(); event.stopPropagation(); close(true); return
          }
          const controls = focusableIn(root)
          if (event.key === 'Tab') {
            const index = controls.indexOf(active), next = index + (event.shiftKey ? -1 : 1)
            event.preventDefault(); event.stopPropagation()
            if (next >= 0 && next < controls.length) controls[next].focus()
            else { button.focus({ preventScroll: true }); close(false) }
            return
          }
          // Embedded cards keep their text fields, sliders and arrow-key controls.
          if (active?.matches('input, textarea, select, [contenteditable="true"], [role="slider"]')) return
          let next
          const index = controls.indexOf(active)
          if (event.key === 'ArrowDown') next = controls[(index + 1 + controls.length) % controls.length]
          else if (event.key === 'ArrowUp') next = controls[(index - 1 + controls.length) % controls.length]
          else if (event.key === 'Home') next = controls[0]
          else if (event.key === 'End') next = controls.at(-1)
          else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== ' ') {
            const now = Date.now()
            search = now - searchAt > 700 ? event.key : search + event.key
            searchAt = now
            next = controls.find((node) => node.textContent.trim().toLocaleLowerCase().startsWith(search.toLocaleLowerCase()))
          }
          if (next) { event.preventDefault(); event.stopPropagation(); next.focus() }
        }
        document.addEventListener('pointerdown', pointer, true)
        document.addEventListener('focusin', focus, true)
        document.addEventListener('keydown', keydown)
        window.addEventListener('blur', blur)
        return () => {
          document.removeEventListener('pointerdown', pointer, true)
          document.removeEventListener('focusin', focus, true)
          document.removeEventListener('keydown', keydown)
          window.removeEventListener('blur', blur)
          composition.dispose()
        }
      }, [anchor, initialFocus])

      return h('div', { ref: surface, className: 'dsh-account-identity__overlaySurface' }, h('div', {
        ref: panel, role: 'menu', tabIndex: -1, 'aria-label': t('menu'),
        className: 'dsh-account-identity__menu',
        style: position === null ? { visibility: 'hidden', left: 0, top: 0 } : position,
        onClick: (event) => event.stopPropagation(),
      }, h('div', { role: 'presentation', className: 'dsh-account-identity__menuViewport' },
        h('button', {
          type: 'button', role: 'menuitem', 'data-account-identity-item': 'settings',
          className: 'dsh-account-identity__menuItem', 'aria-keyshortcuts': settingsShortcut?.aria,
          onClick: () => onSelect('settings'),
        }, h('span', null, t('settings')),
          settingsShortcut && h('span', { className: 'dsh-account-identity__shortcut', 'aria-hidden': true },
            (settingsShortcut.keys || []).map((key, index) => h('kbd', { key: index }, key)))),
        h('button', {
          type: 'button', role: 'menuitem', 'data-account-identity-item': 'signout',
          className: 'dsh-account-identity__menuItem', disabled: busy,
          onClick: () => onSelect('signout'),
        }, t('signOut')),
      )))
    }

    /** Use the account picture when only the name changes; failed images use the glyph. */
    function AccountPicture({ src }) {
      const [failed, setFailed] = useState(undefined)
      if (src === undefined || failed === src) return h(AccountGlyph)
      return h('img', { className: 'dsh-account-identity__picture', src, alt: '',
        referrerPolicy: 'no-referrer', onError: () => setFailed(src) })
    }

    /**
     * Sign-out confirmation carrying the running-task warning the shipped menu shows.
     * @param props - copy, the impact verdict, and the dialog callbacks.
     * @returns the dialog element.
     */
    function SignOutDialog({ t, running, busy, failed, onCancel, onConfirm, anchor }) {
      const dialog = useRef(null)
      const current = useRef({ onCancel, busy })
      current.current = { onCancel, busy }
      useEffect(() => {
        const root = dialog.current
        const composition = observeComposition(document)
        const controls = () => focusableIn(root)
        controls()[0]?.focus({ preventScroll: true })
        const owns = (node) => node instanceof Node && root.contains(node)
        const yieldFocus = (event) => {
          if (!owns(event.target)) current.current.onCancel()
        }
        const keydown = (event) => {
          if (composition.guards(event) || event.defaultPrevented || !owns(document.activeElement)) return
          if (event.key === 'Escape') {
            event.preventDefault(); event.stopPropagation()
            if (!current.current.busy) current.current.onCancel()
          } else if (event.key === 'Tab') {
            const items = controls(), index = items.indexOf(document.activeElement)
            event.preventDefault(); event.stopPropagation()
            ;(items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length] || root).focus()
          }
        }
        document.addEventListener('keydown', keydown)
        document.addEventListener('focusin', yieldFocus, true)
        return () => {
          document.removeEventListener('keydown', keydown)
          document.removeEventListener('focusin', yieldFocus, true)
          composition.dispose()
          if (anchor.current?.isConnected && (root.contains(document.activeElement) || document.activeElement === document.body))
            anchor.current.focus({ preventScroll: true })
        }
      }, [anchor])
      const description = running === 'unknown'
        ? t('signOutUnknown')
        : running === true
          ? t('signOutRunning')
          : t('signOutDescription')
      return h('div', { className: 'dsh-account-identity__scrim' },
        h('div', {
          ref: dialog, tabIndex: -1, className: 'dsh-account-identity__dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('signOutTitle'),
        },
          h('div', { className: 'dsh-account-identity__dialogTitle' }, t('signOutTitle')),
          h('div', { className: 'dsh-account-identity__dialogBody' }, description),
          failed && h('div', { className: 'dsh-account-identity__error' }, t('signOutFailed')),
          h('div', { className: 'dsh-account-identity__dialogActions' },
            h('button', {
              type: 'button',
              className: 'dsh-account-identity__button',
              onClick: onCancel,
              disabled: busy,
            }, t('cancel')),
            h('button', {
              type: 'button',
              className: 'dsh-account-identity__button dsh-account-identity__buttonPrimary',
              onClick: onConfirm,
              disabled: busy,
            }, t('signOut')),
          ),
        ),
      )
    }

    /**
     * Fallback account glyph, matching the shipped icon seat.
     * @returns the glyph.
     */
    function AccountGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 16,
        height: 16,
        'aria-hidden': true,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        style: { flex: 'none' },
      },
        h('circle', { cx: 8, cy: 5.2, r: 2.6 }),
        h('path', { d: 'M3 13.2c0-2.7 2.2-4.6 5-4.6s5 1.9 5 4.6' }),
      )
    }

    /**
     * The account identity page: enable switch, display name, and picture.
     * @param props - identity, the write callbacks, and the encoder.
     * @returns the settings page.
     */
    function IdentityPage({ useIdentity, save, reset, loadAvatar, encodeAvatar, cropOverlays, maxBytes, t }) {
      const identity = useIdentity((value) => value)
      const nameState = useState(identity.displayName)
      const name = nameState[0]
      const setName = nameState[1]
      const busyState = useState(false)
      const busy = busyState[0]
      const setBusy = busyState[1]
      const errorState = useState(undefined)
      const error = errorState[0]
      const setError = errorState[1]
      const fileInput = useRef(null), chooseButton = useRef(null)
      const cropOwner = useRef({}), sourceRef = useRef(null), generation = useRef(0)
      const savingCrop = useRef(false), mounted = useRef(true), focusAfterCrop = useRef(false)
      const [cropSource, setCropSource] = useState(null)
      const [cropError, setCropError] = useState(undefined)
      const closeCrop = () => {
        focusAfterCrop.current = true
        generation.current += 1
        sourceRef.current?.bitmap.close(); sourceRef.current = null
        setCropSource(null); setCropError(undefined)
        cropOverlays.clear(cropOwner.current)
      }
      const cancelCrop = () => { if (!savingCrop.current) closeCrop() }
      useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
          generation.current += 1; sourceRef.current?.bitmap.close(); sourceRef.current = null
          cropOverlays.clear(cropOwner.current)
        }
      }, [cropOverlays])

      useEffect(() => {
        setName(identity.displayName)
      }, [identity.displayName])

      const commitName = async () => {
        const next = name.trim()
        if (next === identity.displayName) return
        setBusy(true)
        setError(undefined)
        try {
          await save('displayName', next)
        } catch (cause) {
          setError(t('saveFailed'))
        } finally {
          setBusy(false)
        }
      }

      const pickFile = async (event) => {
        const file = event.target.files && event.target.files[0]
        event.target.value = ''
        if (!file) return
        const token = ++generation.current
        if (file.size > maxBytes) { setBusy(false); setError(t('avatarTooLarge')); return }
        setBusy(true); setError(undefined)
        try {
          const source = await loadAvatar(file)
          if (token !== generation.current) { source.bitmap.close(); return }
          sourceRef.current?.bitmap.close(); sourceRef.current = source
          setCropError(undefined); setCropSource(source)
        } catch (cause) {
          if (token === generation.current) setError(t('avatarInvalid'))
        } finally {
          if (token === generation.current) setBusy(false)
        }
      }
      const confirmCrop = async (selection) => {
        if (!sourceRef.current || busy || savingCrop.current) return
        savingCrop.current = true
        const token = generation.current, source = sourceRef.current
        setBusy(true); setCropError(undefined)
        try {
          const dataUrl = encodeAvatar(source, selection)
          await save('avatarDataUrl', dataUrl)
          if (token === generation.current) closeCrop()
        } catch (cause) {
          if (token === generation.current) setCropError(t('saveFailed'))
        } finally {
          // Successful close advances the generation; this page still needs its controls restored.
          savingCrop.current = false
          if (mounted.current && (sourceRef.current === null || token === generation.current)) setBusy(false)
        }
      }
      useEffect(() => {
        if (cropSource === null) { cropOverlays.clear(cropOwner.current); return }
        cropOverlays.show(cropOwner.current, h(AvatarCropDialog, { source: cropSource, busy, error: cropError,
          onCancel: cancelCrop, onConfirm: confirmCrop, returnFocus: chooseButton, t }))
      }, [cropSource, busy, cropError, cropOverlays, t])
      useEffect(() => {
        if (!focusAfterCrop.current || busy || cropSource !== null) return
        // A save can unmount the external overlay before the page's busy flag
        // commits, and the host may restore its selected navigation item. Wait
        // for the completed frame; never take focus from a new input or modal.
        const frame = requestAnimationFrame(() => {
          focusAfterCrop.current = false
          const target = chooseButton.current, active = document.activeElement
          const selectedNavigation = active instanceof HTMLElement && active.getAttribute('aria-current') === 'true'
            && target?.closest('[role="dialog"],dialog')?.contains(active)
          if (target?.isConnected && !target.disabled &&
              (active === document.body || active === target || selectedNavigation))
            target.focus({ preventScroll: true })
        })
        return () => cancelAnimationFrame(frame)
      }, [busy, cropSource])

      const clearPicture = async () => {
        setBusy(true)
        setError(undefined)
        try {
          await save('avatarDataUrl', '')
        } catch (cause) {
          setError(t('saveFailed'))
        } finally {
          setBusy(false)
        }
      }

      const resetAll = async () => {
        setBusy(true)
        setError(undefined)
        try {
          await reset()
          setName('')
        } catch (cause) {
          setError(t('saveFailed'))
        } finally {
          setBusy(false)
        }
      }

      const custom = identity.avatarDataUrl !== ''

      const toggleEnabled = async () => {
        setBusy(true)
        setError(undefined)
        try {
          await save('enabled', !identity.enabled)
        } catch (cause) {
          setError(t('saveFailed'))
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'dsh-account-identity__page' },
        h(StyleSheet),
        h('div', { className: 'dsh-account-identity__header' },
          h('div', { className: 'dsh-account-identity__headerCopy' },
            h('h2', { className: 'dsh-account-identity__title' }, t('pageTitle')),
            h('p', { className: 'dsh-account-identity__subtitle' }, t('pageDescription')),
          ),
          h('button', {
            type: 'button',
            role: 'switch',
            'aria-checked': identity.enabled,
            'aria-label': t('enabledLabel'),
            className: 'dsh-account-identity__switch',
            'data-on': identity.enabled,
            disabled: busy,
            onClick: toggleEnabled,
          },
            h('span', { className: 'dsh-account-identity__switchTrack' },
              h('span', { className: 'dsh-account-identity__switchThumb' }),
            ),
            h('span', { className: 'dsh-account-identity__switchText' },
              identity.enabled ? t('enabledOn') : t('enabledOff')),
          ),
        ),
        h('p', { className: 'dsh-account-identity__hint' }, t('enabledHint')),
        !identity.enabled && h('div', { className: 'dsh-account-identity__paused' }, t('pausedNotice')),
        h('div', {
          className: 'dsh-account-identity__body',
          'data-disabled': !identity.enabled,
        },
          h('div', { className: 'dsh-account-identity__field' },
            h('span', { className: 'dsh-account-identity__fieldLabel' }, t('nameLabel')),
            h('input', {
              type: 'text',
              className: 'dsh-account-identity__input',
              value: name,
              maxLength: NAME_LIMIT,
              placeholder: t('namePlaceholder'),
              disabled: busy,
              onChange: (event) => setName(event.target.value),
              onBlur: commitName,
              onKeyDown: (event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
              },
            }),
          ),
          h('div', { className: 'dsh-account-identity__field' },
            h('span', { className: 'dsh-account-identity__fieldLabel' }, t('avatarLabel')),
            h('div', { className: 'dsh-account-identity__avatars' },
              h('span', { className: 'dsh-account-identity__preview' },
                custom
                  ? h('img', { className: 'dsh-account-identity__picture', src: identity.avatarDataUrl, alt: '' })
                  : h(AccountGlyph),
              ),
              h('button', {
                ref: chooseButton,
                type: 'button',
                className: 'dsh-account-identity__button',
                disabled: busy,
                onClick: () => {
                  if (fileInput.current !== null) fileInput.current.click()
                },
              }, t('avatarChoose')),
              h('input', {
                ref: fileInput,
                type: 'file',
                accept: 'image/*',
                style: { display: 'none' },
                onChange: pickFile,
              }),
              custom && h('button', {
                type: 'button',
                className: 'dsh-account-identity__button dsh-account-identity__buttonQuiet',
                disabled: busy,
                onClick: clearPicture,
              }, t('avatarRemove')),
            ),
          ),
          error !== undefined && h('div', { className: 'dsh-account-identity__error' }, error),
          (identity.displayName !== '' || custom) && h('button', {
            type: 'button',
            className: 'dsh-account-identity__button dsh-account-identity__buttonQuiet',
            disabled: busy,
            onClick: resetAll,
          }, t('reset')),
        ),
      )
    }

    /** Stylesheet using only host theme tokens. */
    const CSS = [
      '.dsh-account-identity__cropDialog{box-sizing:border-box;width:440px;max-width:calc(100% - 32px);max-height:calc(100% - 32px);padding:20px;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;corner-shape:round;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);overflow:auto;overscroll-behavior:contain;font:inherit}',
      '.dsh-account-identity__cropDialog:not([open]){display:none}',
      '.dsh-account-identity__cropDialog::backdrop{background:var(--dsw-alias-bg-mask-1)}',
      '.dsh-account-identity__cropDialog h3{margin:0}',
      '.dsh-account-identity__cropHelp{margin:8px 0 16px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
      '.dsh-account-identity__cropStage{box-sizing:border-box;position:relative;width:100%;max-width:var(--dsh-account-identity-crop-edge,320px);aspect-ratio:1;margin:0 auto;overflow:hidden;touch-action:none;user-select:none;cursor:grab;background:var(--dsw-alias-bg-layer-1);border-radius:12px;corner-shape:round}',
      '.dsh-account-identity__cropStage:active{cursor:grabbing}',
      '.dsh-account-identity__cropStage:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:3px}',
      '.dsh-account-identity__cropStage canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}',
      '.dsh-account-identity__cropWindow{box-sizing:border-box;position:absolute;inset:14%;border:2px solid var(--dsw-alias-label-primary-foreground);border-radius:50%;corner-shape:round;box-shadow:0 0 0 999px var(--dsw-alias-bg-mask-1);pointer-events:none}',
      '.dsh-account-identity__cropControls{display:flex;align-items:center;gap:16px;margin-top:16px}',
      '.dsh-account-identity__cropZoom{display:flex;align-items:center;gap:12px;flex:1;min-width:0;color:var(--dsw-alias-label-secondary);font-size:13px}',
      '.dsh-account-identity__cropZoom input{flex:1;min-width:0;accent-color:var(--dsw-alias-state-business-primary)}',
      '.dsh-account-identity__cropPreview{width:48px;height:48px;flex:none;border-radius:50%;corner-shape:round;object-fit:cover;background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-account-identity__cropDialog .dsh-account-identity__dialogActions{flex-wrap:wrap}',
      '.dsh-account-identity__launcher{position:relative;width:100%;min-width:0}',
      '.dsh-account-identity__trigger{display:flex;align-items:center;gap:8px;width:100%;min-width:0;min-height:36px;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer}',
      '.dsh-account-identity__trigger[data-collapsed=true]{justify-content:center;padding:6px}',
      '.dsh-account-identity__trigger:hover,.dsh-account-identity__trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-account-identity__trigger:focus-visible,.dsh-account-identity__menuItem:focus-visible,.dsh-account-identity__dialog button:focus-visible,.dsh-account-identity__switch:focus-visible,.dsh-account-identity__button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.dsh-account-identity__avatar{position:relative;display:flex;align-items:center;justify-content:center;width:24px;height:24px;flex:none;border-radius:50%;corner-shape:round;background:var(--dsw-alias-bg-layer-3);overflow:hidden}',
      '.dsh-account-identity__label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-account-identity__overlaySurface{position:fixed;inset:0;z-index:60;pointer-events:none}',
      '.dsh-account-identity__menu{position:absolute;pointer-events:auto;box-sizing:border-box;min-width:220px;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;overflow-y:auto;overscroll-behavior:contain}',
      '.dsh-account-identity__menuViewport{display:flex;flex-direction:column;gap:2px}',
      '.dsh-account-identity__menuItem{box-sizing:border-box;display:flex;align-items:center;gap:12px;justify-content:space-between;width:100%;flex:none;min-height:32px;padding:7px 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}',
      '.dsh-account-identity__menuItem:hover:not(:disabled),.dsh-account-identity__menuItem:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-account-identity__menuItem:disabled{opacity:.5;cursor:default}',
      '.dsh-account-identity__shortcut{display:flex;align-items:center;gap:3px;color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.dsh-account-identity__shortcut kbd{font:inherit}',
      '.dsh-account-identity__picture{width:100%;height:100%;border-radius:50%;corner-shape:round;object-fit:cover;display:block}',
      // The theme may append its original account photo directly to our trigger.
      // Scope the suppression to our launcher, leaving the native row untouched.
      '[data-dsh-account-identity-launcher] .dsh-account-identity__trigger > .dsh-claude-account-photo{display:none!important}',
      '[data-dsh-account-identity-launcher] .dsh-account-identity__avatar > .dsh-claude-account-photo{display:none!important}',
      '[data-dsh-account-identity-launcher] .dsh-account-identity__trigger[data-dsh-claude-photo]:before,[data-dsh-account-identity-launcher] .dsh-account-identity__avatar[data-dsh-claude-photo]:before,[data-dsh-account-identity-launcher] .dsh-account-identity__avatar[data-dsh-claude-skin]:before{content:none!important;display:none!important}',
      '.dsh-account-identity__page{display:flex;flex-direction:column;gap:14px;padding:4px 0 16px;max-width:640px}',
      '.dsh-account-identity__header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}',
      '.dsh-account-identity__headerCopy{min-width:0}',
      '.dsh-account-identity__title{margin:0;color:var(--dsw-alias-label-primary);font-size:16px;line-height:24px;font-weight:600}',
      '.dsh-account-identity__subtitle{margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}',
      '.dsh-account-identity__hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dsh-account-identity__paused{box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
      '.dsh-account-identity__body{display:flex;flex-direction:column;gap:14px;max-width:360px}',
      '.dsh-account-identity__body[data-disabled=true]{opacity:.55}',
      '.dsh-account-identity__switch{display:inline-flex;align-items:center;gap:8px;flex:none;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}',
      '.dsh-account-identity__switch:disabled{opacity:.5;cursor:default}',
      '.dsh-account-identity__switchTrack{position:relative;display:block;box-sizing:border-box;width:36px;height:20px;flex:none;border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-layer-3);transition:background-color .15s ease}',
      '.dsh-account-identity__switch[data-on=true] .dsh-account-identity__switchTrack{background:var(--dsw-alias-state-business-primary)}',
      '.dsh-account-identity__switchThumb{box-sizing:border-box;position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground);border:1px solid var(--dsw-alias-border-l2);transition:transform .15s ease}',
      '.dsh-account-identity__switch[data-on=true] .dsh-account-identity__switchThumb{transform:translateX(16px)}',
      '.dsh-account-identity__switchText{white-space:nowrap}',
      '.dsh-account-identity__field{display:flex;flex-direction:column;gap:6px}',
      '.dsh-account-identity__fieldLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px}',
      '.dsh-account-identity__input{box-sizing:border-box;width:100%;height:32px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.dsh-account-identity__input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.dsh-account-identity__avatars{display:flex;align-items:center;gap:8px}',
      '.dsh-account-identity__preview{width:32px;height:32px;flex:none;border-radius:50%;corner-shape:round;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;justify-content:center;overflow:hidden}',
      '.dsh-account-identity__button{box-sizing:border-box;height:28px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}',
      '.dsh-account-identity__button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-account-identity__button:disabled{opacity:.5;cursor:default}',
      '.dsh-account-identity__buttonPrimary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}',
      '.dsh-account-identity__buttonQuiet{border-color:transparent;background:transparent;color:var(--dsw-alias-label-tertiary)}',
      '.dsh-account-identity__error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:16px}',
      '.dsh-account-identity__notices{position:fixed;bottom:72px;left:16px;z-index:60;display:flex;flex-direction:column;gap:8px;max-width:320px}',
      '.dsh-account-identity__notice{box-sizing:border-box;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px}',
      '.dsh-account-identity__scrim{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1)}',
      '.dsh-account-identity__dialog{box-sizing:border-box;width:360px;max-width:calc(100vw - 32px);padding:20px;border-radius:16px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2)}',
      '.dsh-account-identity__dialogTitle{color:var(--dsw-alias-label-primary);font-size:15px;line-height:22px;font-weight:500}',
      '.dsh-account-identity__dialogBody{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;margin-top:8px}',
      '.dsh-account-identity__dialogActions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}',
    ].join('\n')

    /** Chinese copy for the launcher, the notices, and the settings row. */
    const ZH = {
      cropTitle: '调整头像',
      cropHelp: '拖动图片或使用方向键调整位置，使用滑块缩放。圆框内即为头像显示区域。',
      cropPosition: '头像选区；使用方向键移动图片，按住 Shift 加快移动',
      cropZoom: '缩放',
      cropPreview: '头像预览',
      cropReset: '重置选区',
      cropConfirm: '使用此头像',
      cropSaving: '保存中…',
      menu: '账号菜单',
      settings: '设置',
      signOut: '退出登录',
      signedIn: '已登录 DeepSeek',
      cancel: '取消',
      signOutTitle: '退出登录',
      signOutDescription: '退出登录不会删除任何数据，之后可以重新登录该账号。',
      signOutRunning: '当前有任务正在运行，退出登录会中断它们。确定退出吗？',
      signOutUnknown: '无法检查运行中的任务，退出登录可能中断使用该账号的任务。现在退出吗？',
      signOutFailed: '退出登录失败，请重试。',
      sessionExpired: '登录信息已失效，请重新登录',
      modelSignInRequired: '当前模型暂不可用，请登录后再试',
      rowTitle: '账号身份',
      rowDescription: '自定义侧边栏账号菜单中显示的昵称与头像。',
      pageTitle: '账号身份',
      pageDescription: '用自定义昵称与头像替换侧边栏账号菜单中的 DeepSeek 账号信息。',
      enabledLabel: '启用自定义账号身份',
      enabledOn: '已启用',
      enabledOff: '已暂停',
      enabledHint: '暂停后立即恢复显示 DeepSeek 账号原本的昵称与头像，已保存的内容不会删除。',
      pausedNotice: '当前已暂停，侧边栏显示的是 DeepSeek 账号原本的昵称与头像。',
      nameLabel: '显示名称',
      namePlaceholder: '留空则使用账号名',
      avatarLabel: '头像',
      avatarChoose: '选择图片',
      avatarRemove: '移除',
      avatarInvalid: '该文件无法作为图片读取。',
      avatarTooLarge: '图片过大（上限 8 MB）。',
      saveFailed: '保存失败，请重试。',
      reset: '恢复账号名称与头像',
    }

    /** English copy for the launcher, the notices, and the settings row. */
    const EN = {
      cropTitle: 'Adjust avatar',
      cropHelp: 'Drag the image or use arrow keys to reposition. Use the slider to zoom. The circle previews your avatar.',
      cropPosition: 'Avatar crop; arrow keys move the image, Shift moves faster',
      cropZoom: 'Zoom',
      cropPreview: 'Avatar preview',
      cropReset: 'Reset crop',
      cropConfirm: 'Use avatar',
      cropSaving: 'Saving…',
      menu: 'Account menu',
      settings: 'Settings',
      signOut: 'Sign out',
      signedIn: 'Signed in to DeepSeek',
      cancel: 'Cancel',
      signOutTitle: 'Sign out',
      signOutDescription: 'Signing out will not delete any data. You can sign in to this account again.',
      signOutRunning: 'Tasks are currently running. Signing out will interrupt them. Sign out now?',
      signOutUnknown: 'Could not check running tasks. Signing out may interrupt tasks using this account. Sign out now?',
      signOutFailed: 'Sign out failed. Try again.',
      sessionExpired: 'You have signed out of your account, please log in again.',
      modelSignInRequired: 'Model unavailable. Please sign in and try again.',
      rowTitle: 'Account identity',
      rowDescription: 'Customize the name and picture shown in the sidebar account menu.',
      pageTitle: 'Account identity',
      pageDescription: "Replace the DeepSeek account name and picture in the sidebar account menu with your own.",
      enabledLabel: 'Enable custom account identity',
      enabledOn: 'On',
      enabledOff: 'Paused',
      enabledHint: 'Pausing shows the DeepSeek account name and picture again right away. Saved values are kept.',
      pausedNotice: 'Paused. The sidebar shows the DeepSeek account name and picture.',
      nameLabel: 'Display name',
      namePlaceholder: 'Leave empty to use your account name',
      avatarLabel: 'Avatar',
      avatarChoose: 'Choose image',
      avatarRemove: 'Remove',
      avatarInvalid: 'That file could not be read as an image.',
      avatarTooLarge: 'That image is too large (limit 8 MB).',
      saveFailed: 'Could not save. Try again.',
      reset: 'Use account name and picture',
    }

    module.exports = { apply, inject }
    return module.exports
  },
})
