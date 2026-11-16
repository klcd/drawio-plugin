// Run with Electron, not Node. This verifies the real OS clipboard under the
// same permission denial used by Orca's isolated plugin sessions.
const assert = require('node:assert/strict')
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, clipboard, nativeImage, session } = require('electron')

if (process.platform === 'linux') app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})

const root=resolve(__dirname,'../..')
const editorRoot=join(root,'editor')
const template=readFileSync(join(root,'templates/empty.drawio'),'utf8')
const source=readFileSync(join(editorRoot,'index.html'),'utf8')
const absoluteSource=source.replace(/\b(src|href)="([^"]+)"/g,(_all,attribute,path)=>
  `${attribute}="${pathToFileURL(join(editorRoot,path)).href}"`)
const prelude=`<script>
window.current={version:1,readOnly:false,content:{kind:'text',text:${JSON.stringify(template)}}};
window.orca={document:{onDidChange(fn){window.receive=fn;fn(current)},async applyEdit(edit){current={...current,version:current.version+1,content:edit.content};receive(current)}},on(){}};
</script>`
const delay=milliseconds=>new Promise(resolveDelay=>setTimeout(resolveDelay,milliseconds))

app.whenReady().then(async()=>{
  const temporary=mkdtempSync(join(tmpdir(),'drawio-clipboard-electron-'))
  const harness=join(temporary,'index.html')
  writeFileSync(harness,prelude+absoluteSource)
  const partition='drawio-clipboard-electron-'+process.pid
  const isolated=session.fromPartition(partition)
  isolated.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false))
  isolated.setPermissionCheckHandler(()=>false)
  const sourceWindow=new BrowserWindow({show:false,webPreferences:{partition,sandbox:true,contextIsolation:true}})
  const pasteWindow=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}})
  const saved={text:clipboard.readText(),html:clipboard.readHTML(),image:clipboard.readImage()}
  try {
    await sourceWindow.loadFile(harness)
    await sourceWindow.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const started=Date.now();const check=()=>document.getElementById('message')?.hidden?resolve():Date.now()-started>30000?reject(Error('editor timeout')):setTimeout(check,20);check()})`)
    const capabilities=await sourceWindow.webContents.executeJavaScript(`(async()=>({clipboard:typeof navigator.clipboard?.write==='function',clipboardItem:typeof ClipboardItem==='function',writeDenied:await navigator.clipboard.writeText('must-not-write').then(()=>false,()=>true)}))()`)
    assert.deepEqual(capabilities,{clipboard:true,clipboardItem:true,writeDenied:true})
    await sourceWindow.webContents.executeJavaScript(`{const graph=drawioUi.editor.graph;graph.setSelectionCell(graph.insertVertex(graph.getDefaultParent(),'copy-me','Copy me',20,20,100,40));}`)
    const copy=async action=>{
      clipboard.clear()
      await sourceWindow.webContents.executeJavaScript(`drawioUi.actions.get(${JSON.stringify(action)}).funct()`,true)
      await delay(500)
      const payload={formats:clipboard.availableFormats(),html:clipboard.readHTML(),text:clipboard.readText(),image:clipboard.readImage().getSize()}
      await pasteWindow.loadURL('data:text/html,<body contenteditable="true"></body>')
      pasteWindow.showInactive()
      pasteWindow.webContents.focus()
      await pasteWindow.webContents.executeJavaScript(`document.body.focus()`)
      pasteWindow.webContents.paste()
      await delay(100)
      payload.pasted=await pasteWindow.webContents.executeJavaScript(`document.body.innerHTML`)
      pasteWindow.hide()
      return payload
    }
    const svg=await copy('copyAsSvg')
    assert.match(svg.html,/^<img src="data:image\/svg\+xml/)
    assert.match(svg.text,/^<svg\b/)
    assert.match(svg.pasted,/<img src="data:image\/svg\+xml/)
    const png=await copy('copyAsImage')
    assert.match(png.html,/^<img src="data:image\/png/)
    assert.match(png.pasted,/<img src="data:image\/png/)
    const pngDataUrl=png.html.match(/src="([^"]+)"/)[1]
    const pngPixels=nativeImage.createFromDataURL(pngDataUrl).getSize()
    const declaredWidth=Number(png.html.match(/\bwidth="(\d+)"/)?.[1]||pngPixels.width)
    const declaredHeight=Number(png.html.match(/\bheight="(\d+)"/)?.[1]||pngPixels.height)
    assert.ok(declaredWidth>=pngPixels.width&&declaredHeight>=pngPixels.height,
      `clipboard downsizes ${pngPixels.width}x${pngPixels.height} PNG to ${declaredWidth}x${declaredHeight}`)
    console.log('PASS: real Electron clipboard and paste receive SVG and PNG image payloads')
    console.log(JSON.stringify({svgFormats:svg.formats,pngFormats:png.formats,pngNativeImage:png.image,pngPixels,declaredWidth,declaredHeight}))
  } finally {
    clipboard.write(saved.image.isEmpty()?{text:saved.text,html:saved.html}:saved)
    sourceWindow.destroy()
    pasteWindow.destroy()
    rmSync(temporary,{recursive:true,force:true})
  }
  app.quit()
}).catch(error=>{console.error(error);app.exit(1)})
