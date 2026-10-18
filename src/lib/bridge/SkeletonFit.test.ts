import { describe, it, expect } from 'vitest'
import { AnimationClip, Bone, Object3D, VectorKeyframeTrack } from 'three'
import {
  apply_joint_positions, bones_parent_first, clip_has_root_motion, estimate_skeleton_scale, read_joint_positions, scale_bone_offsets
} from './SkeletonFit'

// armature -> hips (0,1,0) -> spine (0,0.5,0) -> head (0,0.5,0)
function make_chain (): { armature: Object3D, bones: Bone[] } {
  const armature = new Object3D()
  const hips = new Bone(); hips.name = 'hips'; hips.position.set(0, 1, 0)
  const spine = new Bone(); spine.name = 'spine'; spine.position.set(0, 0.5, 0)
  const head = new Bone(); head.name = 'head'; head.position.set(0, 0.5, 0)
  armature.add(hips); hips.add(spine); spine.add(head)
  return { armature, bones: [head, hips, spine] } // deliberately not parent-first
}

describe('SkeletonFit', () => {
  it('sorts parents before children', () => {
    const { bones } = make_chain()
    expect(bones_parent_first(bones).map(b => b.name)).toEqual(['hips', 'spine', 'head'])
  })

  it('reads world positions', () => {
    const { bones } = make_chain()
    expect(read_joint_positions(bones)).toEqual({ head: [0, 2, 0], hips: [0, 1, 0], spine: [0, 1.5, 0] })
  })

  it('places bones at world positions, parents first, and carries unlisted children along', () => {
    const { bones } = make_chain()
    const unknown = apply_joint_positions(bones, { hips: [0.1, 0.8, 0], spine: [0.1, 1.2, 0.05], tail: [0, 0, 0] })
    expect(unknown).toEqual(['tail'])
    const joints = read_joint_positions(bones)
    expect(joints.hips).toEqual([0.1, 0.8, 0])
    expect(joints.spine).toEqual([0.1, 1.2, 0.05])
    expect(joints.head).toEqual([0.1, 1.7, 0.05]) // keeps its 0.5 offset from spine
  })

  it('handles rotated parents', () => {
    const { bones } = make_chain()
    bones[1].rotation.z = Math.PI / 2 // rotate hips
    apply_joint_positions(bones, { spine: [0, 1.25, 0] })
    expect(read_joint_positions(bones).spine).toEqual([0, 1.25, 0])
  })

  it('round-trips through the import scale', () => {
    const { bones } = make_chain()
    apply_joint_positions(bones, { hips: [0, 4, 0] }, 0.5) // a 4 m model shrunk to half on import
    expect(bones[1].position.y).toBeCloseTo(2)
    expect(read_joint_positions(bones, 0.5).hips).toEqual([0, 4, 0])
  })

  it('estimates the fit\'s size against the template', () => {
    const { bones } = make_chain()
    expect(estimate_skeleton_scale(bones, { hips: [0, 2, 0], spine: [0, 3, 0], head: [0, 4, 0] })).toBeCloseTo(2)
    expect(estimate_skeleton_scale(bones, { hips: [0, 2, 0] })).toBe(1) // no bone with its parent
  })

  it('scales bone offsets', () => {
    const { bones } = make_chain()
    scale_bone_offsets(bones, 0.5)
    expect(read_joint_positions(bones).head).toEqual([0, 1, 0])
  })

  it('tells travelling clips from in-place ones', () => {
    const walk = new AnimationClip('walk', 1, [new VectorKeyframeTrack('hips.position', [0, 1], [0, 1, 0, 0, 1, 1.2])])
    const idle = new AnimationClip('idle', 1, [new VectorKeyframeTrack('hips.position', [0, 1], [0, 1, 0, 0.01, 0.9, 0.01])])
    expect(clip_has_root_motion(walk)).toBe(true)
    expect(clip_has_root_motion(idle)).toBe(false)
    const lunge = new AnimationClip('lunge', 1, [new VectorKeyframeTrack('hips.position', [0, 0.5, 1], [0, 1, 0, 0, 1, 0.8, 0, 1, 0.02])])
    expect(clip_has_root_motion(lunge)).toBe(false) // goes out and comes back
  })
})
