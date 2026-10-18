import { type AnimationClip, type Bone, type Object3D, Vector3 } from 'three'
import { type JointMap } from './BridgeProtocol.ts'

/**
 * Helpers that place a template skeleton's bones at fitted joint positions and read them back.
 * Joint positions are world metres in the model's own coordinates, as the GLB/FBX loader gave it.
 * `import_scale` is the factor Mesh2Motion applied when it shrank an oversized model on import
 * (1 for most models), so joints go in and come out in the file's coordinates.
 */

/** Bones sorted so every parent comes before its children. */
export function bones_parent_first (bones: Bone[]): Bone[] {
  const depth = (bone: Object3D): number => {
    let d = 0
    for (let p = bone.parent; p !== null; p = p.parent) d++
    return d
  }
  return [...bones].sort((a, b) => depth(a) - depth(b))
}

function update_world (bones: Bone[]): void {
  const roots = new Set<Object3D>()
  for (const bone of bones) {
    let top: Object3D = bone
    while (top.parent !== null) top = top.parent
    roots.add(top)
  }
  roots.forEach(root => { root.updateMatrixWorld(true) })
}

/** World position of every bone, divided by import_scale, rounded to 0.1 mm. */
export function read_joint_positions (bones: Bone[], import_scale: number = 1): JointMap {
  update_world(bones)
  const joints: JointMap = {}
  const p = new Vector3()
  for (const bone of bones) {
    bone.getWorldPosition(p).divideScalar(import_scale)
    joints[bone.name] = [round4(p.x), round4(p.y), round4(p.z)]
  }
  return joints
}

function round4 (n: number): number {
  return Math.round(n * 10000) / 10000
}

/**
 * How much bigger the fitted skeleton is than the template, as the median ratio of bone lengths
 * (each fitted joint to its fitted parent, against the same pair in the template). 1 when no
 * bone and its parent are both given. Mesh2Motion scales root-motion keyframes by this.
 */
export function estimate_skeleton_scale (bones: Bone[], joints: JointMap, import_scale: number = 1): number {
  update_world(bones)
  const ratios: number[] = []
  const a = new Vector3()
  const b = new Vector3()
  for (const bone of bones) {
    const parent = bone.parent
    if (parent === null || !(parent as Bone).isBone) continue
    const target = joints[bone.name]
    const parent_target = joints[parent.name]
    if (target === undefined || parent_target === undefined) continue

    const template_length = bone.getWorldPosition(a).distanceTo(parent.getWorldPosition(b))
    const fitted_length = a.fromArray(target).distanceTo(b.fromArray(parent_target)) * import_scale
    if (template_length > 1e-6 && fitted_length > 1e-6) ratios.push(fitted_length / template_length)
  }
  if (ratios.length === 0) return 1
  ratios.sort((x, y) => x - y)
  const mid = Math.floor(ratios.length / 2)
  return ratios.length % 2 === 1 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2
}

/** Scales every bone's offset from its parent, the way the skeleton scale slider does. */
export function scale_bone_offsets (bones: Bone[], scale: number): void {
  for (const bone of bones) bone.position.multiplyScalar(scale)
  update_world(bones)
}

/**
 * Moves each named bone to its joint position, parents first, keeping bone rotations.
 * Bones with no joint keep their offset from their parent. Returns the joint names that
 * matched no bone.
 */
export function apply_joint_positions (bones: Bone[], joints: JointMap, import_scale: number = 1): string[] {
  const names = new Set(bones.map(bone => bone.name))
  const unknown = Object.keys(joints).filter(name => !names.has(name))

  const target = new Vector3()
  for (const bone of bones_parent_first(bones)) {
    const position = joints[bone.name]
    if (position === undefined) continue
    target.fromArray(position).multiplyScalar(import_scale)
    if (bone.parent !== null) {
      bone.parent.updateWorldMatrix(true, false)
      bone.parent.worldToLocal(target)
    }
    bone.position.copy(target)
    bone.updateMatrixWorld(true)
  }
  return unknown
}

/**
 * True when a clip travels: some position track ends more than `threshold` metres across the
 * floor (x/z) from where it started. Clips that lunge or sway and come back count as in place.
 */
export function clip_has_root_motion (clip: AnimationClip, threshold: number = 0.25): boolean {
  for (const track of clip.tracks) {
    if (!track.name.endsWith('.position')) continue
    const v = track.values
    const last = v.length - 3
    if (last <= 0) continue
    if (Math.hypot(v[last] - v[0], v[last + 2] - v[2]) > threshold) return true
  }
  return false
}
