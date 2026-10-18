import { type Mesh2MotionEngine } from '../../Mesh2MotionEngine.ts'
import { RigConfig } from '../RigConfig.ts'
import { parse_embed_params, template_name, type BridgeOutgoing } from './BridgeProtocol.ts'
import { BridgeDispatcher, error_message } from './BridgeDispatcher.ts'
import { EngineBridgeHost } from './EngineBridgeHost.ts'

/**
 * Embedding bridge: lets a page on the same origin drive create.html in an iframe.
 * Reads the URL parameters (?embed=1&model=&template=&skeleton=&step=), answers postMessage
 * requests and reports steps, joints, clips and exports to the parent window.
 * Protocol: docs/M2M-BRIDGE.md in https://github.com/sambena/autorig-workbench
 */
export function install_workbench_bridge (engine: Mesh2MotionEngine): BridgeDispatcher {
  const params = parse_embed_params(window.location.search)
  if (params.embed) document.documentElement.classList.add('m2m-embed')

  const parent = window.parent !== window ? window.parent : null
  const post = (message: BridgeOutgoing): void => {
    parent?.postMessage(message, window.location.origin)
  }

  // the dispatcher and the host report through each other, so the host's events go via this
  let dispatcher: BridgeDispatcher | null = null
  const host = new EngineBridgeHost(engine, (event) => { dispatcher?.send(event) }, params.embed)
  dispatcher = new BridgeDispatcher(host, post, window.location.origin)

  const bridge = dispatcher
  window.addEventListener('message', (event: MessageEvent) => {
    void bridge.handle_message(event)
  })

  bridge.send({ type: 'ready', templates: RigConfig.all.map(rig => template_name(rig.skeleton_type)) })
  params.errors.forEach((message) => { bridge.send({ type: 'error', message }) })

  // URL parameters: load straight away, the same as a load message with no id
  if (params.model !== null) {
    const model = params.model
    const start = params.template !== null
      ? host.load({
        type: 'load',
        model,
        template: params.template,
        ...(params.skeleton !== null ? { skeleton: params.skeleton } : {}),
        ...(params.step !== null ? { step: params.step } : {})
      })
      : host.load_model(model)
    start.catch((error: unknown) => { bridge.send({ type: 'error', message: error_message(error) }) })
  }

  return bridge
}
