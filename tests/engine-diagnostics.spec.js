import { test, expect } from '@playwright/test'

test.describe('Hyperfy WebGL engine diagnostics', () => {
  test('creates a WebGL renderer and submits rendered frames', async ({ page }) => {
    const pageErrors = []
    const graphicsConsoleErrors = []

    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('console', message => {
      if (message.type() !== 'error') return
      const text = message.text()
      if (/webgl|shader|three\.js|context lost|context creation/i.test(text)) {
        graphicsConsoleErrors.push(text)
      }
    })

    // Instrument the browser's WebGL clear calls before Three.js creates its renderer.
    await page.addInitScript(() => {
      const diagnostics = {
        contexts: [],
        clearCalls: 0,
        contextLost: false,
      }
      window.__hyperfyGraphicsDiagnostics = diagnostics

      const instrument = prototype => {
        if (!prototype || typeof prototype.clear !== 'function') return
        const originalClear = prototype.clear
        prototype.clear = function (...args) {
          diagnostics.clearCalls += 1
          return originalClear.apply(this, args)
        }
      }

      instrument(window.WebGLRenderingContext?.prototype)
      instrument(window.WebGL2RenderingContext?.prototype)

      const originalGetContext = HTMLCanvasElement.prototype.getContext
      HTMLCanvasElement.prototype.getContext = function (type, ...args) {
        const context = originalGetContext.call(this, type, ...args)
        if (context && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
          if (!diagnostics.contexts.includes(type)) diagnostics.contexts.push(type)
          this.addEventListener('webglcontextlost', () => {
            diagnostics.contextLost = true
          })
        }
        return context
      }
    })

    await page.goto('http://127.0.0.1:3000', { waitUntil: 'domcontentloaded' })

    const canvas = page.locator('.App__viewport canvas')
    await expect(canvas).toHaveCount(1, { timeout: 20000 })
    await expect.poll(async () => canvas.evaluate(element => ({
      width: element.width,
      height: element.height,
      connected: element.isConnected,
    })), { timeout: 20000 }).toMatchObject({
      connected: true,
    })

    await expect.poll(
      () => page.evaluate(() => window.__hyperfyGraphicsDiagnostics?.contexts.length || 0),
      { message: 'Three.js should create a WebGL or WebGL2 context', timeout: 20000 }
    ).toBeGreaterThan(0)

    await expect.poll(
      () => page.evaluate(() => window.__hyperfyGraphicsDiagnostics?.clearCalls || 0),
      { message: 'The renderer should submit frame clears, not just create a canvas', timeout: 20000 }
    ).toBeGreaterThan(0)

    const state = await page.evaluate(() => {
      const canvas = document.querySelector('.App__viewport canvas')
      const gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl')
      return {
        width: canvas?.width || 0,
        height: canvas?.height || 0,
        drawingBufferWidth: gl?.drawingBufferWidth || 0,
        drawingBufferHeight: gl?.drawingBufferHeight || 0,
        clearCalls: window.__hyperfyGraphicsDiagnostics?.clearCalls || 0,
        contexts: window.__hyperfyGraphicsDiagnostics?.contexts || [],
        contextLost: window.__hyperfyGraphicsDiagnostics?.contextLost || false,
      }
    })

    console.log('Hyperfy WebGL diagnostics:', JSON.stringify(state))
    expect(state.width).toBeGreaterThan(0)
    expect(state.height).toBeGreaterThan(0)
    expect(state.drawingBufferWidth).toBeGreaterThan(0)
    expect(state.drawingBufferHeight).toBeGreaterThan(0)
    expect(state.clearCalls).toBeGreaterThan(0)
    expect(state.contextLost).toBe(false)
    expect(pageErrors, 'uncaught browser exceptions').toEqual([])
    expect(graphicsConsoleErrors, 'WebGL and shader console errors').toEqual([])
  })
})
