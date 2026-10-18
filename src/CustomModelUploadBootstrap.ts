import { Mesh2MotionEngine } from './Mesh2MotionEngine'
import { install_workbench_bridge } from './lib/bridge/WorkbenchBridge'

export class CustomModelUploadBootstrap {
  private readonly mesh2motion_engine: Mesh2MotionEngine

  constructor () {
    this.mesh2motion_engine = new Mesh2MotionEngine()

    // lets a parent page drive this one in an iframe (?embed=1 and postMessage)
    install_workbench_bridge(this.mesh2motion_engine)
  }
}

// instantiate the class to setup event listeners
const app = new CustomModelUploadBootstrap()
