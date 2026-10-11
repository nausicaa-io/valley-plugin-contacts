import type { MountedPluginView, ValleyPluginApi } from '@valley/plugin-sdk'
import type { CommandContext, CommandFileTarget } from '@valley/plugin-sdk/commands'
import { React, api } from './runtime'
import { RELATION_TYPES } from './types'

const text = (maxLength = 65536) => ({ type: 'string', maxLength })
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false })
const index = { type: 'integer', minimum: 0, maximum: 255 }
const scalarFields = ['firstName', 'middleName', 'lastName', 'nickname', 'birthdate', 'profession', 'cover', 'fileName', 'note']
const scalarProperties = Object.fromEntries(scalarFields.map(field => [field, text(field === 'birthdate' ? 64 : 65536)]))
const rowProperties = { phone: { value: text(), type: text(4096) }, email: { value: text(), type: text(4096) }, place: { value: text(), type: text(4096) }, organization: { name: text(), title: text(), dept: text() }, social: { platform: text(4096), handle: text(), url: text() }, website: { value: text() }, relation: { toName: text(), type: { enum: [...RELATION_TYPES] }, role: text() } }
export type ContactCollection = keyof typeof rowProperties
const collections = Object.keys(rowProperties) as ContactCollection[]
const targetSchema = object({ mountId: text(256), generation: { type: 'integer', minimum: 0 } })
const action = (type: string, properties: Record<string, unknown> = {}) => object({ type: { const: type }, ...properties })
export const contactFileControlSchema = { oneOf: [
  action('mode', { value: { enum: ['reading', 'editing'] } }), action('patch', { fields: { ...object(scalarProperties, []), minProperties: 1 } }),
  action('row-add', { collection: { enum: collections } }), action('row-remove', { collection: { enum: collections }, index }),
  ...collections.map(collection => action('row-edit', { collection: { const: collection }, index, fields: { ...object(rowProperties[collection], []), minProperties: 1 } })),
  action('group-add', { value: text(4096) }), action('group-remove', { value: text(4096) }), action('group-move', { from: index, to: index }), action('social-move', { from: index, to: index }), action('social-platform', { index, value: text(4096) }), action('reload')
] }
export const contactFileSaveSchema = { oneOf: [action('flush'), action('reading-group-add', { value: text(4096) }), action('reading-group-remove', { value: text(4096) })] }
export const contactFileExecuteSchema = { oneOf: [action('settings'), action('link-open', { kind: { enum: ['phone', 'email', 'website', 'social', 'address', 'relation'] }, index })] }
export type ContactFileAction = { type: 'mode'; value: 'reading' | 'editing' } | { type: 'patch'; fields: Record<string, string> } | { type: 'row-add'; collection: ContactCollection } | { type: 'row-edit'; collection: ContactCollection; index: number; fields: Record<string, string> } | { type: 'row-remove'; collection: ContactCollection; index: number } | { type: 'group-add' | 'group-remove' | 'reading-group-add' | 'reading-group-remove'; value: string } | { type: 'group-move' | 'social-move'; from: number; to: number } | { type: 'social-platform'; index: number; value: string } | { type: 'link-open'; kind: 'phone' | 'email' | 'website' | 'social' | 'address' | 'relation'; index: number } | { type: 'reload' | 'flush' | 'settings' }
export interface ContactFileActionContext { validate(paths?: CommandFileTarget[]): Promise<void> }
/** `targets` declares the extra vault files an action reads besides the mounted file; the command's fileTargets resolver publishes them, so `validate()` re-checks exactly the declared set. */
export interface ContactFileController { snapshot(): Record<string, unknown>; actions: Partial<Record<ContactFileAction['type'], (action: ContactFileAction, context: ContactFileActionContext) => void | Promise<unknown>>>; targets?: Partial<Record<ContactFileAction['type'], (action: ContactFileAction) => CommandFileTarget[]>> }
interface Entry { target: MountedPluginView; controllers: Map<'view' | 'form' | 'reader', { token: symbol; current: ContactFileController }>; signature: string; revision: string; pending: boolean }
const state = (ownerApi = api) => ownerApi.runtime.getOrCreate('contacts.fileActions', () => ({ owners: new Map<string, Entry>(), identity: crypto.randomUUID(), sequence: 0 }))
const keyOf = (target: Pick<MountedPluginView, 'mountId' | 'generation'>) => JSON.stringify([target.mountId, target.generation])
const nextRevision = (ownerApi = api) => { const current = state(ownerApi); return `${current.identity}:${++current.sequence}` }
export const CONFIRMED_LINK_OPEN = Symbol('contacts.confirmedLinkOpen')
const isConfirmedLinkOpen = (effect: unknown): boolean => !!effect && typeof effect === 'object' && (effect as Record<symbol, unknown>)[CONFIRMED_LINK_OPEN] === true
const refuse = (code: string, message: string) => Object.assign(new Error(message), { code, outcome: 'not-applied' })
function record(raw: unknown, fields: readonly string[], required = fields): Record<string, unknown> { if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !fields.includes(key)) || required.some(key => !(key in raw))) throw new Error('Expected a strict Contacts file action object.'); return raw as Record<string, unknown> }
function string(raw: unknown, maximum = 65536): string { if (typeof raw !== 'string' || raw.length > maximum) throw new Error('Invalid or oversized Contacts action text.'); return raw }
function position(raw: unknown): number { if (!Number.isSafeInteger(raw) || Number(raw) < 0 || Number(raw) > 255) throw new Error('Expected a bounded Contacts row position.'); return Number(raw) }
function parseAction(raw: unknown, types: readonly string[]): ContactFileAction {
  const type = record(raw, ['type', 'value', 'fields', 'collection', 'index', 'from', 'to', 'kind'], ['type']).type
  if (typeof type !== 'string' || !types.includes(type)) throw new Error('This Contacts action requires its declared effect route.')
  if (type === 'mode') { const input = record(raw, ['type', 'value']); if (input.value !== 'reading' && input.value !== 'editing') throw new Error('Expected a Contacts view mode.'); return { type, value: input.value } }
  if (type === 'patch' || type === 'row-edit') {
    const input = record(raw, type === 'patch' ? ['type', 'fields'] : ['type', 'collection', 'index', 'fields'])
    if (type === 'row-edit' && !collections.includes(input.collection as ContactCollection)) throw new Error('Expected a Contacts row collection.')
    const allowed = type === 'patch' ? scalarFields : Object.keys(rowProperties[input.collection as ContactCollection])
    const fields = record(input.fields, allowed, [])
    if (!Object.keys(fields).length) throw new Error('Expected one or more Contacts draft fields.')
    for (const [key, value] of Object.entries(fields)) { string(value, key === 'birthdate' ? 64 : key === 'type' || key === 'platform' ? 4096 : 65536); if (key === 'type' && input.collection === 'relation' && !(RELATION_TYPES as readonly string[]).includes(String(value))) throw new Error('Expected a supported Contacts relation type.') }
    return type === 'patch' ? { type, fields: fields as Record<string, string> } : { type, collection: input.collection as ContactCollection, index: position(input.index), fields: fields as Record<string, string> }
  }
  if (type === 'row-add' || type === 'row-remove') { const input = record(raw, type === 'row-add' ? ['type', 'collection'] : ['type', 'collection', 'index']); if (!collections.includes(input.collection as ContactCollection)) throw new Error('Expected a Contacts row collection.'); return type === 'row-add' ? { type, collection: input.collection as ContactCollection } : { type, collection: input.collection as ContactCollection, index: position(input.index) } }
  if (type === 'group-move' || type === 'social-move') { const input = record(raw, ['type', 'from', 'to']); return { type, from: position(input.from), to: position(input.to) } }
  if (type === 'link-open') { const input = record(raw, ['type', 'kind', 'index']); if (!['phone', 'email', 'website', 'social', 'address', 'relation'].includes(String(input.kind))) throw new Error('Expected a Contacts link kind.'); return { type, kind: input.kind as Extract<ContactFileAction, { type: 'link-open' }>['kind'], index: position(input.index) } }
  if (type === 'social-platform') { const input = record(raw, ['type', 'index', 'value']); return { type, index: position(input.index), value: string(input.value, 4096) } }
  if (type.includes('group-')) { const input = record(raw, ['type', 'value']); return { type, value: string(input.value, 4096) } as ContactFileAction }
  record(raw, ['type']); return { type } as ContactFileAction
}
function parseInput(raw: unknown, types?: readonly string[]) {
  const input = record(raw, types ? ['target', 'expectedRevision', 'action'] : ['target']), target = record(input.target, ['mountId', 'generation'])
  const mountId = string(target.mountId, 256)
  if (!mountId || !Number.isSafeInteger(target.generation) || Number(target.generation) < 0) throw new Error('Expected the exact Contacts mounted view generation.')
  return { target: { mountId, generation: Number(target.generation) }, ...(types ? { expectedRevision: string(input.expectedRevision, 256), action: parseAction(input.action, types) } : {}) }
}
function owner(target: Pick<MountedPluginView, 'mountId' | 'generation'>, ownerApi = api): Entry { const entry = state(ownerApi).owners.get(keyOf(target)); if (!entry?.controllers.has('view')) throw refuse('TARGET_REPLACED', 'The exact Contacts file view is unavailable. Inspect its current mount.'); return entry }
function inspect(entry: Entry, ownerApi = api) {
  const view = entry.controllers.get('view')!.current.snapshot(), form = entry.controllers.get('form')?.current.snapshot() ?? null, reader = entry.controllers.get('reader')?.current.snapshot() ?? null
  const signature = JSON.stringify({ view, form, reader })
  if (new TextEncoder().encode(signature).byteLength > 131072) throw refuse('OUTPUT_TOO_LARGE', 'The complete Contacts file observation exceeds its response bound.')
  if (signature !== entry.signature) { entry.signature = signature; entry.revision = nextRevision(ownerApi) }
  return { target: { mountId: entry.target.mountId, generation: entry.target.generation }, filePath: entry.target.filePath, revision: entry.revision, view, form, reader }
}
export function useContactFileActions(target: MountedPluginView | undefined, part: 'view' | 'form' | 'reader', controller: ContactFileController): void {
  const latest = React.useRef(controller); latest.current = controller
  const [ownerApi] = React.useState(() => api)
  const key = target ? keyOf(target) : null
  React.useEffect(() => {
    if (!key || !target) return
    const current = state(ownerApi), token = Symbol()
    let entry = current.owners.get(key)
    if (!entry) { entry = { target, controllers: new Map(), signature: '', revision: nextRevision(ownerApi), pending: false }; current.owners.set(key, entry) }
    if (entry.controllers.has(part)) throw new Error('This Contacts mounted controller is already registered.')
    entry.controllers.set(part, { token, current: { snapshot: () => latest.current.snapshot(), actions: Object.fromEntries(Object.keys(controller.actions).map(type => [type, (action: ContactFileAction, context: ContactFileActionContext) => latest.current.actions[action.type]?.(action, context)])), targets: Object.fromEntries(Object.keys(controller.actions).map(type => [type, (action: ContactFileAction) => latest.current.targets?.[action.type]?.(action) ?? []])) } }); entry.signature = ''; entry.revision = nextRevision(ownerApi)
    const captured = entry
    return () => { if (captured.controllers.get(part)?.token !== token) return; captured.controllers.delete(part); captured.signature = ''; captured.revision = nextRevision(ownerApi); if (part === 'view' && current.owners.get(key) === captured) current.owners.delete(key) }
  }, [ownerApi, key, part])
}
export function registerContactFileCommands(pluginApi: ValleyPluginApi): () => void {
  const ownerApi = pluginApi
  const inputSchema = (actions?: Record<string, unknown>) => object({ target: targetSchema, ...(actions ? { expectedRevision: text(256), action: actions } : {}) })
  const array = (items: Record<string, unknown>) => ({ type: 'array', maxItems: 256, items })
  const methodSchema = object(rowProperties.phone, ['value']), organizationSchema = object(rowProperties.organization, []), socialSchema = object(rowProperties.social, [])
  const formSchema = object({ ...scalarProperties, groups: array(text(4096)), phone: array(methodSchema), email: array(methodSchema), place: array(methodSchema), organization: array(organizationSchema), social: array(object({ uid: text(256), value: socialSchema })), websites: array(text()), relations: array(object({ ...rowProperties.relation, ref: text(), label: text() })), ready: { type: 'boolean' }, saving: { type: 'boolean' }, prepared: { type: 'boolean' }, error: text(), editorRevision: text(256), dirty: { type: 'boolean' }, ownsDraft: { type: 'boolean' } })
  const readerSchema = object({ groups: array(text(4096)), savingGroups: { type: 'boolean' }, phone: array(methodSchema), email: array(methodSchema), place: array(methodSchema), websites: array(text()), social: array(socialSchema), relations: array(object({ to: text(), type: { enum: [...RELATION_TYPES] }, role: text() }, ['to', 'type'])), documentRevision: { anyOf: [text(256), { type: 'null' }] } })
  const viewSchema = object({ mode: { enum: ['reading', 'editing'] }, displayName: text() })
  const inspectionSchema = object({ target: targetSchema, filePath: text(32768), revision: text(256), view: viewSchema, form: { anyOf: [formSchema, { type: 'null' }] }, reader: { anyOf: [readerSchema, { type: 'null' }] } })
  const resultSchema = object({ status: { const: 'queued' }, target: targetSchema, action: text(256), originalRevision: text(256) })
  const revisionRequirements = [{ argument: 'expectedRevision', inspectionCommand: 'contacts:file-view-inspect', description: 'Exact mounted Contacts mode, reading values and retained raw form/editor revision.' }]
  const fileTargets = (input: ReturnType<typeof parseInput>, write = false): CommandFileTarget[] => {
    const entry = owner(input.target, ownerApi), action = input.action
    const controller = action ? [...entry.controllers.values()].find(controller => controller.current.actions[action.type]) : undefined
    return [{ kind: 'file', path: entry.target.filePath, fileOperation: write ? 'write' : 'read' }, ...(action ? controller?.current.targets?.[action.type]?.(action) ?? [] : [])]
  }
  const invoke = async (input: ReturnType<typeof parseInput>, context: CommandContext) => {
    const entry = owner(input.target, ownerApi), observation = inspect(entry, ownerApi)
    if (entry.pending || !input.action || observation.revision !== input.expectedRevision) throw refuse('REVISION_CONFLICT', 'Contacts state changed. Inspect its exact file view again.')
    const action = input.action, controller = [...entry.controllers.values()].find(controller => controller.current.actions[action.type])
    if (!controller) throw refuse('CONTROL_UNAVAILABLE', 'This Contacts action requires its current reading view or raw editor.')
    if (['patch', 'row-add', 'row-edit', 'row-remove', 'group-add', 'group-remove', 'group-move', 'social-move', 'social-platform'].includes(action.type) && observation.view.mode !== 'editing') throw refuse('CONTROL_UNAVAILABLE', 'Open this exact Contact raw editing view before changing its fields.')
    const assertCurrent = (): void => { if (context.cancellation?.aborted) throw refuse('CANCELLED', 'The Contacts action was cancelled before its effect.'); if (state(ownerApi).owners.get(keyOf(input.target)) !== entry || !entry.controllers.has('view') || ![...entry.controllers.values()].includes(controller)) throw refuse('TARGET_REPLACED', 'The Contacts action owner changed before its effect.') }
    const validate = async (targets?: CommandFileTarget[]): Promise<void> => { assertCurrent(); const before = inspect(entry, ownerApi).revision; if (context.validateBeforeRun && !await context.validateBeforeRun(targets ?? fileTargets(input, ['flush', 'reading-group-add', 'reading-group-remove'].includes(action.type)))) throw refuse('PERMISSION_DENIED', 'The Contacts action was denied before its effect.'); assertCurrent(); if (inspect(entry, ownerApi).revision !== before) throw refuse('REVISION_CONFLICT', 'Contacts changed while authorization was pending.') }
    await validate(); if (inspect(entry, ownerApi).revision !== input.expectedRevision) throw refuse('REVISION_CONFLICT', 'Contacts changed before dispatch.')
    entry.pending = true; entry.revision = nextRevision(ownerApi)
    try { const effect = await controller.current.actions[action.type]!(action, { validate }); if ((state(ownerApi).owners.get(keyOf(input.target)) !== entry || !entry.controllers.has('view')) && !(action.type === 'link-open' && isConfirmedLinkOpen(effect))) throw new Error('The Contacts file view disappeared after dispatch.'); return { status: 'queued' as const, target: input.target, action: action.type, originalRevision: input.expectedRevision! } }
    catch (cause) { if ((cause as { outcome?: string })?.outcome === 'not-applied') throw cause; throw Object.assign(new Error('The Contacts action was dispatched without a confirmed effect. Inspect its original execution and retained form/file; do not replay it.'), { code: 'EFFECT_UNVERIFIED', outcome: 'unknown', outcomeUnknown: true, retryable: false, cause }) }
    finally { entry.pending = false; entry.signature = ''; entry.revision = nextRevision(ownerApi) }
  }
  const disposers = [pluginApi.commands.register({ id: 'file-view-inspect', label: 'Contacts: inspect exact mounted file view and raw form', sideEffect: 'read', paletteSafe: false, input: { schema: inputSchema(), parse: raw => parseInput(raw) }, outputSchema: inspectionSchema, fileTargets, recovery: 'observational', idempotent: true, limits: { requestBytes: 131072, responseBytes: 131072 }, run: input => inspect(owner(input.target, ownerApi), ownerApi) })]
  const controlTypes = ['mode', 'patch', 'row-add', 'row-edit', 'row-remove', 'group-add', 'group-remove', 'group-move', 'social-move', 'social-platform', 'reload'], saveTypes = ['flush', 'reading-group-add', 'reading-group-remove'], executeTypes = ['link-open', 'settings']
  for (const [id, types, schema, effect] of [['file-view-control', controlTypes, contactFileControlSchema, 'write'], ['file-view-save', saveTypes, contactFileSaveSchema, 'write'], ['file-view-execute', executeTypes, contactFileExecuteSchema, 'execute']] as const) {
    if (effect === 'execute') disposers.push(pluginApi.commands.register({ id, label: 'Contacts: execute exact reading action', sideEffect: effect, paletteSafe: false, input: { schema: inputSchema(schema), parse: raw => parseInput(raw, types) }, outputSchema: resultSchema, revision: input => inspect(owner(input.target, ownerApi), ownerApi), fileTargets: input => fileTargets(input), revisionRequirements, recovery: 'non-replayable', idempotent: false, limits: { requestBytes: 131072, responseBytes: 131072 }, run: invoke }))
    else disposers.push(pluginApi.commands.register({ id, label: 'Contacts: change exact raw draft or save observed edits', sideEffect: effect, paletteSafe: false, input: { schema: inputSchema(schema), parse: raw => parseInput(raw, types) }, outputSchema: resultSchema, revision: input => inspect(owner(input.target, ownerApi), ownerApi), fileTargets: input => fileTargets(input, id === 'file-view-save'), revisionRequirements, recovery: 'non-replayable', idempotent: false, limits: { requestBytes: 131072, responseBytes: 131072 }, preview: input => input, run: async (input, context) => ({ value: await invoke(input, context), revert: null }) }))
  }
  return () => { disposers.forEach(dispose => dispose()); state(ownerApi).owners.clear() }
}
