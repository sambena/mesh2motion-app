import { describe, it, expect } from 'vitest'
import { SkeletonType } from '../enums/SkeletonType'
import {
  model_extension, normalize_clip_name, parse_embed_params, parse_joint_map, parse_request, template_name
} from './BridgeProtocol'

describe('parse_embed_params', () => {
  it('reads every parameter', () => {
    const p = parse_embed_params('?embed=1&model=models/model-human.glb&template=human&skeleton=fit.json&step=animate')
    expect(p).toEqual({
      embed: true,
      model: 'models/model-human.glb',
      template: SkeletonType.Human,
      skeleton: 'fit.json',
      step: 'animate',
      errors: []
    })
  })

  it('defaults to a normal, empty page', () => {
    expect(parse_embed_params('')).toEqual({ embed: false, model: null, template: null, skeleton: null, step: null, errors: [] })
  })

  it('treats embed=0 and embed=false as off, any other value as on', () => {
    expect(parse_embed_params('?embed=0').embed).toBe(false)
    expect(parse_embed_params('?embed=false').embed).toBe(false)
    expect(parse_embed_params('?embed=true').embed).toBe(true)
    expect(parse_embed_params('?embed').embed).toBe(true)
  })

  it('maps shark to Mesh2Motion\'s fish rig and ignores case', () => {
    expect(parse_embed_params('?template=Shark').template).toBe(SkeletonType.Fish)
    expect(parse_embed_params('?template=fish').template).toBe(SkeletonType.Fish)
    expect(template_name(SkeletonType.Fish)).toBe('shark')
  })

  it('reports unknown templates and steps', () => {
    const p = parse_embed_params('?template=octopus&step=load')
    expect(p.template).toBeNull()
    expect(p.step).toBeNull()
    expect(p.errors).toHaveLength(2)
  })

  it('decodes URL-encoded model URLs', () => {
    expect(parse_embed_params('?model=%2Fapi%2Fv1%2Fmodels%2Fa%20b.glb%3Ft%3D1').model).toBe('/api/v1/models/a b.glb?t=1')
  })
})

describe('model_extension', () => {
  it('ignores query strings and folders with dots', () => {
    expect(model_extension('/files/x.FBX?token=1')).toBe('fbx')
    expect(model_extension('a.b/model')).toBe('glb')
    expect(model_extension('model.glb#frag')).toBe('glb')
  })
})

describe('parse_request', () => {
  it('ignores data that is not a bridge message', () => {
    expect(parse_request('hello')).toBeNull()
    expect(parse_request({ type: 'load' })).toBeNull()
    expect(parse_request(null)).toBeNull()
  })

  it('rejects other protocol versions, keeping the id', () => {
    expect(parse_request({ v: 2, type: 'getJoints', id: 7 })).toEqual({ ok: false, id: 7, message: expect.stringContaining('version') })
  })

  it('reads load with an inline skeleton', () => {
    const r = parse_request({ v: 1, id: 'a', type: 'load', model: 'm.glb', template: 'fox', skeleton: { template: 'fox', joints: { hips: [0, 1, 0] } }, step: 'edit' })
    expect(r).toEqual({
      ok: true,
      id: 'a',
      request: { type: 'load', model: 'm.glb', template: SkeletonType.Fox, skeleton: { template: 'fox', joints: { hips: [0, 1, 0] } }, step: 'edit' }
    })
  })

  it('reads load with a skeleton URL', () => {
    const r = parse_request({ v: 1, type: 'load', model: 'm.glb', template: 'human', skeleton: 'fit.json' })
    expect(r?.ok && r.request).toEqual({ type: 'load', model: 'm.glb', template: SkeletonType.Human, skeleton: 'fit.json' })
  })

  it('checks load fields', () => {
    expect(parse_request({ v: 1, type: 'load', template: 'human' })?.ok).toBe(false)
    expect(parse_request({ v: 1, type: 'load', model: 'm.glb', template: 'cat' })?.ok).toBe(false)
    expect(parse_request({ v: 1, type: 'load', model: 'm.glb', template: 'human', step: 'skin' })?.ok).toBe(false)
    expect(parse_request({ v: 1, type: 'load', model: 'm.glb', template: 'human', skeleton: { joints: { hips: [0, 1] } } })?.ok).toBe(false)
  })

  it('reads goto, getJoints, setJoints and selectClips', () => {
    expect(parse_request({ v: 1, type: 'goto', step: 'animate' })).toEqual({ ok: true, request: { type: 'goto', step: 'animate' } })
    expect(parse_request({ v: 1, type: 'goto', step: 'load' })?.ok).toBe(false)
    expect(parse_request({ v: 1, type: 'getJoints', id: 3 })).toEqual({ ok: true, id: 3, request: { type: 'getJoints' } })
    expect(parse_request({ v: 1, type: 'setJoints', joints: { head: [0, 1.6, 0] } })).toEqual({ ok: true, request: { type: 'setJoints', joints: { head: [0, 1.6, 0] } } })
    expect(parse_request({ v: 1, type: 'selectClips', names: ['Walk', 'Run'] })).toEqual({ ok: true, request: { type: 'selectClips', names: ['Walk', 'Run'] } })
    expect(parse_request({ v: 1, type: 'selectClips', names: 'Walk' })?.ok).toBe(false)
  })

  it('fills export defaults', () => {
    expect(parse_request({ v: 1, type: 'export' })).toEqual({
      ok: true,
      request: { type: 'export', format: 'glb', naming: 'default', mirror: false, fbxPreset: 'unity' }
    })
    expect(parse_request({ v: 1, type: 'export', format: 'fbx', clips: ['Walk'], naming: 'mixamo', mirror: true, fbxPreset: 'unreal' })).toEqual({
      ok: true,
      request: { type: 'export', format: 'fbx', clips: ['Walk'], naming: 'mixamo', mirror: true, fbxPreset: 'unreal' }
    })
  })

  it('checks export fields', () => {
    expect(parse_request({ v: 1, type: 'export', format: 'obj' })?.ok).toBe(false)
    expect(parse_request({ v: 1, type: 'export', naming: 'unreal' })?.ok).toBe(false)
    expect(parse_request({ v: 1, type: 'export', mirror: 'yes' })?.ok).toBe(false)
    expect(parse_request({ v: 1, type: 'export', clips: [1] })?.ok).toBe(false)
  })

  it('rejects unknown types', () => {
    expect(parse_request({ v: 1, type: 'explode', id: 1 })).toEqual({ ok: false, id: 1, message: expect.stringContaining('explode') })
  })
})

describe('parse_joint_map', () => {
  it('needs finite [x, y, z] triples', () => {
    expect(parse_joint_map({ a: [1, 2, 3] })).toEqual({ a: [1, 2, 3] })
    expect(typeof parse_joint_map({ a: [1, 2, Number.NaN] })).toBe('string')
    expect(typeof parse_joint_map([[1, 2, 3]])).toBe('string')
  })
})

describe('normalize_clip_name', () => {
  it('treats spaces, underscores and case alike', () => {
    expect(normalize_clip_name(' Walk  Forward ')).toBe(normalize_clip_name('walk_forward'))
  })
})
