/**
 * Host half of the account identity bundle.
 *
 * It contributes no behaviour of its own: the setting is declared as this
 * entry's Config so the values live in the profile patch once a browser edits
 * them, survive restarts, and are readable by the Client half through
 * `ctx.configForms.get('account-identity')`.
 *
 * Editable fields must be `.volatile()`. The settings service projects only volatile
 * fields into a form: a volatile field is replaced by a reference carrying the
 * shared write protocol, and the form projection keeps nothing else. An ordinary
 * string field therefore still appears in the Config schema but is absent from
 * the editable value set, so writes are silently refused — the reason both
 * original fields produced a visible row whose edits did nothing.
 */
import z from '@deepseek-ai/schemastery'

/** Longest accepted display name, in characters. */
const NAME_LIMIT = 40

/** Largest accepted avatar data URL, in characters (roughly 3 MB of PNG data). */
const AVATAR_LIMIT = 4 * 1024 * 1024

export const Config = z.object({
  enabled: z
    .boolean()
    .default(true)
    .description('Use the custom name and picture. Turn off to show the DeepSeek account name and picture again.')
    .volatile(),
  displayName: z
    .string()
    .max(NAME_LIMIT)
    .default('')
    .description('Shown instead of the DeepSeek account name; empty keeps the account name.')
    .volatile(),
  // Internal ownership receipt for reversible theme-name synchronization.
  themeNameState: z.string().max(2048).default('').volatile(),
  avatarDataUrl: z
    .string()
    .max(AVATAR_LIMIT)
    .default('')
    .description('User-cropped square PNG avatar as a data URL; empty keeps the account picture.')
    .volatile(),
})

/**
 * Publish the plugin-scoped settings page policy.
 * @param ctx - Host context that owns the entry.
 */
export function apply(ctx) {
  ctx.inject(['settings'], (scope) => {
    scope.effect(
      () => scope.settings.configure({ auto: false }, ctx.fiber),
      'account-identity: settings presentation',
    )
  })
}
