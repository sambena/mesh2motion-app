import { type AnimationClip } from 'three'
import { type Mesh2MotionEngine } from '../../Mesh2MotionEngine.ts'
import { ProcessStep } from '../enums/ProcessStep.ts'
import { type SkeletonType } from '../enums/SkeletonType.ts'
import { RigConfig } from '../RigConfig.ts'
import { BoneNamingStructure, ExportContents, ExportFormat, FbxExportPreset } from '../processes/export-to-file/DownloadSettings.ts'
import { type ExportFileHandler, type ExportSettings } from '../processes/export-to-file/StepExportToFile.ts'
import { type AnimationExportSelection } from '../processes/animations-listing/interfaces/AnimationExportSelection.ts'
import {
  model_extension, normalize_clip_name, parse_fitted_skeleton, parse_template, template_name,
  type BridgeEvent, type BridgeStep, type BridgeTargetStep, type ClipInfo, type ExportRequest,
  type FittedSkeleton, type JointMap, type LoadRequest
} from './BridgeProtocol.ts'
import { type BridgeHost, type ClipsResult, type ExportResult, type JointsResult, error_message } from './BridgeDispatcher.ts'
import { apply_joint_positions, clip_has_root_motion, estimate_skeleton_scale, read_joint_positions, scale_bone_offsets } from './SkeletonFit.ts'

const LOAD_TIMEOUT_MS = 120_000

/** The bridge's name for a Mesh2Motion process step, or null for the passing BindPose step. */
export function bridge_step (step: ProcessStep): BridgeStep | null {
  switch (step) {
    case ProcessStep.LoadModel: return 'load'
    case ProcessStep.LoadSkeleton: return 'skeleton'
    case ProcessStep.EditSkeleton: return 'edit'
    case ProcessStep.AnimationsListing: return 'animate'
    default: return null
  }
}

/** Resolves on `event_name`, rejects on `fail_name` or after the timeout. */
function wait_for (target: EventTarget, event_name: string, fail_name: string | null, what: string): Promise<Event> {
  return new Promise((resolve, reject) => {
    const done = (): void => {
      clearTimeout(timer)
      target.removeEventListener(event_name, on_ok)
      if (fail_name !== null) target.removeEventListener(fail_name, on_fail)
    }
    const on_ok = (event: Event): void => { done(); resolve(event) }
    const on_fail = (event: Event): void => {
      done()
      reject(new Error(`${what} failed: ${error_message((event as CustomEvent).detail)}`))
    }
    const timer = setTimeout(() => { done(); reject(new Error(`${what} timed out`)) }, LOAD_TIMEOUT_MS)
    target.addEventListener(event_name, on_ok)
    if (fail_name !== null) target.addEventListener(fail_name, on_fail)
  })
}

/** Runs bridge requests against the Mesh2Motion engine and reports what the user does. */
export class EngineBridgeHost implements BridgeHost {
  private last_step: BridgeStep | null = null
  private last_joints_key = ''
  private quiet = false // true while the bridge itself moves bones or selects clips
  private animations_loaded = false
  private pending_export: ExportFileHandler | null = null
  private readonly root_motion_cache = new WeakMap<AnimationClip, boolean>()
  private model_url = ''

  constructor (
    private readonly engine: Mesh2MotionEngine,
    private readonly notify: (event: BridgeEvent) => void,
    private readonly embedded: boolean
  ) {
    this.last_step = bridge_step(engine.process_step)
    this.listen()
    if (embedded) engine.file_export_step.set_file_handler(this.forward_file)
  }

  // exports the user starts with Mesh2Motion's own Download button reach the parent this way
  private readonly forward_file: ExportFileHandler = (blob, filename) => {
    if (this.pending_export !== null) {
      this.pending_export(blob, filename)
      return
    }
    const format = filename.toLowerCase().endsWith('.fbx') ? 'fbx' : 'glb'
    this.notify({ type: 'exported', format, filename, blob })
  }

  private listen (): void {
    const engine = this.engine

    engine.events.addEventListener('step-changed', (event: Event) => {
      const step = bridge_step((event as CustomEvent<ProcessStep>).detail)
      if (step === null || step === this.last_step) return
      if (this.last_step === 'edit' && step === 'animate') this.send_joints_if_changed(true)
      if (step !== 'animate') this.animations_loaded = false
      this.last_step = step
      this.notify({ type: 'stepChanged', step })
    })

    engine.animations_listing_step.addEventListener('animations-loaded', () => {
      this.animations_loaded = true
      engine.animations_listing_step.animation_search?.addEventListener('export-options-changed', () => {
        if (!this.quiet) this.notify({ type: 'clips', ...this.clips_result() })
      })
      this.notify({ type: 'clips', ...this.clips_result() })
    })

    // the user finished a drag, an undo or a key press in the skeleton editor
    const after_edit = (): void => { setTimeout(() => { this.send_joints_if_changed(false) }, 0) }
    document.addEventListener('pointerup', after_edit)
    document.addEventListener('keyup', after_edit)
    engine.edit_skeleton_step.addEventListener('skeletonTransformed', after_edit)
  }

  private send_joints_if_changed (even_if_left: boolean): void {
    if (this.quiet || this.last_joints_key === '') return
    if (!even_if_left && this.engine.process_step !== ProcessStep.EditSkeleton) return
    const result = this.get_joints()
    const key = JSON.stringify(result.joints)
    if (key === this.last_joints_key) return
    this.last_joints_key = key
    this.notify({ type: 'joints', ...result })
  }

  private remember_joints (): void {
    this.last_joints_key = JSON.stringify(this.get_joints().joints)
  }

  // ---------- requests ----------

  public async load (request: LoadRequest): Promise<void> {
    const fitted = await this.fetch_skeleton(request.skeleton)
    if (fitted !== undefined && fitted.template !== '' && parse_template(fitted.template) !== request.template) {
      throw new Error(`skeleton is for template "${fitted.template}", not "${template_name(request.template)}"`)
    }

    await this.load_model(request.model)
    await this.load_template(request.template)

    if (fitted !== undefined) {
      this.place_joints(fitted.joints, true)
    }
    this.remember_joints()

    if (request.step === 'animate') {
      await this.goto('animate')
    }
  }

  /** Loads a model and stops at Mesh2Motion's skeleton step (used alone when no template is given). */
  public async load_model (url: string): Promise<void> {
    const engine = this.engine
    this.last_joints_key = ''
    engine.remove_skinned_meshes_from_scene()
    if (engine.process_step !== ProcessStep.LoadModel) {
      engine.process_step = engine.process_step_changed(ProcessStep.LoadModel)
    }

    const loaded = wait_for(engine.load_model_step, 'modelLoaded', 'modelLoadFailed', `loading ${url}`)
    engine.load_model_step.load_model_file(url, model_extension(url))
    await loaded // Mesh2Motion moves on to the skeleton step itself
    this.model_url = url
  }

  private async load_template (skeleton_type: SkeletonType): Promise<void> {
    const engine = this.engine
    const rig_file = RigConfig.rig_file_for(skeleton_type)
    if (rig_file === undefined) throw new Error(`no rig for template "${skeleton_type}"`)

    // pick the template in the skeleton drop-down, as the user would
    const select = engine.ui.dom_skeleton_drop_type
    if (select !== null) {
      if (select.options.length > 0 && select.options[0].value === 'select-skeleton') select.options.remove(0)
      select.value = skeleton_type
    }
    engine.load_skeleton_step.set_skeleton_scale(1)

    const loaded = wait_for(engine.load_skeleton_step, 'skeletonLoaded', null, `loading the ${template_name(skeleton_type)} skeleton`)
    engine.load_skeleton_step.load_skeleton_file(rig_file)
    await loaded // Mesh2Motion moves on to the edit skeleton step itself
  }

  private async fetch_skeleton (skeleton: LoadRequest['skeleton']): Promise<FittedSkeleton | undefined> {
    if (skeleton === undefined) return undefined
    if (typeof skeleton !== 'string') return skeleton

    const response = await fetch(skeleton)
    if (!response.ok) throw new Error(`skeleton ${skeleton}: HTTP ${response.status}`)
    const fitted = parse_fitted_skeleton(await response.json())
    if (typeof fitted === 'string') throw new Error(`skeleton ${skeleton}: ${fitted}`)
    return fitted
  }

  /** Moves the edit skeleton's bones to the joints. `rescale` first scales the whole template to the fit. */
  private place_joints (joints: JointMap, rescale: boolean): void {
    const engine = this.engine
    const bones = engine.edit_skeleton_step.skeleton().bones
    const import_scale = engine.load_model_step.get_import_scale_factor()

    if (rescale) {
      const scale = estimate_skeleton_scale(bones, joints, import_scale)
      scale_bone_offsets(bones, scale)
      engine.load_skeleton_step.set_skeleton_scale(scale)
    }

    const unknown = apply_joint_positions(bones, joints, import_scale)
    this.quiet = true
    try {
      engine.edit_skeleton_step.bones_moved_externally()
    } finally {
      this.quiet = false
    }
    if (unknown.length > 0) {
      this.notify({ type: 'error', message: `skeleton: no bone named ${unknown.join(', ')} in this template; ignored` })
    }
  }

  public async goto (step: BridgeTargetStep): Promise<void> {
    const engine = this.engine
    const current = engine.process_step
    if (current !== ProcessStep.EditSkeleton && current !== ProcessStep.AnimationsListing) {
      throw new Error('nothing to edit yet: send load first')
    }

    if (step === 'edit') {
      if (current === ProcessStep.AnimationsListing) engine.ui.dom_back_to_edit_skeleton_button?.click()
      return
    }

    if (current === ProcessStep.AnimationsListing) {
      if (!this.animations_loaded) await this.wait_for_animations()
      return
    }
    const listed = this.wait_for_animations()
    engine.ui.dom_bind_pose_button?.click() // skins the model, then lists the clips
    await listed
  }

  private async wait_for_animations (): Promise<void> {
    await wait_for(this.engine.animations_listing_step, 'animations-loaded', 'animations-load-failed', 'loading the animation clips')
  }

  public get_joints (): JointsResult {
    const engine = this.engine
    const step = engine.process_step
    if (step !== ProcessStep.EditSkeleton && step !== ProcessStep.AnimationsListing) {
      throw new Error('no skeleton yet: send load first')
    }
    return {
      template: template_name(engine.load_skeleton_step.skeleton_type()),
      joints: read_joint_positions(engine.edit_skeleton_step.skeleton().bones, engine.load_model_step.get_import_scale_factor())
    }
  }

  public async set_joints (joints: JointMap): Promise<void> {
    const was_animating = this.engine.process_step === ProcessStep.AnimationsListing
    if (was_animating) await this.goto('edit')
    else if (this.engine.process_step !== ProcessStep.EditSkeleton) throw new Error('no skeleton yet: send load first')

    this.place_joints(joints, false)
    this.remember_joints()

    if (was_animating) await this.goto('animate') // skins again with the new joints
  }

  public async select_clips (names: string[]): Promise<ClipsResult> {
    await this.require_clips()
    const { indices, unknown } = this.resolve_clip_names(names)
    this.quiet = true
    try {
      this.engine.animations_listing_step.animation_search?.set_selected_animation_indices(indices)
    } finally {
      this.quiet = false
    }
    const result = this.clips_result()
    if (unknown.length > 0) result.unknown = unknown
    return result
  }

  public async export (request: ExportRequest): Promise<ExportResult> {
    await this.require_clips()
    const listing = this.engine.animations_listing_step

    let selections: AnimationExportSelection[]
    if (request.clips !== undefined) {
      const { indices, unknown } = this.resolve_clip_names(request.clips)
      if (unknown.length > 0) throw new Error(`export: no clip named ${unknown.join(', ')}`)
      selections = indices.map(index => ({ animation_index: index, mirror_export_mode: 'none' }))
    } else {
      selections = listing.get_animation_export_selections()
    }
    if (request.mirror) selections = selections.map(s => ({ ...s, mirror_export_mode: 'both' }))
    if (selections.length === 0) throw new Error('export: no clips selected')

    const settings: ExportSettings = {
      bone_naming_structure: () => request.naming === 'mixamo' ? BoneNamingStructure.Mixamo : BoneNamingStructure.Default,
      export_contents: () => ExportContents.Full,
      export_format: () => request.format === 'fbx' ? ExportFormat.FBX : ExportFormat.GLB,
      fbx_export_preset: () => request.fbxPreset === 'unreal' ? FbxExportPreset.Unreal : FbxExportPreset.Unity
    }

    const exporter = this.engine.file_export_step
    let file: { blob: Blob, filename: string } | null = null
    this.pending_export = (blob, filename) => { file = { blob, filename } }
    if (!this.embedded) exporter.set_file_handler(this.forward_file)
    try {
      exporter.set_animation_clips_to_export(listing.animation_clips(), selections)
      await exporter.export(listing.active_skinned_meshes(), this.export_base_name(), settings)
    } finally {
      this.pending_export = null
      if (!this.embedded) exporter.set_file_handler(null)
    }
    if (file === null) throw new Error('export produced no file')
    const { blob, filename } = file
    return { format: request.format, filename, blob }
  }

  // ---------- clips ----------

  private async require_clips (): Promise<void> {
    if (this.engine.process_step !== ProcessStep.AnimationsListing) {
      throw new Error('no clips yet: go to the animate step first')
    }
    if (!this.animations_loaded) await this.wait_for_animations()
  }

  private resolve_clip_names (names: string[]): { indices: number[], unknown: string[] } {
    const clips = this.engine.animations_listing_step.animation_clips()
    const exact = new Map<string, number>()
    const loose = new Map<string, number>()
    clips.forEach((clip, index) => {
      if (!exact.has(clip.name)) exact.set(clip.name, index)
      const key = normalize_clip_name(clip.name)
      if (!loose.has(key)) loose.set(key, index)
    })

    const indices: number[] = []
    const unknown: string[] = []
    for (const name of names) {
      const index = exact.get(name) ?? loose.get(normalize_clip_name(name))
      if (index === undefined) unknown.push(name)
      else if (!indices.includes(index)) indices.push(index)
    }
    return { indices, unknown }
  }

  private clips_result (): ClipsResult {
    const listing = this.engine.animations_listing_step
    const available: ClipInfo[] = listing.animation_clips().map((clip) => {
      let root_motion = this.root_motion_cache.get(clip)
      if (root_motion === undefined) {
        root_motion = clip_has_root_motion(clip)
        this.root_motion_cache.set(clip, root_motion)
      }
      return { name: clip.name, duration: Math.round(clip.duration * 1000) / 1000, rootMotion: root_motion }
    })
    const selected = listing.animation_search?.get_selected_animations().map(clip => clip.name) ?? []
    return { available, selected }
  }

  private export_base_name (): string {
    const file = this.model_url.split(/[?#]/)[0].split('/').pop() ?? ''
    const base = file.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]+/g, '_')
    return base === '' ? 'exported-model' : base
  }
}
