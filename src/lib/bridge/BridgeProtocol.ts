/**
 * Embedding bridge, protocol v1: the URL parameters and postMessage messages
 * that let a parent page drive create.html inside an iframe.
 * The full protocol is written up in Autorig Workbench's docs/M2M-BRIDGE.md
 * (https://github.com/sambena/autorig-workbench). Keep the two in step.
 *
 * Everything in this file is pure (no DOM, no three.js) so it can be unit tested.
 */
import { SkeletonType } from '../enums/SkeletonType.ts'

export const BRIDGE_PROTOCOL_VERSION = 1

/** Steps as the bridge names them. 'load' and 'skeleton' are only ever reported, never requested. */
export type BridgeStep = 'load' | 'skeleton' | 'edit' | 'animate'
export type BridgeTargetStep = 'edit' | 'animate'

export type ExportFormatName = 'glb' | 'fbx'
export type ExportNaming = 'default' | 'mixamo'
export type FbxPresetName = 'unity' | 'unreal'

/** Joint positions keyed by bone name, in world metres of the loaded model. */
export type JointMap = Record<string, [number, number, number]>

/** The fitted skeleton file the `skeleton` URL parameter (or the `load` message) points to. */
export interface FittedSkeleton {
  template: string
  joints: JointMap
}

export interface EmbedParams {
  embed: boolean
  model: string | null
  template: SkeletonType | null
  skeleton: string | null
  step: BridgeTargetStep | null
  /** Problems found while reading the parameters, reported to the parent as `error` messages. */
  errors: string[]
}

// Template names the bridge accepts. Mesh2Motion calls the shark rig 'fish'; both work.
const TEMPLATE_ALIASES: Record<string, SkeletonType> = {
  human: SkeletonType.Human,
  fox: SkeletonType.Fox,
  horse: SkeletonType.Horse,
  bird: SkeletonType.Bird,
  dragon: SkeletonType.Dragon,
  kaiju: SkeletonType.Kaiju,
  spider: SkeletonType.Spider,
  snake: SkeletonType.Snake,
  shark: SkeletonType.Fish,
  fish: SkeletonType.Fish
}

/** The bridge's name for a template, the reverse of parse_template ('fish' comes back as 'shark'). */
export function template_name (skeleton_type: SkeletonType): string {
  return skeleton_type === SkeletonType.Fish ? 'shark' : skeleton_type
}

export function parse_template (value: unknown): SkeletonType | null {
  if (typeof value !== 'string') return null
  return TEMPLATE_ALIASES[value.trim().toLowerCase()] ?? null
}

export function parse_target_step (value: unknown): BridgeTargetStep | null {
  return value === 'edit' || value === 'animate' ? value : null
}

/** Reads create.html's query string: ?embed=1&model=&template=&skeleton=&step= */
export function parse_embed_params (search: string): EmbedParams {
  const params = new URLSearchParams(search)
  const errors: string[] = []

  const embed_value = params.get('embed')
  const embed = embed_value !== null && embed_value !== '0' && embed_value !== 'false'

  const model = non_empty(params.get('model'))
  const skeleton = non_empty(params.get('skeleton'))

  const template_value = non_empty(params.get('template'))
  const template = parse_template(template_value)
  if (template_value !== null && template === null) {
    errors.push(`unknown template "${template_value}"`)
  }

  const step_value = non_empty(params.get('step'))
  const step = parse_target_step(step_value)
  if (step_value !== null && step === null) {
    errors.push(`unknown step "${step_value}" (use edit or animate)`)
  }

  return { embed, model, template, skeleton, step, errors }
}

function non_empty (value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** File extension of a model URL, ignoring any query string or hash; 'glb' when it has none. */
export function model_extension (url: string): string {
  const path = url.split(/[?#]/)[0]
  const dot = path.lastIndexOf('.')
  const slash = path.lastIndexOf('/')
  if (dot <= slash) return 'glb'
  return path.slice(dot + 1).toLowerCase()
}

// ---------- parent -> app requests ----------

export interface LoadRequest {
  type: 'load'
  model: string
  template: SkeletonType
  skeleton?: string | FittedSkeleton
  step?: BridgeTargetStep
}
export interface GotoRequest { type: 'goto', step: BridgeTargetStep }
export interface GetJointsRequest { type: 'getJoints' }
export interface SetJointsRequest { type: 'setJoints', joints: JointMap }
export interface SelectClipsRequest { type: 'selectClips', names: string[] }
export interface ExportRequest {
  type: 'export'
  format: ExportFormatName
  clips?: string[]
  naming: ExportNaming
  mirror: boolean
  fbxPreset: FbxPresetName
}

export type BridgeRequest =
  | LoadRequest | GotoRequest | GetJointsRequest | SetJointsRequest | SelectClipsRequest | ExportRequest

export type BridgeRequestType = BridgeRequest['type']

/** Result of reading one incoming message: a request, or an error string to send back. */
export type ParsedRequest =
  | { ok: true, id?: string | number, request: BridgeRequest }
  | { ok: false, id?: string | number, message: string }

/**
 * Checks the envelope ({v:1, type, id?}) and the fields of one request.
 * Returns null for data that is not a bridge message at all (other code may use postMessage too).
 */
export function parse_request (data: unknown): ParsedRequest | null {
  if (data === null || typeof data !== 'object') return null
  const msg = data as Record<string, unknown>
  if (!('v' in msg) || typeof msg.type !== 'string') return null

  const id = (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : undefined
  const fail = (message: string): ParsedRequest => ({ ok: false, id, message })

  if (msg.v !== BRIDGE_PROTOCOL_VERSION) return fail(`unsupported protocol version ${String(msg.v)} (this app speaks v${BRIDGE_PROTOCOL_VERSION})`)

  switch (msg.type) {
    case 'load': {
      if (typeof msg.model !== 'string' || msg.model === '') return fail('load: model must be a URL string')
      const template = parse_template(msg.template)
      if (template === null) return fail(`load: unknown template "${String(msg.template)}"`)
      const request: LoadRequest = { type: 'load', model: msg.model, template }
      if (msg.skeleton !== undefined && msg.skeleton !== null) {
        if (typeof msg.skeleton === 'string') {
          request.skeleton = msg.skeleton
        } else {
          const fitted = parse_fitted_skeleton(msg.skeleton)
          if (typeof fitted === 'string') return fail('load: ' + fitted)
          request.skeleton = fitted
        }
      }
      if (msg.step !== undefined && msg.step !== null) {
        const step = parse_target_step(msg.step)
        if (step === null) return fail(`load: unknown step "${String(msg.step)}" (use edit or animate)`)
        request.step = step
      }
      return { ok: true, id, request }
    }
    case 'goto': {
      const step = parse_target_step(msg.step)
      if (step === null) return fail(`goto: unknown step "${String(msg.step)}" (use edit or animate)`)
      return { ok: true, id, request: { type: 'goto', step } }
    }
    case 'getJoints':
      return { ok: true, id, request: { type: 'getJoints' } }
    case 'setJoints': {
      const joints = parse_joint_map(msg.joints)
      if (typeof joints === 'string') return fail('setJoints: ' + joints)
      return { ok: true, id, request: { type: 'setJoints', joints } }
    }
    case 'selectClips': {
      if (!is_string_array(msg.names)) return fail('selectClips: names must be an array of clip names')
      return { ok: true, id, request: { type: 'selectClips', names: msg.names } }
    }
    case 'export': {
      const format = msg.format ?? 'glb'
      if (format !== 'glb' && format !== 'fbx') return fail(`export: unknown format "${String(format)}" (use glb or fbx)`)
      const naming = msg.naming ?? 'default'
      if (naming !== 'default' && naming !== 'mixamo') return fail(`export: unknown naming "${String(naming)}" (use default or mixamo)`)
      if (msg.clips !== undefined && msg.clips !== null && !is_string_array(msg.clips)) return fail('export: clips must be an array of clip names')
      if (msg.mirror !== undefined && typeof msg.mirror !== 'boolean') return fail('export: mirror must be true or false')
      const fbx_preset = msg.fbxPreset ?? 'unity'
      if (fbx_preset !== 'unity' && fbx_preset !== 'unreal') return fail(`export: unknown fbxPreset "${String(fbx_preset)}" (use unity or unreal)`)
      const request: ExportRequest = { type: 'export', format, naming, mirror: msg.mirror === true, fbxPreset: fbx_preset }
      if (Array.isArray(msg.clips)) request.clips = msg.clips
      return { ok: true, id, request }
    }
    default:
      return fail(`unknown message type "${msg.type}"`)
  }
}

export function parse_fitted_skeleton (value: unknown): FittedSkeleton | string {
  if (value === null || typeof value !== 'object') return 'skeleton must be {"template":..., "joints":{...}}'
  const obj = value as Record<string, unknown>
  const joints = parse_joint_map(obj.joints)
  if (typeof joints === 'string') return joints
  return { template: typeof obj.template === 'string' ? obj.template : '', joints }
}

export function parse_joint_map (value: unknown): JointMap | string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'joints must be an object of bone name -> [x, y, z]'
  const joints: JointMap = {}
  for (const [name, position] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(position) || position.length !== 3 || !position.every(n => typeof n === 'number' && Number.isFinite(n))) {
      return `joint "${name}" must be [x, y, z] in metres`
    }
    joints[name] = [position[0], position[1], position[2]]
  }
  return joints
}

function is_string_array (value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string')
}

/** Clip names match exactly, else ignoring case and treating spaces and underscores alike. */
export function normalize_clip_name (name: string): string {
  return name.trim().toLowerCase().replace(/[\s_]+/g, '_')
}

// ---------- app -> parent messages ----------

export interface ClipInfo {
  name: string
  duration: number
  rootMotion: boolean
}

export type BridgeEvent =
  | { type: 'ready', templates: string[] }
  | { type: 'stepChanged', step: BridgeStep }
  | { type: 'joints', template: string, joints: JointMap }
  | { type: 'clips', available: ClipInfo[], selected: string[], unknown?: string[] }
  | { type: 'exported', format: ExportFormatName, filename: string, blob: Blob }
  | { type: 'done', request: BridgeRequestType }
  | { type: 'error', message: string }

export type BridgeOutgoing = BridgeEvent & { v: 1, id?: string | number }
