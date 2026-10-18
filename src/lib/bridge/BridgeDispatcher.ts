import {
  parse_request,
  type BridgeEvent, type BridgeOutgoing, type BridgeRequest, type BridgeTargetStep,
  type ClipInfo, type ExportFormatName, type ExportRequest, type JointMap, type LoadRequest
} from './BridgeProtocol.ts'

export interface JointsResult { template: string, joints: JointMap }
export interface ClipsResult { available: ClipInfo[], selected: string[], unknown?: string[] }
export interface ExportResult { format: ExportFormatName, filename: string, blob: Blob }

/** What the dispatcher needs from the app. EngineBridgeHost implements it on Mesh2MotionEngine. */
export interface BridgeHost {
  /** Resolves once the requested step is reached (for 'animate', once the clip list is loaded). */
  load: (request: LoadRequest) => Promise<void>
  goto: (step: BridgeTargetStep) => Promise<void>
  get_joints: () => JointsResult
  set_joints: (joints: JointMap) => Promise<void>
  select_clips: (names: string[]) => Promise<ClipsResult>
  export: (request: ExportRequest) => Promise<ExportResult>
}

export interface IncomingMessage { origin: string, data: unknown }

/**
 * Turns postMessage requests into BridgeHost calls, one at a time in arrival order.
 * Every request that carries an `id` gets exactly one reply with that id: its data
 * message (joints, clips, exported), `done` for requests with no data, or `error`.
 */
export class BridgeDispatcher {
  private queue: Promise<void> = Promise.resolve()

  constructor (
    private readonly host: BridgeHost,
    private readonly post: (message: BridgeOutgoing) => void,
    private readonly allowed_origin: string
  ) {}

  /** Send an event to the parent; `id` ties it to the request it answers. */
  public send (event: BridgeEvent, id?: string | number): void {
    const message = { v: 1, ...event } as BridgeOutgoing
    if (id !== undefined) message.id = id
    this.post(message)
  }

  /**
   * Handles one window 'message' event. Messages from another origin, and data that is not
   * a bridge message, are ignored. Resolves when this request has been answered.
   */
  public async handle_message (event: IncomingMessage): Promise<void> {
    if (event.origin !== this.allowed_origin) return
    const parsed = parse_request(event.data)
    if (parsed === null) return

    if (!parsed.ok) {
      this.send({ type: 'error', message: parsed.message }, parsed.id)
      return
    }

    const run = async (): Promise<void> => {
      try {
        await this.run_request(parsed.request, parsed.id)
      } catch (error: unknown) {
        this.send({ type: 'error', message: error_message(error) }, parsed.id)
      }
    }
    const result = this.queue.then(run)
    this.queue = result
    await result
  }

  private async run_request (request: BridgeRequest, id?: string | number): Promise<void> {
    switch (request.type) {
      case 'load':
        await this.host.load(request)
        this.send({ type: 'done', request: 'load' }, id)
        return
      case 'goto':
        await this.host.goto(request.step)
        this.send({ type: 'done', request: 'goto' }, id)
        return
      case 'getJoints':
        this.send({ type: 'joints', ...this.host.get_joints() }, id)
        return
      case 'setJoints':
        await this.host.set_joints(request.joints)
        this.send({ type: 'done', request: 'setJoints' }, id)
        return
      case 'selectClips':
        this.send({ type: 'clips', ...await this.host.select_clips(request.names) }, id)
        return
      case 'export':
        this.send({ type: 'exported', ...await this.host.export(request) }, id)
    }
  }
}

export function error_message (error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'unknown error'
}
