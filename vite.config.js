import { resolve } from 'path'
import { defineConfig } from 'vite'
import glsl from 'vite-plugin-glsl' // allows us to use external shaders files to be imported into our materials

const is_code_sandbox = 'SANDBOX_URL' in process.env || 'CODESANDBOX_HOST' in process.env

export default defineConfig({
  root: 'src/',
  publicDir: '../static/',
  base: './',
  define: {
    // only the two values src/environment.js reads: never the whole build environment
    PROCESS_ENV: JSON.stringify({
      WORKERS_CI_COMMIT_SHA: process.env.WORKERS_CI_COMMIT_SHA,
      WORKERS_CI_BRANCH: process.env.WORKERS_CI_BRANCH
    })
  },
  server:
    {
      host: true,
      open: !is_code_sandbox // Open window if it's not a CodeSandbox
    },
  build:
    {
      outDir: '../dist',
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'src/index.html'),
          create: resolve(__dirname, 'src/create.html'),
          retarget: resolve(__dirname, 'src/retarget/index.html')
        }
      }
    },
  plugins:
    [
      glsl()
    ]
})
