import { describe, it, expect, vi } from 'vitest'
import { BridgeDispatcher, type BridgeHost } from './BridgeDispatcher'
import { type BridgeOutgoing } from './BridgeProtocol'

const ORIGIN = 'http://localhost:8792'

function make_host (overrides: Partial<BridgeHost> = {}): BridgeHost {
  return {
    load: vi.fn(async () => {}),
    goto: vi.fn(async () => {}),
    get_joints: vi.fn(() => ({ template: 'human', joints: { hips: [0, 1, 0] as [number, number, number] } })),
    set_joints: vi.fn(async () => {}),
    select_clips: vi.fn(async (names: string[]) => ({ available: [{ name: 'Walk', duration: 1, rootMotion: false }], selected: names })),
    export: vi.fn(async () => ({ format: 'glb' as const, filename: 'm.glb', blob: new Blob(['x']) })),
    ...overrides
  }
}

function setup (overrides: Partial<BridgeHost> = {}): { host: BridgeHost, sent: BridgeOutgoing[], dispatcher: BridgeDispatcher } {
  const host = make_host(overrides)
  const sent: BridgeOutgoing[] = []
  const dispatcher = new BridgeDispatcher(host, (m) => { sent.push(m) }, ORIGIN)
  return { host, sent, dispatcher }
}

describe('BridgeDispatcher', () => {
  it('ignores messages from other origins', async () => {
    const { host, sent, dispatcher } = setup()
    await dispatcher.handle_message({ origin: 'https://evil.example', data: { v: 1, type: 'getJoints', id: 1 } })
    expect(sent).toEqual([])
    expect(host.get_joints).not.toHaveBeenCalled()
  })

  it('ignores data that is not a bridge message', async () => {
    const { sent, dispatcher } = setup()
    await dispatcher.handle_message({ origin: ORIGIN, data: { hello: 'world' } })
    expect(sent).toEqual([])
  })

  it('answers a bad request with an error carrying its id', async () => {
    const { sent, dispatcher } = setup()
    await dispatcher.handle_message({ origin: ORIGIN, data: { v: 1, type: 'goto', step: 'nowhere', id: 9 } })
    expect(sent).toEqual([{ v: 1, type: 'error', id: 9, message: expect.stringContaining('nowhere') }])
  })

  it('replies done to load, goto and setJoints', async () => {
    const { host, sent, dispatcher } = setup()
    await dispatcher.handle_message({ origin: ORIGIN, data: { v: 1, id: 1, type: 'load', model: 'm.glb', template: 'human', step: 'animate' } })
    await dispatcher.handle_message({ origin: ORIGIN, data: { v: 1, id: 2, type: 'goto', step: 'edit' } })
    await dispatcher.handle_message({ origin: ORIGIN, data: { v: 1, id: 3, type: 'setJoints', joints: { hips: [0, 1, 0] } } })
    expect(host.load).toHaveBeenCalledWith({ type: 'load', model: 'm.glb', template: 'human', step: 'animate' })
    expect(host.goto).toHaveBeenCalledWith('edit')
    expect(host.set_joints).toHaveBeenCalledWith({ hips: [0, 1, 0] })
    expect(sent).toEqual([
      { v: 1, id: 1, type: 'done', request: 'load' },
      { v: 1, id: 2, type: 'done', request: 'goto' },
      { v: 1, id: 3, type: 'done', request: 'setJoints' }
    ])
  })

  it('replies with data to getJoints, selectClips and export', async () => {
    const { sent, dispatcher } = setup()
    await dispatcher.handle_message({ origin: ORIGIN, data: { v: 1, id: 'j', type: 'getJoints' } })
    await dispatcher.handle_message({ origin: ORIGIN, data: { v: 1, id: 'c', type: 'selectClips', names: ['Walk'] } })
    await dispatcher.handle_message({ origin: ORIGIN, data: { v: 1, id: 'e', type: 'export', format: 'glb' } })
    expect(sent[0]).toEqual({ v: 1, id: 'j', type: 'joints', template: 'human', joints: { hips: [0, 1, 0] } })
    expect(sent[1]).toEqual({ v: 1, id: 'c', type: 'clips', available: [{ name: 'Walk', duration: 1, rootMotion: false }], selected: ['Walk'] })
    expect(sent[2]).toMatchObject({ v: 1, id: 'e', type: 'exported', format: 'glb', filename: 'm.glb' })
    expect(sent[2].type === 'exported' && sent[2].blob).toBeInstanceOf(Blob)
  })

  it('turns a host failure into an error reply', async () => {
    const { sent, dispatcher } = setup({ goto: vi.fn(async () => { throw new Error('send load first') }) })
    await dispatcher.handle_message({ origin: ORIGIN, data: { v: 1, id: 5, type: 'goto', step: 'animate' } })
    expect(sent).toEqual([{ v: 1, id: 5, type: 'error', message: 'send load first' }])
  })

  it('runs requests one at a time, in arrival order', async () => {
    const order: string[] = []
    let finish_load: () => void = () => {}
    const { sent, dispatcher } = setup({
      load: vi.fn(async () => {
        order.push('load start')
        await new Promise<void>((resolve) => { finish_load = resolve })
        order.push('load end')
      }),
      get_joints: vi.fn(() => { order.push('getJoints'); return { template: 'fox', joints: {} } })
    })
    const first = dispatcher.handle_message({ origin: ORIGIN, data: { v: 1, id: 1, type: 'load', model: 'm.glb', template: 'fox' } })
    const second = dispatcher.handle_message({ origin: ORIGIN, data: { v: 1, id: 2, type: 'getJoints' } })
    await Promise.resolve()
    expect(order).toEqual(['load start'])
    finish_load()
    await Promise.all([first, second])
    expect(order).toEqual(['load start', 'load end', 'getJoints'])
    expect(sent.map(m => m.id)).toEqual([1, 2])
  })

  it('keeps going after a failed request', async () => {
    const { sent, dispatcher } = setup({ load: vi.fn(async () => { throw new Error('404') }) })
    await dispatcher.handle_message({ origin: ORIGIN, data: { v: 1, id: 1, type: 'load', model: 'm.glb', template: 'fox' } })
    await dispatcher.handle_message({ origin: ORIGIN, data: { v: 1, id: 2, type: 'getJoints' } })
    expect(sent.map(m => m.type)).toEqual(['error', 'joints'])
  })

  it('sends events without an id', () => {
    const { sent, dispatcher } = setup()
    dispatcher.send({ type: 'stepChanged', step: 'edit' })
    expect(sent).toEqual([{ v: 1, type: 'stepChanged', step: 'edit' }])
  })
})
