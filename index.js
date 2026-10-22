/**
 * dsh-auto-meta — Host half.
 *
 * The plugin is driven entirely from the settings page in the browser: it adds
 * an icon button to every model row and fills that row's inputs from the
 * models.dev catalog (see `client.js`). Nothing is needed on the host, so this
 * entry point stays empty on purpose — the bundle row still resolves here, and
 * `client.js` is what the web client loads for the same row.
 *
 * (Version 0.1.0 exposed a model-facing `auto_meta_apply` tool instead. It was
 * replaced: filling the form the user is looking at is the interaction they
 * asked for, and it keeps the settings page the single writer of its own
 * revision.)
 */

export function apply() {}
