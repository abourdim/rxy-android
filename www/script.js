window.__ovl = window.__ovl || { t:null };

// EARLY ZOOM VALIDATION - prevents tiny render on page load
(function() {
  try {
    // Check for reset parameter
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('reset_zoom') === '1' || urlParams.get('reset') === '1') {
      localStorage.removeItem('app_zoom');
    }
    
    // Validate saved zoom immediately
    const savedZoom = localStorage.getItem('app_zoom');
    if (savedZoom) {
      const z = parseFloat(savedZoom);
      if (isNaN(z) || z < 0.5 || z > 3) {
        console.warn('[Zoom] Invalid saved zoom detected on load:', savedZoom, '- removing');
        localStorage.removeItem('app_zoom');
      }
    }
  } catch(e) {}
})();

const UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_TX_CHAR = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const UART_RX_CHAR = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

// ========================================
// BLUETOOTH FLASHING (Partial Flashing Service)
// ========================================
const PFS_SERVICE = 'e97dd91d-251d-470a-a062-fa1922dfa9a8';
const PFS_CHAR = 'e97d3b10-251d-470a-a062-fa1922dfa9a8';

// Partial Flashing commands
const PFS_CMD = {
  REGION_INFO: 0x00,
  FLASH_DATA: 0x01,
  END_OF_TX: 0x02,
  STATUS: 0xEE,
  RESET: 0xFF
};

// Flash state
const flashState = {
  device: null,
  server: null,
  pfsChar: null,
  hexData: null,
  isFlashing: false,
  progress: 0,
  packetNum: 0,
  resolve: null,
  reject: null
};

// Update flash UI
function updateFlashUI(status, progress) {
  const statusEl = document.getElementById('flashStatus');
  const barEl = document.getElementById('flashBar');
  const progressEl = document.getElementById('flashProgress');
  const flashBtn = document.getElementById('flashBtn');
  
  if (status) {
    progressEl.style.display = 'block';
    statusEl.textContent = status;
  }
  if (progress !== undefined) {
    barEl.style.width = progress + '%';
  }
  if (flashBtn) {
    flashBtn.disabled = flashState.isFlashing;
    flashBtn.classList.toggle('flashing', flashState.isFlashing);
    flashBtn.textContent = flashState.isFlashing ? '⏳ Flashing...' : '⚡ Flash to micro:bit';
  }
}

// MakeCode compilation via iframe messaging
const MakeCodeCompiler = {
  iframe: null,
  pendingCompile: null,
  isReady: false,
  
  init() {
    this.iframe = document.getElementById('makecodeFrame');
    if (!this.iframe) return;
    
    // Listen for messages from MakeCode
    window.addEventListener('message', (e) => this.handleMessage(e));
  },
  
  handleMessage(e) {
    // Accept messages from MakeCode domains
    if (!e.origin.includes('makecode.microbit.org') && !e.origin.includes('makecode.com')) return;
    
    const data = e.data;
    if (!data || typeof data !== 'object') return;
    
    console.log('[MakeCode] Message:', data.type || data.action);
    
    if (data.type === 'pxthost') {
      if (data.action === 'workspacesync') {
        // MakeCode is ready
        this.isReady = true;
        console.log('[MakeCode] Editor ready');
      }
    }
    
    // Handle compiled hex response
    if (data.type === 'pxthost' && data.action === 'workspacesave') {
      if (this.pendingCompile && data.project && data.project.text) {
        // Find the hex file in the response
        const hexFile = Object.keys(data.project.text).find(k => k.endsWith('.hex'));
        if (hexFile) {
          this.pendingCompile.resolve(data.project.text[hexFile]);
          this.pendingCompile = null;
        }
      }
    }
  },
  
  // Compile TypeScript code to hex using MakeCode's compile endpoint
  async compile(tsCode) {
    updateFlashUI('Compiling code...', 5);
    
    // Use MakeCode's cloud compile API
    try {
      const response = await fetch('https://makecode.microbit.org/api/compile/v3', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            name: 'micro:bit Remote',
            dependencies: { bluetooth: '*', core: '*' },
            files: ['main.ts'],
            supportedTargets: ['microbit']
          },
          files: {
            'main.ts': tsCode
          }
        })
      });
      
      if (!response.ok) throw new Error('Compile request failed');
      
      const result = await response.json();
      if (result.hex) {
        return result.hex;
      } else if (result.hexurl) {
        // Fetch the hex from the URL
        const hexResponse = await fetch(result.hexurl);
        return await hexResponse.text();
      }
      throw new Error('No hex in compile response');
    } catch (err) {
      console.error('[MakeCode] Compile error:', err);
      throw err;
    }
  }
};

// Parse Intel HEX format
function parseIntelHex(hexString) {
  const lines = hexString.split('\n').filter(l => l.startsWith(':'));
  const data = [];
  let extendedAddr = 0;
  
  for (const line of lines) {
    const bytes = line.slice(1).match(/.{2}/g).map(h => parseInt(h, 16));
    const byteCount = bytes[0];
    const address = (bytes[1] << 8) | bytes[2];
    const recordType = bytes[3];
    const payload = bytes.slice(4, 4 + byteCount);
    
    if (recordType === 0x00) { // Data record
      const fullAddr = extendedAddr + address;
      for (let i = 0; i < payload.length; i++) {
        data.push({ addr: fullAddr + i, byte: payload[i] });
      }
    } else if (recordType === 0x02) { // Extended segment address
      extendedAddr = ((payload[0] << 8) | payload[1]) << 4;
    } else if (recordType === 0x04) { // Extended linear address
      extendedAddr = ((payload[0] << 8) | payload[1]) << 16;
    }
  }
  
  return data;
}

// Connect to micro:bit for flashing
async function connectForFlash() {
  updateFlashUI('Connecting to micro:bit...', 10);
  
  try {
    // Request device with Partial Flashing Service
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'BBC micro:bit' }],
      optionalServices: [PFS_SERVICE, UART_SERVICE]
    });
    
    flashState.device = device;
    device.addEventListener('gattserverdisconnected', onFlashDisconnect);
    
    updateFlashUI('Connecting to GATT...', 15);
    const server = await device.gatt.connect();
    flashState.server = server;
    
    updateFlashUI('Finding Partial Flash Service...', 20);
    
    try {
      const pfsService = await server.getPrimaryService(PFS_SERVICE);
      flashState.pfsChar = await pfsService.getCharacteristic(PFS_CHAR);
      
      // Enable notifications
      await flashState.pfsChar.startNotifications();
      flashState.pfsChar.addEventListener('characteristicvaluechanged', onPfsNotification);
      
      console.log('[Flash] Partial Flashing Service connected');
      return true;
    } catch (e) {
      console.warn('[Flash] PFS not available:', e.message);
      throw new Error('Partial Flashing Service not available. Please flash a MakeCode program to your micro:bit first via USB, then try again.');
    }
  } catch (err) {
    console.error('[Flash] Connection error:', err);
    throw err;
  }
}

function onFlashDisconnect() {
  console.log('[Flash] Disconnected');
  flashState.device = null;
  flashState.server = null;
  flashState.pfsChar = null;
  if (flashState.isFlashing) {
    flashState.isFlashing = false;
    updateFlashUI('Disconnected during flash', 0);
  }
}

function onPfsNotification(event) {
  const value = new Uint8Array(event.target.value.buffer);
  console.log('[Flash] PFS notification:', Array.from(value).map(b => b.toString(16).padStart(2, '0')).join(' '));
  
  // Handle flash acknowledgments
  if (flashState.resolve) {
    flashState.resolve(value);
  }
}

// Flash hex data to micro:bit
async function flashHexToDevice(hexString) {
  if (!flashState.pfsChar) {
    throw new Error('Not connected to Partial Flashing Service');
  }
  
  updateFlashUI('Parsing hex file...', 25);
  
  // Parse the hex file
  const hexData = parseIntelHex(hexString);
  if (hexData.length === 0) {
    throw new Error('Invalid or empty hex file');
  }
  
  console.log('[Flash] Hex parsed:', hexData.length, 'bytes');
  
  // Put micro:bit into flash mode
  updateFlashUI('Entering flash mode...', 30);
  await sendPfsCommand(PFS_CMD.RESET, [0x00]); // Reset to BLE mode
  await sleep(500);
  
  // Get region info
  updateFlashUI('Reading memory map...', 35);
  await sendPfsCommand(PFS_CMD.REGION_INFO, [0x00]);
  await sleep(100);
  
  // Start flashing
  updateFlashUI('Flashing...', 40);
  flashState.isFlashing = true;
  
  // Group data into 16-byte chunks (4 packets per block)
  const chunkSize = 16;
  const totalChunks = Math.ceil(hexData.length / chunkSize);
  let currentChunk = 0;
  
  for (let i = 0; i < hexData.length; i += chunkSize) {
    const chunk = hexData.slice(i, Math.min(i + chunkSize, hexData.length));
    const addr = chunk[0].addr;
    
    // Build flash packet: [0x01, packetNum, addr(4 bytes), data(16 bytes)]
    const packet = new Uint8Array(20);
    packet[0] = PFS_CMD.FLASH_DATA;
    packet[1] = flashState.packetNum % 4;
    packet[2] = (addr >> 0) & 0xFF;
    packet[3] = (addr >> 8) & 0xFF;
    
    for (let j = 0; j < chunk.length && j < 16; j++) {
      packet[4 + j] = chunk[j].byte;
    }
    
    try {
      await flashState.pfsChar.writeValueWithoutResponse(packet);
    } catch (e) {
      console.error('[Flash] Write error:', e);
    }
    
    flashState.packetNum++;
    currentChunk++;
    
    // Update progress every 4 packets (1 block)
    if (flashState.packetNum % 4 === 0) {
      const progress = 40 + Math.floor((currentChunk / totalChunks) * 50);
      updateFlashUI(`Flashing... ${Math.floor((currentChunk / totalChunks) * 100)}%`, progress);
      await sleep(5); // Small delay between blocks
    }
  }
  
  // End of transmission
  updateFlashUI('Finalizing...', 95);
  await sendPfsCommand(PFS_CMD.END_OF_TX, []);
  await sleep(100);
  
  // Reset to application mode
  await sendPfsCommand(PFS_CMD.RESET, [0x01]);
  
  flashState.isFlashing = false;
  updateFlashUI('Flash complete! ✓', 100);
}

async function sendPfsCommand(cmd, data) {
  if (!flashState.pfsChar) return;
  
  const packet = new Uint8Array(1 + data.length);
  packet[0] = cmd;
  for (let i = 0; i < data.length; i++) {
    packet[1 + i] = data[i];
  }
  
  await flashState.pfsChar.writeValueWithoutResponse(packet);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Main flash function
async function flashToMicrobit() {
  if (flashState.isFlashing) {
    toast('Flash already in progress', 'warning');
    return;
  }
  
  // Check Web Bluetooth support
  if (!navigator.bluetooth) {
    toast('Web Bluetooth not supported. Use Chrome or Edge on desktop/Android.', 'error');
    return;
  }
  
  const flashBtn = document.getElementById('flashBtn');
  const progressEl = document.getElementById('flashProgress');
  
  try {
    flashState.isFlashing = true;
    updateFlashUI('Starting...', 0);
    
    // Get the current code from the modal
    const code = document.getElementById('modalCode').textContent;
    if (!code) {
      throw new Error('No code to flash');
    }
    
    // Compile the code
    updateFlashUI('Compiling with MakeCode...', 5);
    
    // For now, we'll use a simplified approach - download the hex and let user flash via USB
    // Full BLE partial flashing requires the micro:bit to already have a compatible runtime
    
    // Try MakeCode compile API
    let hexString;
    try {
      hexString = await MakeCodeCompiler.compile(code);
      console.log('[Flash] Got hex:', hexString.length, 'bytes');
    } catch (compileErr) {
      console.error('[Flash] Compile failed:', compileErr);
      // Fallback: offer to open MakeCode
      toast('Could not compile. Opening MakeCode to compile manually...', 'warning');
      
      // Create a MakeCode share URL with the code
      const encoded = encodeURIComponent(code);
      window.open(`https://makecode.microbit.org/#pub:`, '_blank');
      
      flashState.isFlashing = false;
      updateFlashUI('', 0);
      progressEl.style.display = 'none';
      return;
    }
    
    // Connect and flash
    await connectForFlash();
    await flashHexToDevice(hexString);
    
    toast('✅ Flash complete!', 'success');
    beepSuccess && beepSuccess();
    
    // Close modal after success
    setTimeout(() => {
      document.getElementById('modalBg').classList.remove('show');
      progressEl.style.display = 'none';
    }, 2000);
    
  } catch (err) {
    console.error('[Flash] Error:', err);
    toast('Flash failed: ' + err.message, 'error');
    updateFlashUI('Error: ' + err.message, 0);
  } finally {
    flashState.isFlashing = false;
    updateFlashUI(null, undefined);
  }
}

// Alternative: Direct USB flashing via WebUSB
async function flashViaUSB() {
  if (!navigator.usb) {
    toast('WebUSB not supported. Use Chrome or Edge.', 'error');
    return;
  }
  
  try {
    updateFlashUI('Requesting USB device...', 5);
    
    const device = await navigator.usb.requestDevice({
      filters: [{ vendorId: 0x0D28 }] // ARM DAPLink
    });
    
    await device.open();
    await device.selectConfiguration(1);
    await device.claimInterface(0);
    
    // Get the code and compile
    const code = document.getElementById('modalCode').textContent;
    updateFlashUI('Compiling...', 10);
    
    const hexString = await MakeCodeCompiler.compile(code);
    
    // For WebUSB DAPLink flashing, we need the DAP.js library
    // This is complex, so for now we'll download the hex
    updateFlashUI('WebUSB flashing coming soon! Downloading hex instead...', 50);
    
    // Download the hex file
    const blob = new Blob([hexString], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'microbit-remote.hex';
    a.click();
    URL.revokeObjectURL(url);
    
    toast('Hex downloaded! Drag it to your micro:bit drive.', 'success');
    
  } catch (err) {
    console.error('[USB Flash] Error:', err);
    toast('USB flash error: ' + err.message, 'error');
  }
}

// Initialize MakeCode compiler
document.addEventListener('DOMContentLoaded', () => {
  MakeCodeCompiler.init();
});

// ========================================
// END BLUETOOTH FLASHING
// ========================================

const encoder = new TextEncoder();
const esc = s => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

// ---- Resizable canvas helper (builder) ----
function findCanvasDropzone(){
  return document.querySelector('.canvas-dropzone, .dropzone, .board-drop, .canvas-wrap, .canvas-container, .canvas-frame, .builder-canvas, .board, .canvas');
}

function makeCanvasResizable(){
  const dz = findCanvasDropzone();
  if (!dz) return;

  // Avoid double wrapping
  if (dz.closest('.resizable-wrap')) return;

  const wrap = document.createElement('div');
  wrap.className = 'resizable-wrap';

  // Restore saved size
  try{
    const saved = JSON.parse(localStorage.getItem('kid_canvas_size') || 'null');
    if (saved && saved.w && saved.h){
      wrap.style.width = Math.min(saved.w, window.innerWidth - 80) + 'px';
      wrap.style.height = Math.min(saved.h, window.innerHeight - 220) + 'px';
    }
  }catch(e){}

  // Insert wrapper in DOM
  const parent = dz.parentElement;
  parent.insertBefore(wrap, dz);
  wrap.appendChild(dz);

  // Ensure the dropzone stretches inside wrapper
  dz.style.width = '100%';
  dz.style.height = '100%';
  dz.style.maxWidth = 'none';
  dz.style.overflow = 'hidden';

  // Add resizer handles + size badge
  const handleXY = document.createElement('div');
  handleXY.className = 'canvas-resizer canvas-resizer-xy';
  const handleE = document.createElement('div');
  handleE.className = 'canvas-resizer canvas-resizer-e';
  const handleS = document.createElement('div');
  handleS.className = 'canvas-resizer canvas-resizer-s';
  const badge = document.createElement('div');
  badge.className = 'canvas-size-badge';
  badge.textContent = '';
  wrap.appendChild(badge);
  wrap.appendChild(handleE);
  wrap.appendChild(handleS);
  wrap.appendChild(handleXY);

  function updateBadge(){
    const r = wrap.getBoundingClientRect();
    badge.textContent = Math.round(r.width) + '×' + Math.round(r.height);
  }
  updateBadge();

  let dragging = false;
  let dragMode = 'xy';
  let startX=0, startY=0, startW=0, startH=0;

  const onMove = (e) => {
    if (!dragging) return;
    const clientX = (e.touches && e.touches[0]) ? e.touches[0].clientX : e.clientX;
    const clientY = (e.touches && e.touches[0]) ? e.touches[0].clientY : e.clientY;
    const dx = clientX - startX;
    const dy = clientY - startY;

    const minW = 320, minH = 320;
    const maxW = Math.max(360, window.innerWidth - 60);
    const maxH = Math.max(360, window.innerHeight - 180);

    let targetW = startW;
    let targetH = startH;
    if (dragMode === 'x') targetW = startW + dx;
    else if (dragMode === 'y') targetH = startH + dy;
    else { targetW = startW + dx; targetH = startH + dy; }

    const newW = Math.max(minW, Math.min(maxW, targetW));
    const newH = Math.max(minH, Math.min(maxH, targetH));
wrap.style.width = newW + 'px';
    wrap.style.height = newH + 'px';
    updateBadge();
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    try{
      const r = wrap.getBoundingClientRect();
      localStorage.setItem('kid_canvas_size', JSON.stringify({w: Math.round(r.width), h: Math.round(r.height)}));
    }catch(e){}
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('touchmove', onMove);
    window.removeEventListener('touchend', onUp);
  };

  const onDown = (mode, e) => {
    e.preventDefault();
    dragging = true;
    dragMode = mode || 'xy';
    const r = wrap.getBoundingClientRect();
    startW = r.width; startH = r.height;
    startX = (e.touches && e.touches[0]) ? e.touches[0].clientX : e.clientX;
    startY = (e.touches && e.touches[0]) ? e.touches[0].clientY : e.clientY;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = (mode==='x' ? 'ew-resize' : mode==='y' ? 'ns-resize' : 'nwse-resize');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, {passive:false});
    window.addEventListener('touchend', onUp);
  };

  const bindHandle = (el, mode) => {
    el.addEventListener('pointerdown', (e)=>onDown(mode,e), {passive:false});
    el.addEventListener('mousedown', (e)=>onDown(mode,e), {passive:false});
    el.addEventListener('touchstart', (e)=>onDown(mode,e), {passive:false});
  };

  bindHandle(handleXY, 'xy');
  bindHandle(handleE, 'x');
  bindHandle(handleS, 'y');

  // Update badge if window resized
  window.addEventListener('resize', ()=>updateBadge());
}


// ===============================
// Kid-friendly i18n + JSON templates
// ===============================
const I18N = {
  en: {
    build: "✏️ Build", play: "▶️ Play",
    chooseTpl: "🎨 Choose a Template!",
    pickTpl: "Pick one to start building your remote",
    templates: { gamepad:"Game Pad", robot:"Robot", mixer:"DJ Mixer", racing:"Race Car", lights:"Lights", blank:"Start Fresh" },
    buttons: { demo:"🎮 Try All Widgets!", export:"📦 Export", import:"📂 Import", code:"📄 Code" },
    hint: "👆 Tap a widget below, then tap the board to place it!",
    propsTitle: "🛠️ Widget Properties",
    propsEmpty: "Select a widget to edit it.",
    connect: "Tap to Connect!", connected: "Connected! 🎉",
    runtimeConnectText: "Connect your micro:bit!",
    runtimeConnectBtn: "🔗 Connect",
    toastExport: "📦 Exported JSON!",
    toastImport: "📂 Imported!",
    toastImportFail: "❌ Import failed"
  },
  fr: {
    build: "✏️ Construire", play: "▶️ Jouer",
    chooseTpl: "🎨 Choisis un modèle !",
    pickTpl: "Prends-en un pour commencer",
    templates: { gamepad:"Manette", robot:"Robot", mixer:"DJ Mixer", racing:"Course", lights:"Lumières", blank:"Nouveau" },
    buttons: { demo:"🎮 Démo widgets !", export:"📦 Export", import:"📂 Import", code:"📄 Code" },
    hint: "👆 Choisis un widget, puis tape sur le tableau pour le placer !",
    propsTitle: "🛠️ Propriétés",
    propsEmpty: "Sélectionne un widget pour l’éditer.",
    connect: "Connecter!", connected: "Connecté! 🎉",
    runtimeConnectText: "Connecte ton micro:bit !",
    runtimeConnectBtn: "🔗 Connecter",
    toastExport: "📦 JSON exporté !",
    toastImport: "📂 Importé !",
    toastImportFail: "❌ Import impossible"
  },
  ar: {
    build: "✏️ بناء", play: "▶️ تشغيل",
    chooseTpl: "🎨 اختر قالبًا!",
    pickTpl: "اختر واحدًا للبدء",
    templates: { gamepad:"ذراع تحكم", robot:"روبوت", mixer:"موسيقى", racing:"سباق", lights:"أضواء", blank:"ابدأ" },
    buttons: { demo:"🎮 عرض كل الأدوات!", export:"📦 تصدير", import:"📂 استيراد", code:"📄 الكود" },
    hint: "👆 اختر أداة، ثم اضغط على اللوحة لوضعها!",
    propsTitle: "🛠️ خصائص الأداة",
    propsEmpty: "اختر أداة لتعديلها.",
    connect: "اضغط للاتصال!", connected: "متصل! 🎉",
    runtimeConnectText: "اتصل بالـ micro:bit!",
    runtimeConnectBtn: "🔗 اتصال",
    toastExport: "📦 تم التصدير!",
    toastImport: "📂 تم الاستيراد!",
    toastImportFail: "❌ فشل الاستيراد"
  }
};

const LANGS = ["en","fr","ar"];
const LANG_ICON = { en:"🇬🇧", fr:"🇫🇷", ar:"🇩🇿" };
const LANG_NAME = { en:"English", fr:"Français", ar:"العربية" };

function saveLang() { try { localStorage.setItem("kid_lang", state.lang); } catch(e){} }
function loadLang() { try { return localStorage.getItem("kid_lang"); } catch(e){ return null; } }
function detectBrowserLang(){
  const n = String(navigator.language || "en").toLowerCase();
  if (n.startsWith("fr")) return "fr";
  if (n.startsWith("ar")) return "ar";
  return "en";
}

function setLang(lang){
  state.lang = LANGS.includes(lang) ? lang : "en";
  saveLang();
  const t = I18N[state.lang] || I18N.en;

  document.documentElement.lang = state.lang;
  const rtl = (state.lang === "ar");
  document.documentElement.dir = rtl ? "rtl" : "ltr";
  document.body.classList.toggle("rtl", rtl);

  // Tabs
  const tabs = $$(".tab");
  if (tabs[0]) tabs[0].textContent = t.build;
  if (tabs[1]) tabs[1].textContent = t.play;

  // Top buttons
  const langBtn = $("#langBtn");
  if (langBtn){
    const s = langBtn.querySelector("span:last-child");
    if (s) s.textContent = LANG_ICON[state.lang] || "🌍";
    langBtn.title = "Language: " + (LANG_NAME[state.lang] || state.lang);
  }

  const bleBtn = $("#bleBtn");
  if (bleBtn){
    const s = bleBtn.querySelector("span:last-child");
    if (s) s.textContent = (state.ble && state.ble.connected) ? t.connected : t.connect;
  }

  // Builder header buttons
  const demoBtn = $("#demoBtn"); if (demoBtn) demoBtn.textContent = t.buttons.demo;
  const exportBtn = $("#exportJsonBtn"); if (exportBtn) exportBtn.textContent = t.buttons.export;
  const importBtn = $("#importJsonBtn"); if (importBtn) importBtn.textContent = t.buttons.import;
  const codeBtn = $("#codeBtn"); if (codeBtn) codeBtn.textContent = t.buttons.code;

  // Hint
  const hint = document.querySelector(".canvas-hint");
  if (hint) hint.textContent = t.hint;

  // Props panel
  const pt = document.querySelector(".props-title"); if (pt) pt.textContent = t.propsTitle;
  const pe = $("#propsEmpty"); if (pe) pe.textContent = t.propsEmpty;

  // Template modal
  const tm = $("#templateModal");
  if (tm){
    const h2 = tm.querySelector("h2"); if (h2) h2.textContent = t.chooseTpl;
    const p = tm.querySelector("p"); if (p) p.textContent = t.pickTpl;
    tm.querySelectorAll(".template-card").forEach(card=>{
      const key = card.dataset.tpl;
      const nameEl = card.querySelector(".template-name");
      if (nameEl && t.templates[key]) nameEl.textContent = t.templates[key];
    });
  }

  // Runtime connect screen
  const ct = document.querySelector(".connect-text"); if (ct) ct.textContent = t.runtimeConnectText;
  const cb = $("#connectBtn"); if (cb) cb.textContent = t.runtimeConnectBtn;
}

function cycleLang(){
  const i = LANGS.indexOf(state.lang || "en");
  const next = LANGS[(i + 1) % LANGS.length];
  setLang(next);
  if (typeof toast === "function") toast((LANG_ICON[next]||"🌍") + " " + (LANG_NAME[next]||next), "success");
}

// ---- Export / Import JSON layout ----
function exportLayoutJson(){
  const t = I18N[state.lang] || I18N.en;
  if (!state.widgets || state.widgets.length === 0){
    if (typeof toast === "function") toast("👆 Add some widgets first!", "error");
    return;
  }
  const title = ($("#titleInput") && $("#titleInput").value) ? $("#titleInput").value : "My Remote";
  const cfg = { schemaVersion: 1, title: title, widgets: state.widgets };

  const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const safe = String(title).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"");
  a.download = (safe || "my-remote") + ".json";
  a.click();

  if (typeof toast === "function") toast(t.toastExport, "success");
}

function importLayoutJsonFile(file){
  const t = I18N[state.lang] || I18N.en;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const cfg = JSON.parse(String(reader.result || "{}"));
      if (!cfg || !Array.isArray(cfg.widgets)) throw new Error("Bad format");
      state.widgets = cfg.widgets.map(w => ({...w}));
      // Recompute nextId safely
      let maxNum = 0;
      state.widgets.forEach(w=>{
        const m = String(w.id||"").match(/(\d+)$/);
        if (m) maxNum = Math.max(maxNum, parseInt(m[1],10));
      });
      state.nextId = Math.max(10, maxNum + 1);
      if ($("#titleInput")) $("#titleInput").value = cfg.title || "My Remote";
      if (typeof applyWidgetDefaults === "function") state.widgets.forEach(applyWidgetDefaults);
      state.selected = null;
      if (typeof renderWidgets === "function") renderWidgets();
      try{ ensureCanvasToolbar(); }catch(e){}
try{ placeToolbarWhereHintWas(); }catch(e){}
  try{ updateToolbarForMode('builder'); }catch(e){}
try{ placeToolbarWhereHintWas(); }catch(e){}
try{ moveBuildPlayNameTopRight(); }catch(e){}
makeCanvasResizable();
if (typeof renderPropsPanel === "function") renderPropsPanel();
      if (typeof toast === "function") toast(t.toastImport, "success");
    } catch(e){
      console.error(e);
      if (typeof toast === "function") toast(t.toastImportFail, "error");
    }
  };
  reader.readAsText(file);
}


const ICONS = { button:'👆', slider:'🎚️', toggle:'🔘', joystick:'🕹️', led:'💡', label:'🏷️', graph:'📈', gauge:'🧭', dpad:'✛', xypad:'📍', battery:'🔋', timer:'⏱️', image:'🖼️' };
const SIZES = { button:[100,100], slider:[90,180], toggle:[100,100], joystick:[140,140], led:[80,80], label:[200,50], graph:[300,150], gauge:[140,160], dpad:[140,140], xypad:[150,150], battery:[80,100], timer:[120,80], image:[100,100] };

// Themes
const THEMES = {
  dark: { bg:'#1a1a2e', surface:'#16213e', card:'#1f3460', accent:'#00d4ff', text:'#ffffff' },
  light: { bg:'#f0f4f8', surface:'#ffffff', card:'#e2e8f0', accent:'#3b82f6', text:'#1e293b' },
  neon: { bg:'#0a0a0a', surface:'#1a1a1a', card:'#2a2a2a', accent:'#ff00ff', text:'#00ffff' },
  nature: { bg:'#1a2f1a', surface:'#2d4a2d', card:'#3d5a3d', accent:'#4ade80', text:'#ecfdf5' },
  sunset: { bg:'#2d1b2d', surface:'#4a2c4a', card:'#6b3a6b', accent:'#f97316', text:'#fef3c7' }
};

const templates = {
  gamepad: [
    { t:'joystick', x:20, y:30, w:120, h:120, label:'Move' },
    { t:'button', x:180, y:40, w:90, h:90, label:'Jump' },
    { t:'button', x:290, y:40, w:90, h:90, label:'Fire' },
    { t:'toggle', x:180, y:160, w:90, h:90, label:'Turbo' }
  ],
  robot: [
    { t:'slider', x:20, y:20, w:90, h:180, label:'Arm 1' },
    { t:'slider', x:130, y:20, w:90, h:180, label:'Arm 2' },
    { t:'slider', x:240, y:20, w:90, h:180, label:'Arm 3' },
    { t:'toggle', x:350, y:80, w:90, h:90, label:'Grip' }
  ],
  mixer: [
    { t:'slider', x:20, y:20, w:80, h:200, label:'Bass' },
    { t:'slider', x:120, y:20, w:80, h:200, label:'Mid' },
    { t:'slider', x:220, y:20, w:80, h:200, label:'High' },
    { t:'toggle', x:320, y:80, w:90, h:90, label:'FX' },
    { t:'led', x:320, y:20, w:90, h:50, label:'Beat' }
  ],
  racing: [
    { t:'joystick', x:150, y:20, w:130, h:130, label:'Steer' },
    { t:'slider', x:20, y:170, w:80, h:140, label:'Gas' },
    { t:'slider', x:330, y:170, w:80, h:140, label:'Brake' },
    { t:'button', x:150, y:180, w:130, h:80, label:'Nitro!' }
  ],
  lights: [
    { t:'toggle', x:30, y:30, w:100, h:100, label:'Red' },
    { t:'toggle', x:160, y:30, w:100, h:100, label:'Green' },
    { t:'toggle', x:290, y:30, w:100, h:100, label:'Blue' },
    { t:'led', x:90, y:160, w:100, h:100, label:'Status' },
    { t:'led', x:230, y:160, w:100, h:100, label:'Alert' }
  ],
  blank: []
};

const state = {
  widgets: [], selected: null, nextId: 1, selectedType: null,
  ble: { device:null, server:null, service:null, notifyChar:null, writeChar:null, connected:false },
  config: null, values: {}, rxBuffer: '',
  justDragged: false, _dragT: null,
  // New features
  multiSelect: [], clipboard: [], undoStack: [], maxUndo: 50, redoStack: [],
  zoom: 1, gridSnap: true, gridSize: 20, showGuides: true,
  // More features
  theme: 'dark',
  groups: {}, // groupId -> [widgetIds]
  widgetTemplates: [], // saved widget groups
  showLayers: false,
  showRuler: false,
  livePreview: true,
  canvasBg: null, // background image
  history: [], // visual history
  arrangeMode: false // runtime arrange mode
};
state._allowLoadingOverlay = false;

// === AUTO-SAVE / LOAD PROJECT ===
const PROJECT_STORAGE_KEY = 'microbit_remote_project';

function saveProject() {
  try {
    const titleEl = document.querySelector('#titleInput');
    const projectData = {
      widgets: state.widgets,
      nextId: state.nextId,
      title: titleEl ? titleEl.value : '',
      canvasBg: state.canvasBg,
      theme: state.theme,
      savedAt: Date.now()
    };
    localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(projectData));
  } catch (e) {
    console.warn('Failed to save project:', e);
  }
}

function loadSavedProject() {
  try {
    const saved = localStorage.getItem(PROJECT_STORAGE_KEY);
    if (!saved) return false;
    
    const projectData = JSON.parse(saved);
    if (!projectData.widgets || projectData.widgets.length === 0) return false;
    
    // Restore state
    state.widgets = projectData.widgets.map(w => {
      if (typeof applyWidgetDefaults === 'function') return applyWidgetDefaults({...w});
      return {...w};
    });
    state.nextId = projectData.nextId || (state.widgets.length + 1);
    state.canvasBg = projectData.canvasBg || null;
    if (projectData.theme) state.theme = projectData.theme;
    
    // Restore title after DOM is ready
    setTimeout(() => {
      const titleEl = document.querySelector('#titleInput');
      if (titleEl && projectData.title) titleEl.value = projectData.title;
      
      // Apply canvas background if saved
      if (state.canvasBg) {
        const canvas = document.querySelector('#canvas');
        if (canvas) {
          canvas.style.backgroundImage = `url(${state.canvasBg})`;
          canvas.style.backgroundSize = 'cover';
          canvas.style.backgroundPosition = 'center';
        }
      }
    }, 50);
    
    return true;
  } catch (e) {
    console.warn('Failed to load project:', e);
    return false;
  }
}

function clearSavedProject() {
  try {
    localStorage.removeItem(PROJECT_STORAGE_KEY);
  } catch (e) {}
}

// Auto-save with debounce
let _autoSaveTimer = null;
function scheduleAutoSave() {
  if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(() => {
    saveProject();
  }, 500);
}

// ---- Kid-friendly sound engine (WebAudio) ----
state.soundOn = true;
state._audio = { ctx: null, unlocked: false };
state._gaugeLast = state._gaugeLast || {};

function ensureAudio() {
  if (!state.soundOn) return null;
  if (state._audio.ctx) return state._audio.ctx;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    state._audio.ctx = new Ctx();
    return state._audio.ctx;
  } catch (e) { return null; }
}

function unlockAudioOnce() {
  const ctx = ensureAudio();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(()=>{});
  state._audio.unlocked = true;
}

document.addEventListener('pointerdown', () => unlockAudioOnce(), { once: true });

function beep(freq=880, dur=0.06, vol=0.05, type='sine') {
  if (!state.soundOn) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(()=>{});
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.value = vol;
  o.connect(g); g.connect(ctx.destination);
  const t = ctx.currentTime;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.start(t);
  o.stop(t + dur + 0.02);
}
// Sound patterns
function beepClick(){ beep(880, 0.05, 0.05, 'sine'); }
function beepToggle(on){ beep(on?1046:659, 0.06, 0.05, 'square'); }
function beepWarn(){ beep(523, 0.09, 0.06, 'triangle'); setTimeout(()=>beep(659,0.09,0.05,'triangle'), 110); }
function beepDanger(){ beep(330, 0.10, 0.07, 'sawtooth'); setTimeout(()=>beep(330,0.10,0.07,'sawtooth'), 130); }
function beepSuccess(){ beep(523, 0.08, 0.05, 'sine'); setTimeout(()=>beep(659,0.08,0.05,'sine'), 100); setTimeout(()=>beep(784,0.12,0.05,'sine'), 200); }

// Sound UI
function updateSoundUI(){
  const b = $('#soundBtn');
  if (!b) return;
  b.classList.toggle('connected', state.soundOn);
  b.querySelector('span:last-child').textContent = state.soundOn ? 'Sound On' : 'Sound Off';
  b.style.opacity = state.soundOn ? '1' : '0.7';
}



// Ensure older configs/templates still look good when new properties are added
function applyWidgetDefaults(w){
  if (!w || !w.t) return w;

  // Default models (3 per widget type)
  if (!w.model){
    if (w.t === 'button') w.model = 'neo';
    if (w.t === 'slider') w.model = 'track';
    if (w.t === 'toggle') w.model = 'square';
    if (w.t === 'led') w.model = 'dot';
    if (w.t === 'joystick') w.model = 'classic';
    if (w.t === 'label') w.model = 'plain';
    if (w.t === 'gauge') w.model = 'classic';
    if (w.t === 'graph') w.model = 'grid';
  }

  // Existing per-type defaults
  if (w.t === 'led'){
    if (!w.colorOn) w.colorOn = '#ff5252';
    if (!w.colorOff) w.colorOff = '#2a2a3a';
  }
  if (w.t === 'slider'){
    if (w.min == null) w.min = 0;
    if (w.max == null) w.max = 100;
    if (w.step == null) w.step = 1;
  }

  // Gauge defaults
  if (w.t === 'gauge'){
    if (w.min == null) w.min = 0;
    if (w.max == null) w.max = 100;
    if (w.decimals == null) w.decimals = 1;
    if (w.units == null) w.units = '';
    if (w.warn == null) w.warn = null;   // optional threshold
    if (w.danger == null) w.danger = null;
  }

  // Graph defaults (comma-separated multi-series values: "23.4,2.1")
  if (w.t === 'graph'){
    if (w.series == null) w.series = 1;      // 1..10
    if (w.windowSec == null) w.windowSec = 30; // visible time window
    if (w.autoScale == null) w.autoScale = true;
    if (w.min == null) w.min = 0;
    if (w.max == null) w.max = 100;
    if (w.showLegend == null) w.showLegend = true;
  }

  return w;
}

function modelOptionsForType(t){
  switch(t){
    case 'button': return [
      { v:'neo',   name:'Neo (gradient)' },
      { v:'flat',  name:'Flat' },
      { v:'glass', name:'Glass' }
    ];
    case 'slider': return [
      { v:'track', name:'Track' },
      { v:'neon',  name:'Neon' },
      { v:'min',   name:'Minimal' }
    ];
    case 'toggle': return [
      { v:'square', name:'Square' },
      { v:'pill',   name:'Pill' },
      { v:'icon',   name:'Icon' }
    ];
    case 'led': return [
      { v:'dot',  name:'Dot' },
      { v:'bar',  name:'Bar' },
      { v:'ring', name:'Ring' }
    ];
    case 'joystick': return [
      { v:'classic', name:'Classic' },
      { v:'neon',    name:'Neon' },
      { v:'min',     name:'Minimal' }
    ];
    case 'label': return [
      { v:'plain', name:'Plain' },
      { v:'card',  name:'Card' },
      { v:'glow',  name:'Glow' }
    ];
    case 'gauge': return [
      { v:'classic', name:'Classic' },
      { v:'neon',    name:'Neon' },
      { v:'min',     name:'Minimal' }
    ];
    case 'graph': return [
      { v:'grid',    name:'Grid' },
      { v:'dark',    name:'Dark' },
      { v:'min',     name:'Minimal' }
    ];
    default: return null;
  }
}

// BLE Write Queue - ensures only ONE GATT operation at a time
// This prevents "GATT operation failed" errors from concurrent writes
const bleSend = {
  isWriting: false,     // Lock: true while a write is in progress
  pendingMsg: null,     // Latest message waiting to be sent (replaces previous)
  minInterval: 200,     // Minimum ms between writes for BLE stability
  lastSendTime: 0,      // Timestamp of last successful send
  retryCount: 0,        // Track consecutive failures
  maxRetries: 3         // Max retries before giving up on a message
};

// The actual low-level BLE write - MUST be awaited and serialized
async function bleWrite(msg) {
  if (!state.ble.writeChar || !state.ble.device?.gatt?.connected) {
    console.log('[BLE] Not connected, skipping:', msg);
    return false;
  }
  
  try {
    const data = encoder.encode(msg + '\n');
    
    // Use writeValueWithoutResponse (faster, but still must be serialized!)
    if (state.ble.writeChar.writeValueWithoutResponse) {
      await state.ble.writeChar.writeValueWithoutResponse(data);
    } else {
      await state.ble.writeChar.writeValue(data);
    }
    
    console.log('[BLE] Sent:', msg);
    bleSend.retryCount = 0; // Reset on success
    return true;
  } catch (err) {
    console.error('[BLE] Write failed:', err.message);
    
    // Check if it's a disconnect error
    if (err.message?.includes('disconnected') || err.message?.includes('GATT Server')) {
      onDisconnect();
      return false;
    }
    
    // For GATT operation errors, we can retry
    bleSend.retryCount++;
    if (bleSend.retryCount >= bleSend.maxRetries) {
      console.warn('[BLE] Max retries reached, dropping message');
      bleSend.retryCount = 0;
    }
    return false;
  }
}

// Process the write queue - ensures serialized GATT operations
async function processWriteQueue() {
  // If already writing, exit - the current write will pick up pending
  if (bleSend.isWriting) return;
  
  // Nothing to send
  if (!bleSend.pendingMsg) return;
  
  // Check minimum interval
  const now = Date.now();
  const timeSinceLastSend = now - bleSend.lastSendTime;
  if (timeSinceLastSend < bleSend.minInterval) {
    // Schedule next attempt
    setTimeout(processWriteQueue, bleSend.minInterval - timeSinceLastSend + 5);
    return;
  }
  
  // Lock, grab message, clear pending
  bleSend.isWriting = true;
  const msg = bleSend.pendingMsg;
  bleSend.pendingMsg = null;
  
  try {
    const success = await bleWrite(msg);
    if (success) {
      bleSend.lastSendTime = Date.now();
    }
  } finally {
    // Always unlock
    bleSend.isWriting = false;
    
    // If new message arrived while we were writing, process it
    if (bleSend.pendingMsg) {
      // Small delay to respect minimum interval
      setTimeout(processWriteQueue, bleSend.minInterval);
    }
  }
}

// Public send function - queues message and triggers processing
function send(msg) {
  if (!state.ble.connected) return;
  
  // Sanitize
  msg = String(msg || '').replace(/[\r\n]+/g, '').trim();
  if (!msg) return;
  
  // Always update pending (latest value wins for continuous controls like joystick)
  bleSend.pendingMsg = msg;
  
  // Trigger queue processing (will respect lock and interval)
  processWriteQueue();
}

// One-click Demo - creates full showcase with ALL widgets
function showDemo() {
  // Create a demo with ALL 12 widget types - complete showcase!
  state.widgets = [
    // Row 1: Buttons + Sliders
    { id: 'btn_jump', t: 'button', x: 20, y: 20, w: 100, h: 100, label: 'Jump!', model:'neo' },
    { id: 'btn_fire', t: 'button', x: 140, y: 20, w: 100, h: 100, label: 'Fire!', model:'glass' },
    { id: 'slider_speed', t: 'slider', x: 260, y: 20, w: 80, h: 160, label: 'Speed', model:'track', min:0, max:100, step:1 },
    { id: 'slider_power', t: 'slider', x: 360, y: 20, w: 80, h: 160, label: 'Power', model:'neon', min:0, max:100, step:1 },
    
    // Row 2: Toggles + LEDs
    { id: 'toggle_turbo', t: 'toggle', x: 20, y: 140, w: 100, h: 80, label: 'Turbo', model:'pill' },
    { id: 'toggle_shield', t: 'toggle', x: 140, y: 140, w: 100, h: 80, label: 'Shield', model:'icon' },
    { id: 'led_status', t: 'led', x: 260, y: 200, w: 70, h: 70, label: 'Status', model:'dot', colorOn:'#00e676', colorOff:'#1b2a3a' },
    { id: 'led_alert', t: 'led', x: 350, y: 200, w: 70, h: 70, label: 'Alert', model:'ring', colorOn:'#ff5252', colorOff:'#1b2a3a' },
    
    // Row 3: Joystick + D-Pad side by side
    { id: 'joy_move', t: 'joystick', x: 20, y: 240, w: 140, h: 140, label: 'Move', model:'ring' },
    { id: 'dpad_nav', t: 'dpad', x: 180, y: 240, w: 140, h: 140, label: 'Navigate', model:'classic' },
    
    // Row 3: Label
    { id: 'label_score', t: 'label', x: 340, y: 290, w: 180, h: 50, label: 'Score: 0', model:'chip' },
    
    // Row 4: XY Pad + Battery + Timer
    { id: 'xypad_aim', t: 'xypad', x: 20, y: 400, w: 140, h: 140, label: 'Aim', model:'grid' },
    { id: 'battery_level', t: 'battery', x: 180, y: 400, w: 70, h: 100, label: 'Power', model:'vertical' },
    { id: 'timer_game', t: 'timer', x: 270, y: 400, w: 120, h: 70, label: 'Game Time', model:'digital', autoStart: false },

    // Row 5: Gauges
    { id: 'gauge_temp', t: 'gauge', x: 20, y: 560, w: 140, h: 160, label: 'Temp', min: 0, max: 50, units: '°C', decimals: 1, model:'classic' },
    { id: 'gauge_level', t: 'gauge', x: 180, y: 560, w: 140, h: 160, label: 'Level', min: 0, max: 100, units: '%', decimals: 0, model:'neon' },
    
    // Row 6: Graph
    { id: 'graph_env', t: 'graph', x: 20, y: 740, w: 420, h: 150, label: 'Live Data', series: 2, windowSec: 30, autoScale: true, model:'grid' }
  ];
  state.widgets = state.widgets.map(applyWidgetDefaults);
  state.nextId = 30;
  state.selected = null;
  $('#titleInput').value = 'Super Demo Remote';
  renderWidgets();
  // Reflow demo widgets to whatever canvas size we actually have so nothing
  // bleeds off-screen on narrow viewports
  try { autoArrangeWidgets(); } catch (e) {}
  renderPropsPanel();
  
  // Show the code modal with demo code
  const cfg = { title: 'Super Demo Remote', widgets: state.widgets };
  // Load demo into runtime immediately (no micro:bit required)
  state.config = cfg;
  state.values = state.values || {};
  renderRuntime();
  startDemoSim();
  
  // Show arrange button in demo mode
  const arrangeBtn = $('#arrangeModeBtn');
  if (arrangeBtn) arrangeBtn.classList.add('visible');
  
  // Show fullscreen button in demo mode
  const fullscreenBtn = $('#fullscreenBtn');
  if (fullscreenBtn) fullscreenBtn.classList.add('visible');
  
  // Show runtime content
  $('#connectPrompt').style.display = 'none';
  $('#runtimeContent').style.display = 'flex';
  
  $('#modalTitle').textContent = 'Demo Ready! Copy this code to MakeCode:';
  $('#modalCode').textContent = generateDemoCode(cfg);
  $('#modalBg').classList.add('show');
  
  toast('Demo loaded with ALL 12 widgets!', 'success');
}

function generateDemoCode(cfg) {
  // Unicode-safe base64 encoding (handles emojis!)
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(cfg))));
  
  // Group widgets by type
  const buttons = cfg.widgets.filter(w => w.t === 'button');
  const sliders = cfg.widgets.filter(w => w.t === 'slider');
  const toggles = cfg.widgets.filter(w => w.t === 'toggle');
  const joysticks = cfg.widgets.filter(w => w.t === 'joystick');
  const dpads = cfg.widgets.filter(w => w.t === 'dpad');
  const xypads = cfg.widgets.filter(w => w.t === 'xypad');
  const timers = cfg.widgets.filter(w => w.t === 'timer');
  const leds = cfg.widgets.filter(w => w.t === 'led');
  const labels = cfg.widgets.filter(w => w.t === 'label');
  const gauges = cfg.widgets.filter(w => w.t === 'gauge');
  const graphs = cfg.widgets.filter(w => w.t === 'graph');
  const batteries = cfg.widgets.filter(w => w.t === 'battery');
  
  // Generate handler code for each widget
  let buttonCode = buttons.map(w => `    // Button: ${w.label || w.id}
    if (id == "${w.id}" && val == "1") {
        basic.showIcon(IconNames.Heart)
        // Add your code here!
    }`).join('\n');
  
  let sliderCode = sliders.map(w => `    // Slider: ${w.label || w.id} (val = 0-100)
    if (id == "${w.id}") {
        let value = parseInt(val)
        led.plotBarGraph(value, 100)
        // Use value for motors, sounds, etc!
    }`).join('\n');
  
  let toggleCode = toggles.map(w => `    // Toggle: ${w.label || w.id} (val = "1" or "0")
    if (id == "${w.id}") {
        if (val == "1") {
            basic.showIcon(IconNames.Yes)
        } else {
            basic.showIcon(IconNames.No)
        }
    }`).join('\n');
  
  let joystickCode = joysticks.map(w => `    // Joystick: ${w.label || w.id} (val = "angle distance", angle 0-360, distance 0-100)
    if (id == "${w.id}") {
        let parts = val.split(" ")
        let angle = parseInt(parts[0])  // 0-360 degrees (0=right, 90=down, 180=left, 270=up)
        let dist = parseInt(parts[1])   // 0-100 (0=center, 100=edge)
        // Use for steering, movement, etc!
        if (dist > 10) {
            if (angle < 45 || angle >= 315) basic.showArrow(ArrowNames.East)
            else if (angle < 135) basic.showArrow(ArrowNames.South)
            else if (angle < 225) basic.showArrow(ArrowNames.West)
            else basic.showArrow(ArrowNames.North)
        } else {
            basic.showIcon(IconNames.SmallDiamond)
        }
    }`).join('\n');

  let dpadCode = dpads.map(w => `    // D-Pad: ${w.label || w.id} (val = "direction state", direction: up/down/left/right, state: 1=pressed, 0=released)
    if (id == "${w.id}") {
        let parts = val.split(" ")
        let dir = parts[0]
        let pressed = parts[1] == "1"
        serial.writeLine("DPAD dir=[" + dir + "] pressed=" + pressed)
        if (pressed) {
            basic.clearScreen()
            if (dir == "up") {
                basic.showArrow(ArrowNames.North)
            } else if (dir == "down") {
                basic.showArrow(ArrowNames.South)
            } else if (dir == "left") {
                basic.showArrow(ArrowNames.West)
            } else if (dir == "right") {
                basic.showArrow(ArrowNames.East)
            } else {
                serial.writeLine("DPAD unknown dir: [" + dir + "]")
                basic.showString(dir.charAt(0))
            }
        } else {
            basic.clearScreen()
        }
    }`).join('\n');

  let xypadCode = xypads.map(w => `    // XY Pad: ${w.label || w.id} (val = "x y", both 0-100)
    if (id == "${w.id}") {
        let parts = val.split(" ")
        let x = parseInt(parts[0])  // 0-100 (0=left, 100=right)
        let y = parseInt(parts[1])  // 0-100 (0=top, 100=bottom)
        // Plot position on LED matrix
        led.plot(Math.floor(x / 25), Math.floor(y / 25))
        basic.pause(100)
        basic.clearScreen()
    }`).join('\n');

  let timerCode = timers.map(w => `    // Timer: ${w.label || w.id} (val = seconds elapsed)
    if (id == "${w.id}") {
        let secs = parseInt(val)
        // Do something with timer value
        serial.writeLine("Timer: " + secs + "s")
    }`).join('\n');

  let ledList = leds.map(w => `//   sendValue("${w.id}", "1")  // Turn ON ${w.label || 'LED'}
//   sendValue("${w.id}", "0")  // Turn OFF`).join('\n');

  let labelList = labels.map(w => `//   sendValue("${w.id}", "Hello!")  // Update ${w.label || 'label'}`).join('\n');

  // Calculate stats
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const cfgSize = b64.length;
  const nbChunks = Math.ceil(cfgSize / 18);
  const totalWidgets = cfg.widgets.length;
  
  // Count widget types
  const inputWidgets = buttons.length + sliders.length + toggles.length + joysticks.length + dpads.length + xypads.length;
  const outputWidgets = leds.length + labels.length + gauges.length + graphs.length + batteries.length;

  // Build header
  const header = `/**
 * ╔════════════════════════════════════════════════════════════════╗
 * ║                    🎮 MICRO:BIT REMOTE 🎮                      ║
 * ║                                                                ║
 * ║   Powered by Workshop-DIY.org                                  ║
 * ║   Build your own Bluetooth remote controller!                  ║
 * ╚════════════════════════════════════════════════════════════════╝
 * 
 * 📋 PROJECT: ${cfg.title}
 * 📅 Generated: ${dateStr} at ${timeStr}
 * 
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ 📊 CONFIGURATION STATS                                         │
 * ├─────────────────────────────────────────────────────────────────┤
 * │  • Config size: ${String(cfgSize).padEnd(6)} bytes (Base64 encoded)            │
 * │  • Chunks: ${String(nbChunks).padEnd(10)} (18 bytes each for BLE transfer)    │
 * │  • Total widgets: ${String(totalWidgets).padEnd(4)}                                       │
 * │    ├─ Input:  ${String(inputWidgets).padEnd(4)} (buttons, sliders, toggles, etc.)       │
 * │    └─ Output: ${String(outputWidgets).padEnd(4)} (LEDs, labels, gauges, graphs)         │
 * └─────────────────────────────────────────────────────────────────┘
 * 
 * 🔧 WIDGET BREAKDOWN:
 *    Buttons: ${buttons.length}  |  Sliders: ${sliders.length}  |  Toggles: ${toggles.length}
 *    Joysticks: ${joysticks.length}  |  D-Pads: ${dpads.length}  |  XY Pads: ${xypads.length}
 *    LEDs: ${leds.length}  |  Labels: ${labels.length}  |  Gauges: ${gauges.length}
 *    Graphs: ${graphs.length}  |  Batteries: ${batteries.length}  |  Timers: ${timers.length}
 * 
 * 🚀 HOW TO USE:
 *    1. Copy this entire code
 *    2. Go to https://makecode.microbit.org
 *    3. Create new project → Switch to JavaScript mode
 *    4. Paste this code → Download to micro:bit
 *    5. Open the app and connect!
 * 
 * 💡 TIPS:
 *    • Edit handleWidget() to customize behavior
 *    • Use sendValue() to update LEDs, labels, gauges
 *    • Check serial monitor for debug output
 * 
 * 🌐 More info: https://workshop-diy.org
 */

`;

  return header + `// ═══════════════════════════════════════════════════════════════
// 🔌 BLUETOOTH SETUP
// ═══════════════════════════════════════════════════════════════

bluetooth.startUartService()
let cfgSent = false
let blinkState = false

// 📦 Remote layout config (Base64 encoded, ${cfgSize} bytes, ${nbChunks} chunks)
const CFG = "${b64}"

// ═══════════════════════════════════════════════════════════════
// 📡 BLUETOOTH COMMUNICATION
// ═══════════════════════════════════════════════════════════════

// This sends the remote layout to the app
bluetooth.onUartDataReceived(serial.delimiters(Delimiters.NewLine), function() {
    let cmd = bluetooth.uartReadUntil(serial.delimiters(Delimiters.NewLine))
    
    if (cmd == "GETCFG") {
        bluetooth.uartWriteLine("CFGBEGIN")
        for (let i = 0; i < CFG.length; i += 18) {
            bluetooth.uartWriteLine("CFG " + CFG.substr(i, 18))
        }
        bluetooth.uartWriteLine("CFGEND")
        cfgSent = true
        basic.showIcon(IconNames.Yes)
    } 
    else if (cmd.indexOf("SET ") == 0) {
        let parts = cmd.substr(4).split(" ")
        let id = parts[0]
        let val = parts.slice(1).join(" ")
        handleWidget(id, val)
    }
})

// ═══════════════════════════════════════════════════════════════
// 🎮 WIDGET HANDLERS - CUSTOMIZE YOUR BEHAVIOR HERE!
// ═══════════════════════════════════════════════════════════════

function handleWidget(id: string, val: string) {
    serial.writeLine(id + " = " + val)
    
${buttonCode || '    // No buttons in this remote'}

${sliderCode || '    // No sliders in this remote'}

${toggleCode || '    // No toggles in this remote'}

${joystickCode || '    // No joysticks in this remote'}

${dpadCode || '    // No D-Pads in this remote'}

${xypadCode || '    // No XY Pads in this remote'}

${timerCode || '    // No timers in this remote'}
}

// ═══════════════════════════════════════════════════════════════
// 📤 SEND VALUES TO APP (LEDs, Labels, Gauges, Graphs)
// ═══════════════════════════════════════════════════════════════

function sendValue(id: string, val: string) {
    if (cfgSent) bluetooth.uartWriteLine("UPD " + id + " " + val)
}

// ═══════════════════════════════════════════════════════════════
// 🚀 STARTUP
// ═══════════════════════════════════════════════════════════════

// Show we are ready!
basic.showIcon(IconNames.Heart)

// ═══════════════════════════════════════════════════════════════
// 🔄 MAIN LOOP - Demo animations (customize or remove!)
// ═══════════════════════════════════════════════════════════════

basic.forever(function() {
    if (cfgSent) {
        blinkState = !blinkState
        ${leds.length > 0 ? leds.map(l => `sendValue("${l.id}", blinkState ? "1" : "0")`).join('\n        ') : '// No LEDs to blink'}
        ${labels.length > 0 ? `sendValue("${labels[0].id}", blinkState ? "ON!" : "OFF")` : ''}
        // Demo updates for Gauges (single value) and Graphs (comma-separated)
        let t = input.runningTime()
        ${gauges.length > 0 ? gauges.map((g,i)=>`sendValue("${g.id}", "" + (Math.round((Math.sin((t/1000)+${i}) + 1) * 25)))`).join("\n        ") : "// No gauges to update"}
        ${graphs.length > 0 ? graphs.map((g,i)=>`sendValue("${g.id}", "" + (Math.round((Math.sin((t/900)+${i}) + 1) * 50)) + "," + (Math.round((Math.cos((t/1100)+${i}) + 1) * 50)))`).join("\n        ") : "// No graphs to update"}
        ${batteries.length > 0 ? batteries.map((b,i)=>`sendValue("${b.id}", "" + (Math.round((Math.sin((t/2000)+${i}) + 1) * 50)))`).join("\n        ") : "// No batteries to update"}
    }
    basic.pause(200)
})

// ═══════════════════════════════════════════════════════════════
// 🔘 MICRO:BIT BUTTONS - Use hardware buttons too!
// ═══════════════════════════════════════════════════════════════

input.onButtonPressed(Button.A, function() {
    basic.showString("A")
    ${leds.length > 0 ? `sendValue("${leds[0].id}", "1")` : '// Add an LED to control it here!'}
})
input.onButtonPressed(Button.B, function() {
    basic.showString("B")
    ${leds.length > 0 ? `sendValue("${leds[0].id}", "0")` : '// Add an LED to control it here!'}
})

// ═══════════════════════════════════════════════════════════════
// 🎉 END OF CODE - Have fun building!
// ═══════════════════════════════════════════════════════════════
// 
// 💡 IDEAS TO TRY:
//    • Add motors: pins.servoWritePin(AnalogPin.P0, angle)
//    • Add sounds: music.playTone(Note.C, music.beat(BeatFraction.Whole))
//    • Add NeoPixels: neopixel.create(DigitalPin.P1, 8, NeoPixelMode.RGB)
//    • Read sensors: input.temperature(), input.lightLevel()
//
// 🌐 Share your projects: https://workshop-diy.org
// ═══════════════════════════════════════════════════════════════`;
}

function init() {
  try{ ensureCanvasToolbar(); }catch(e){}

  try{ placeToolbarWhereHintWas(); }catch(e){}
try{ placeToolbarWhereHintWas(); }catch(e){}
// keep controls at top-right
  try{ moveBuildPlayNameTopRight(); }catch(e){}

  const builderHeader = document.querySelector('.builder-header');
  if (builderHeader && builderHeader.children.length === 0) {
    builderHeader.style.display = 'none';
  }

  state._allowLoadingOverlay = false;
  if (typeof hideLoading === 'function') hideLoading();
  
  // Mobile props panel handling
  const propsPanel = $('#propsPanel');
  const propsPanelClose = $('#propsPanelClose');
  const isMobile = () => window.innerWidth <= 600;
  
  window.showMobilePropsPanel = function() {
    if (isMobile() && propsPanel) {
      propsPanel.classList.add('show-mobile');
    }
  };
  window.hideMobilePropsPanel = function() {
    if (propsPanel) {
      propsPanel.classList.remove('show-mobile');
    }
  };
  
  if (propsPanelClose) {
    propsPanelClose.onclick = (e) => {
      e.stopPropagation();
      hideMobilePropsPanel();
      state.selected = null;
      state.multiSelect = [];
      renderWidgets();
    };
  }
  
  // Tabs
  $$('.tab').forEach(t => t.onclick = () => switchTab(t.dataset.tab));
  
  // Templates
  $$('.template-card').forEach(c => c.onclick = () => selectTemplate(c.dataset.tpl));
  
  // Palette - tap to select
  $$('.palette-item').forEach(p => {
    p.onclick = () => {
      $$('.palette-item').forEach(x => x.classList.remove('selected'));
      p.classList.add('selected');
      state.selectedType = p.dataset.type;
      toast(`✅ ${ICONS[state.selectedType]} selected! Tap canvas to place`, 'success');
    };
  });

  // Collapsible cards
  function setupCollapsibleCard(cardSel, toggleSel, bodySel, storageKey, opts = {}) {
    const card = $(cardSel);
    const toggle = $(toggleSel);
    const body = $(bodySel);
    if (!card || !toggle || !body) return;

    const setCollapsed = (collapsed) => {
      card.classList.toggle('collapsed', collapsed);
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      body.setAttribute('aria-hidden', collapsed ? 'true' : 'false');
    };

    let collapsed = !!opts.defaultCollapsed;
    try{
      const saved = localStorage.getItem(storageKey);
      if (saved !== null) collapsed = saved === '1';
    }catch(e){}
    setCollapsed(collapsed);

    toggle.onclick = () => {
      if (opts.disableOnMobile && window.innerWidth <= 600) return;
      const next = !card.classList.contains('collapsed');
      setCollapsed(next);
      try{ localStorage.setItem(storageKey, next ? '1' : '0'); }catch(e){}
    };
  }

  setupCollapsibleCard('#actionsCard', '#actionsToggle', '#actionsBody', 'actionsCollapsed');
  setupCollapsibleCard('#paletteCard', '#paletteToggle', '#paletteBody', 'paletteCollapsed');

  // Properties panel collapse (desktop)
  const propsCollapseBtn = $('#propsCollapseBtn');
  if (propsPanel && propsCollapseBtn) {
    const setPropsCollapsed = (collapsed) => {
      propsPanel.classList.toggle('collapsed', collapsed);
      propsCollapseBtn.textContent = collapsed ? '+' : '–';
      propsCollapseBtn.title = collapsed ? 'Expand' : 'Collapse';
    };
    try{
      const saved = localStorage.getItem('propsCollapsed');
      if (saved !== null) setPropsCollapsed(saved === '1');
    }catch(e){}
    propsCollapseBtn.onclick = () => {
      const next = !propsPanel.classList.contains('collapsed');
      setPropsCollapsed(next);
      try{ localStorage.setItem('propsCollapsed', next ? '1' : '0'); }catch(e){}
    };
  }
  
  // Canvas - tap to place + selection box
  const canvas = $('#canvas');
  let isDrawingSelBox = false;
  
  canvas.onmousedown = e => {
    if (e.target.closest('.widget') || e.target.closest('.canvas-tool-btn') || e.target.closest('.zoom-btn')) return;
    if (e.shiftKey) {
      isDrawingSelBox = true;
      startSelectionBox(e);
    }
  };
  
  canvas.onmousemove = e => {
    if (isDrawingSelBox) updateSelectionBox(e);
  };
  
  canvas.onmouseup = e => {
    if (isDrawingSelBox) {
      endSelectionBox();
      isDrawingSelBox = false;
    }
  };
  
  canvas.onclick = e => {
    if (e.target.closest('.widget') || e.target.closest('.canvas-tool-btn') || e.target.closest('.zoom-btn') || e.target.closest('.minimap')) return;
    if (state.selectedType) {
      saveUndoState();
      const rect = canvas.getBoundingClientRect();
      const [w, h] = SIZES[state.selectedType];
      let x = Math.max(0, Math.min(e.clientX - rect.left - w/2, rect.width - w));
      let y = Math.max(0, Math.min(e.clientY - rect.top - h/2, rect.height - h));
      if (state.gridSnap) { x = snapToGrid(x); y = snapToGrid(y); }
      const base = applyWidgetDefaults({ id: `${state.selectedType}${state.nextId++}`, t: state.selectedType, x, y, w, h, label: '' });
      state.widgets.push(base);
      renderWidgets();
      toast(`✨ ${ICONS[state.selectedType]} added!`, 'success');
    } else {
      state.selected = null;
      state.multiSelect = [];
      renderWidgets();
      renderPropsPanel();
    }
  };
  
  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    const target = e.target;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
    
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    
    // Undo: Ctrl+Z
    if (ctrl && e.key === 'z' && !shift) { e.preventDefault(); undo(); return; }
    // Redo: Ctrl+Shift+Z or Ctrl+Y
    if ((ctrl && shift && e.key === 'z') || (ctrl && e.key === 'y')) { e.preventDefault(); redo(); return; }
    // Copy: Ctrl+C
    if (ctrl && e.key === 'c') { e.preventDefault(); copySelected(); return; }
    // Paste: Ctrl+V
    if (ctrl && e.key === 'v') { e.preventDefault(); pasteWidgets(); return; }
    // Duplicate: Ctrl+D
    if (ctrl && e.key === 'd') { e.preventDefault(); duplicateSelected(); return; }
    // Group: Ctrl+G
    if (ctrl && e.key === 'g') { e.preventDefault(); groupSelected(); return; }
    // Save template: Ctrl+S
    if (ctrl && e.key === 's') { e.preventDefault(); saveWidgetTemplate(); return; }
    // Toggle grid: G
    if (e.key === 'g' && !ctrl) { 
      state.gridSnap = !state.gridSnap;
      const btn = $('#gridToggle');
      if (btn) btn.classList.toggle('active', state.gridSnap);
      $('#canvas')?.classList.toggle('show-grid', state.gridSnap);
      toast(state.gridSnap ? '⊞ Grid ON' : '⊞ Grid OFF', 'success');
      return;
    }
    // Toggle layers: L
    if (e.key === 'l' && !ctrl) { toggleLayers(); return; }
    // Theme cycle: T
    if (e.key === 't' && !ctrl) { cycleTheme(); return; }
    // Delete: Delete or Backspace
    if (e.key === 'Delete' || e.key === 'Backspace') { 
      e.preventDefault(); 
      if (state.multiSelect.length) {
        saveUndoState();
        state.widgets = state.widgets.filter(w => !state.multiSelect.includes(w.id));
        state.multiSelect = [];
        state.selected = null;
        renderWidgets();
        renderPropsPanel();
        toast('🗑️ Deleted widgets', 'success');
      } else {
        deleteSelected(); 
      }
      return; 
    }
    // Select all: Ctrl+A
    if (ctrl && e.key === 'a') { 
      e.preventDefault(); 
      state.multiSelect = state.widgets.map(w => w.id);
      updateSelectionUI();
      toast(`Selected all ${state.widgets.length} widgets`, 'success');
      return; 
    }
    // Arrow keys: nudge
    const nudgeAmount = shift ? 10 : 1;
    if (e.key === 'ArrowLeft') { e.preventDefault(); nudgeSelected(-nudgeAmount, 0); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); nudgeSelected(nudgeAmount, 0); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); nudgeSelected(0, -nudgeAmount); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); nudgeSelected(0, nudgeAmount); return; }
    // Escape: deselect
    if (e.key === 'Escape') {
      state.selected = null;
      state.multiSelect = [];
      state.selectedType = null;
      $$('.palette-item').forEach(p => p.classList.remove('selected'));
      updateSelectionUI();
      renderPropsPanel();
    }
    // Help: ?
    if (e.key === '?' || (shift && e.key === '/')) { showHelp(); return; }
  });
  
  // Buttons
  $('#soundBtn').onclick = () => { state.soundOn = !state.soundOn; updateSoundUI(); if (state.soundOn) beepClick(); };
  updateSoundUI();
  $('#bleBtn').onclick = connectBle;
  $('#connectBtn').onclick = connectBle;
  $('#demoBtn').onclick = showDemo;
  
  // Back to Build button
  const backBtn = $('#backToBuildBtn');
  if (backBtn) backBtn.onclick = () => {
    // Exit arrange mode if active
    if (state.arrangeMode) {
      toggleArrangeMode();
    }
    switchTab('builder');
  };
  
  // Arrange mode button
  const arrangeBtn = $('#arrangeModeBtn');
  if (arrangeBtn) arrangeBtn.onclick = toggleArrangeMode;
  
  // Auto-save on title change
  const titleInput = $('#titleInput');
  if (titleInput) {
    titleInput.addEventListener('input', scheduleAutoSave);
    titleInput.addEventListener('change', scheduleAutoSave);
  }
  
    // Templates
  $('#templateBtn').onclick = () => $('#templateModal').classList.remove('hidden');
  // Language on first load
  var savedLang = loadLang();
  setLang(savedLang || state.lang || detectBrowserLang());
  
  // Try to load saved project first; only show templates if nothing saved
  const hasProject = loadSavedProject();
  if (hasProject) {
    $('#templateModal').classList.add('hidden');
    renderWidgets();
    renderPropsPanel();
    toast('📂 Restored your last project!', 'success');
  } else {
    $('#templateModal').classList.remove('hidden');
  }
  
  var _ov=$('#loadingOverlay');
  if (_ov) _ov.onclick = () => { state._allowLoadingOverlay=false; hideLoading(); };
  if (typeof hideLoadOverlay==='function') hideLoadOverlay();
  $('#codeBtn').onclick = showCode;
  $('#deleteBtn').onclick = deleteSelected;
  $('#clearCacheBtn').onclick = () => {
    if(confirm('Clear all cached data (localStorage)? This will reset settings and saved layouts.')){
      try{ localStorage.clear(); }catch(e){}
      alert('Cache cleared. Reloading...');
      setTimeout(()=>location.reload(), 300);
    }
  };

  // JSON Export / Import + Language
  const jsonIn = $('#jsonFileInput');
  if (jsonIn){
    jsonIn.onchange = e => {
      const f = e.target.files && e.target.files[0];
      if (f) importLayoutJsonFile(f);
      e.target.value = '';
    };
  }
  const exp = $('#exportJsonBtn'); if (exp) exp.addEventListener('click', exportLayoutJson);
  const imp = $('#importJsonBtn'); if (imp) imp.addEventListener('click', () => $('#jsonFileInput').click());
  const lb = $('#langBtn'); if (lb) lb.addEventListener('click', cycleLang);
  $('#modalClose').onclick = () => $('#modalBg').classList.remove('show');
  $('#modalBg').onclick = e => { if (e.target === $('#modalBg')) $('#modalBg').classList.remove('show'); };
  $('#copyBtn').onclick = () => { navigator.clipboard.writeText($('#modalCode').textContent); toast('📋 Copied!', 'success'); };
  $('#downloadBtn').onclick = downloadCode;
  
  // Flash button - Bluetooth flashing to micro:bit
  const flashBtn = $('#flashBtn');
  if (flashBtn) {
    flashBtn.onclick = flashToMicrobit;
    // Check if Web Bluetooth is supported
    if (!navigator.bluetooth) {
      flashBtn.title = 'Web Bluetooth not supported in this browser';
      flashBtn.style.opacity = '0.5';
    }
  }
  
  // Load saved theme
  try {
    const savedTheme = localStorage.getItem('widget_theme');
    if (savedTheme && THEMES[savedTheme]) setTheme(savedTheme);
  } catch(e) {}
  
  // Load high contrast preference
  loadHighContrastPref();
  
  // Load widget templates from localStorage
  loadWidgetTemplates();
  
  // Check for URL layout parameter
  loadURLLayout();
  
  // === NEW FEATURES ===
  
  // Build toolbar buttons
  const undoBtn = $('#undoBtn');
  const redoBtn = $('#redoBtn');
  const autoArrangeBtn = $('#autoArrangeBtn');
  const magicBtn = $('#magicBtn');
  
  if (undoBtn) undoBtn.onclick = undo;
  if (redoBtn) redoBtn.onclick = redo;
  if (autoArrangeBtn) autoArrangeBtn.onclick = autoArrangeWidgets;
  if (magicBtn) magicBtn.onclick = magicStyleWidgets;
  
  // Theme dots
  $$('.theme-dot').forEach(dot => {
    dot.onclick = () => setTheme(dot.dataset.theme);
  });
  
  // Load saved theme
  try {
    const savedTheme = localStorage.getItem('app_theme');
    if (savedTheme) {
      document.body.classList.remove('theme-dark', 'theme-ocean', 'theme-space', 'theme-candy', 'theme-forest', 'theme-neon');
      if (savedTheme !== 'dark') document.body.classList.add('theme-' + savedTheme);
      $$('.theme-dot').forEach(d => d.classList.toggle('active', d.dataset.theme === savedTheme));
      state.theme = savedTheme;
    }
  } catch(e) {}
  
  // Fullscreen buttons
  const fullscreenBtn = $('#fullscreenBtn');
  const fullscreenExitBtn = $('#fullscreenExitBtn');
  if (fullscreenBtn) fullscreenBtn.onclick = toggleFullscreen;
  if (fullscreenExitBtn) fullscreenExitBtn.onclick = toggleFullscreen;
  
  // Quick actions menu
  const quickMenu = $('#quickActionsMenu');
  if (quickMenu) {
    quickMenu.querySelectorAll('.quick-action-btn').forEach(btn => {
      btn.onclick = () => handleQuickAction(btn.dataset.action);
    });
  }
  
  // Long-press for quick actions on widgets
  let longPressTimer = null;
  document.addEventListener('pointerdown', e => {
    const widget = e.target.closest('.widget');
    if (!widget) return;
    longPressTimer = setTimeout(() => {
      showQuickActions(widget.dataset.id, e.clientX, e.clientY);
    }, 500);
  });
  document.addEventListener('pointerup', () => { clearTimeout(longPressTimer); });
  document.addEventListener('pointermove', () => { clearTimeout(longPressTimer); });
  document.addEventListener('click', e => {
    if (!e.target.closest('.quick-actions-menu')) hideQuickActions();
  });
  
  // Tutorial
  const tutorialNextBtn = $('#tutorialNextBtn');
  const tutorialSkipBtn = $('#tutorialSkipBtn');
  if (tutorialNextBtn) tutorialNextBtn.onclick = nextTutorialStep;
  if (tutorialSkipBtn) tutorialSkipBtn.onclick = closeTutorial;
  
  // Show tutorial on first visit
  try {
    if (!localStorage.getItem('tutorial_done')) {
      setTimeout(showTutorial, 500);
    }
  } catch(e) {}
  
  // Setup shake detection and swipe gestures
  setupShakeDetection();
  setupSwipeGestures();
  
  // Update toolbar state
  updateBuildToolbar();
}

// === CELEBRATION ANIMATION ===
function celebrate(message = '🎉 Connected!') {
  const overlay = document.createElement('div');
  overlay.className = 'celebration-overlay';
  
  // Create confetti
  const colors = ['#ff6b6b', '#feca57', '#48dbfb', '#ff9ff3', '#54a0ff', '#00e676', '#ff9100'];
  for (let i = 0; i < 50; i++) {
    const confetti = document.createElement('div');
    confetti.className = 'confetti';
    confetti.style.left = Math.random() * 100 + '%';
    confetti.style.background = colors[Math.floor(Math.random() * colors.length)];
    confetti.style.animationDelay = Math.random() * 0.5 + 's';
    confetti.style.transform = `rotate(${Math.random() * 360}deg)`;
    overlay.appendChild(confetti);
  }
  
  // Create text
  const text = document.createElement('div');
  text.className = 'celebration-text';
  text.textContent = message;
  overlay.appendChild(text);
  
  document.body.appendChild(overlay);
  
  // Play celebration sound
  if (state.soundOn) {
    beep(523, 0.1, 0.06); // C
    setTimeout(() => beep(659, 0.1, 0.06), 100); // E
    setTimeout(() => beep(784, 0.15, 0.06), 200); // G
    setTimeout(() => beep(1047, 0.2, 0.08), 300); // High C
  }
  
  // Remove after animation
  setTimeout(() => overlay.remove(), 3000);
}

// === FULLSCREEN MODE ===
function toggleFullscreen() {
  const btn = $('#fullscreenBtn');
  const exitBtn = $('#fullscreenExitBtn');
  const grid = $('#runtimeGrid');
  const isFullscreen = document.body.classList.contains('runtime-fullscreen');
  
  if (isFullscreen) {
    // Exit fullscreen
    document.body.classList.remove('runtime-fullscreen');
    if (btn) {
      btn.textContent = '⛶ Fullscreen';
      btn.classList.add('visible');
      btn.style.display = '';
    }
    
    // Reset zoom
    if (grid) {
      grid.style.transform = '';
    }
    
    // Exit native fullscreen API
    if (document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement) {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      } else if (document.mozCancelFullScreen) {
        document.mozCancelFullScreen();
      }
    }
  } else {
    // Enter fullscreen
    document.body.classList.add('runtime-fullscreen');
    if (btn) {
      btn.classList.remove('visible');
      btn.style.display = 'none';
    }
    
    // Request native fullscreen API
    const elem = document.documentElement;
    if (elem.requestFullscreen) {
      elem.requestFullscreen().catch(() => {});
    } else if (elem.webkitRequestFullscreen) {
      elem.webkitRequestFullscreen();
    } else if (elem.mozRequestFullScreen) {
      elem.mozRequestFullScreen();
    }
    
    // Apply zoom to fit
    setTimeout(() => {
      zoomToFitScreen();
    }, 150);
  }
}

// Exit fullscreen on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.body.classList.contains('runtime-fullscreen')) {
    toggleFullscreen();
  }
});

// Handle native fullscreen API changes (e.g., ESC key pressed)
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && document.body.classList.contains('runtime-fullscreen')) {
    toggleFullscreen();
  }
});
document.addEventListener('webkitfullscreenchange', () => {
  if (!document.webkitFullscreenElement && document.body.classList.contains('runtime-fullscreen')) {
    toggleFullscreen();
  }
});
document.addEventListener('mozfullscreenchange', () => {
  if (!document.mozFullScreenElement && document.body.classList.contains('runtime-fullscreen')) {
    toggleFullscreen();
  }
});

// === AUTO ARRANGE WIDGETS ===
function autoArrangeWidgets() {
  if (!state.widgets.length) {
    toast('No widgets to arrange!', 'error');
    return;
  }
  
  saveUndoState();
  
  const padding = 15;
  const canvas = $('#canvas');
  const canvasW = canvas?.offsetWidth || 500;
  
  // Sort by size (larger first)
  const sorted = [...state.widgets].sort((a, b) => (b.w * b.h) - (a.w * a.h));
  
  let currentX = padding;
  let currentY = padding;
  let rowHeight = 0;
  
  sorted.forEach(w => {
    // Check if widget fits in current row
    if (currentX + w.w + padding > canvasW) {
      // Move to next row
      currentX = padding;
      currentY += rowHeight + padding;
      rowHeight = 0;
    }
    
    w.x = currentX;
    w.y = currentY;
    currentX += w.w + padding;
    rowHeight = Math.max(rowHeight, w.h);
  });
  
  renderWidgets();
  toast('✨ Widgets arranged!', 'success');
  if (state.soundOn) beepClick();
}

// === THEME SELECTOR ===
function showThemeSelector() {
  // Remove existing selector
  const existing = document.querySelector('.theme-modal');
  if (existing) existing.remove();
  
  const modal = document.createElement('div');
  modal.className = 'modal-bg show theme-modal';
  modal.innerHTML = `
    <div class="modal" style="max-width: 400px;">
      <div class="modal-title">🎨 Choose Theme</div>
      <div class="theme-selector">
        <div class="theme-chip dark ${state.theme === 'dark' ? 'active' : ''}" data-theme="dark">🌙 Dark</div>
        <div class="theme-chip ocean ${state.theme === 'ocean' ? 'active' : ''}" data-theme="ocean">🌊 Ocean</div>
        <div class="theme-chip space ${state.theme === 'space' ? 'active' : ''}" data-theme="space">🚀 Space</div>
        <div class="theme-chip candy ${state.theme === 'candy' ? 'active' : ''}" data-theme="candy">🍬 Candy</div>
        <div class="theme-chip forest ${state.theme === 'forest' ? 'active' : ''}" data-theme="forest">🌲 Forest</div>
        <div class="theme-chip sunset ${state.theme === 'sunset' ? 'active' : ''}" data-theme="sunset">🌅 Sunset</div>
      </div>
      <div style="margin-top: 16px;">
        <button class="modal-btn secondary" onclick="this.closest('.modal-bg').remove()">✕ Close</button>
      </div>
    </div>
  `;
  
  modal.querySelectorAll('.theme-chip').forEach(chip => {
    chip.onclick = () => {
      const theme = chip.dataset.theme;
      setAppTheme(theme);
      modal.querySelectorAll('.theme-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      if (state.soundOn) beepClick();
    };
  });
  
  modal.onclick = e => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);
}

function setAppTheme(theme) {
  // Remove all theme classes
  document.body.classList.remove('theme-dark', 'theme-ocean', 'theme-space', 'theme-candy', 'theme-forest', 'theme-sunset', 'theme-light', 'theme-neon', 'theme-nature');
  
  if (theme && theme !== 'dark') {
    document.body.classList.add('theme-' + theme);
  }
  
  state.theme = theme;
  try { localStorage.setItem('app_theme', theme); } catch(e) {}
  toast(`🎨 Theme: ${theme.charAt(0).toUpperCase() + theme.slice(1)}`, 'success');
}

// Load saved theme on startup
try {
  const savedTheme = localStorage.getItem('app_theme');
  if (savedTheme) setAppTheme(savedTheme);
} catch(e) {}

// === SHARE VIA QR CODE ===
function showShareQR() {
  const titleEl = $('#titleInput');
  const data = {
    title: titleEl?.value || 'My Remote',
    widgets: state.widgets
  };
  
  // Create simple URL-safe layout string
  const layoutStr = btoa(unescape(encodeURIComponent(JSON.stringify(data))));
  const url = location.origin + location.pathname + '?layout=' + layoutStr;
  
  // Create QR modal
  const modal = document.createElement('div');
  modal.className = 'modal-bg show';
  modal.innerHTML = `
    <div class="modal qr-modal" style="max-width: 350px;">
      <div class="modal-title">📱 Share Your Remote</div>
      <div class="qr-code-container">
        <canvas id="qrCanvas"></canvas>
      </div>
      <p style="color: var(--text-dim); font-size: 0.85rem; margin-bottom: 16px;">Scan this code to load your layout!</p>
      <div class="modal-buttons">
        <button class="modal-btn primary" onclick="navigator.clipboard.writeText('${url}'); toast('📋 Link copied!', 'success');">📋 Copy Link</button>
        <button class="modal-btn secondary" onclick="this.closest('.modal-bg').remove()">✕ Close</button>
      </div>
    </div>
  `;
  
  modal.onclick = e => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);
  
  // Generate QR code
  generateQRCode('qrCanvas', url);
}

// Simple QR code generator (basic version)
function generateQRCode(canvasId, text) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  
  const ctx = canvas.getContext('2d');
  const size = 200;
  canvas.width = size;
  canvas.height = size;
  
  // Simple placeholder - in production you'd use a QR library
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  
  ctx.fillStyle = '#000';
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('QR Code', size/2, size/2 - 20);
  ctx.font = '11px sans-serif';
  ctx.fillText('(Add qrcode.js library', size/2, size/2 + 10);
  ctx.fillText('for real QR codes)', size/2, size/2 + 25);
  
  // Draw simple pattern to indicate it's a QR placeholder
  ctx.fillStyle = '#000';
  const patternSize = 30;
  // Top-left corner
  ctx.fillRect(10, 10, patternSize, patternSize);
  ctx.fillStyle = '#fff';
  ctx.fillRect(15, 15, patternSize - 10, patternSize - 10);
  ctx.fillStyle = '#000';
  ctx.fillRect(20, 20, patternSize - 20, patternSize - 20);
  
  // Top-right corner
  ctx.fillStyle = '#000';
  ctx.fillRect(size - 10 - patternSize, 10, patternSize, patternSize);
  ctx.fillStyle = '#fff';
  ctx.fillRect(size - 15 - patternSize + 5, 15, patternSize - 10, patternSize - 10);
  ctx.fillStyle = '#000';
  ctx.fillRect(size - 20 - patternSize + 10, 20, patternSize - 20, patternSize - 20);
  
  // Bottom-left corner
  ctx.fillStyle = '#000';
  ctx.fillRect(10, size - 10 - patternSize, patternSize, patternSize);
  ctx.fillStyle = '#fff';
  ctx.fillRect(15, size - 15 - patternSize + 5, patternSize - 10, patternSize - 10);
  ctx.fillStyle = '#000';
  ctx.fillRect(20, size - 20 - patternSize + 10, patternSize - 20, patternSize - 20);
}

// === SCREENSHOT ===
function takeScreenshot() {
  const canvas = $('#canvas') || $('#runtimeGrid');
  if (!canvas) {
    toast('Nothing to capture!', 'error');
    return;
  }
  
  // Use html2canvas if available
  if (typeof html2canvas !== 'undefined') {
    html2canvas(canvas).then(c => {
      const link = document.createElement('a');
      link.download = 'my-remote.png';
      link.href = c.toDataURL();
      link.click();
      toast('📸 Screenshot saved!', 'success');
    }).catch(() => toast('Screenshot failed', 'error'));
  } else {
    toast('📸 Screenshot requires html2canvas library', 'error');
  }
}

// === LONG PRESS QUICK ACTIONS ===
function setupLongPressActions() {
  let longPressTimer = null;
  let longPressTarget = null;
  
  const showQuickMenu = (widget, x, y) => {
    // Remove existing menu
    document.querySelectorAll('.quick-action-menu').forEach(m => m.remove());
    
    const menu = document.createElement('div');
    menu.className = 'quick-action-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.innerHTML = `
      <button class="quick-action-btn" data-action="duplicate" title="Duplicate">📋</button>
      <button class="quick-action-btn" data-action="color" title="Change color">🎨</button>
      <button class="quick-action-btn" data-action="lock" title="Lock/Unlock">🔒</button>
      <button class="quick-action-btn" data-action="front" title="Bring to front">⬆️</button>
      <button class="quick-action-btn" data-action="back" title="Send to back">⬇️</button>
      <button class="quick-action-btn danger" data-action="delete" title="Delete">🗑️</button>
    `;
    
    menu.querySelectorAll('.quick-action-btn').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        const w = state.widgets.find(w => w.id === widget.dataset.id);
        
        if (action === 'duplicate') {
          duplicateWidget(w);
        } else if (action === 'color') {
          randomizeWidgetColor(w);
        } else if (action === 'lock') {
          w.locked = !w.locked;
          toast(w.locked ? '🔒 Locked' : '🔓 Unlocked', 'success');
          renderWidgets();
        } else if (action === 'front') {
          bringToFront(w);
        } else if (action === 'back') {
          sendToBack(w);
        } else if (action === 'delete') {
          saveUndoState();
          state.widgets = state.widgets.filter(x => x.id !== w.id);
          state.selected = null;
          renderWidgets();
          renderPropsPanel();
          toast('🗑️ Deleted', 'success');
        }
        
        menu.remove();
        if (state.soundOn) beepClick();
      };
    });
    
    document.body.appendChild(menu);
    
    // Close menu on click elsewhere
    const closeMenu = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 10);
  };
  
  document.addEventListener('pointerdown', e => {
    const widget = e.target.closest('.widget');
    if (!widget) return;
    
    longPressTarget = widget;
    longPressTimer = setTimeout(() => {
      // Vibrate if supported
      if (navigator.vibrate) navigator.vibrate(50);
      showQuickMenu(widget, e.clientX, e.clientY);
    }, 500);
  });
  
  document.addEventListener('pointerup', () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  });
  
  document.addEventListener('pointermove', e => {
    if (longPressTimer && longPressTarget) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  });
}

function duplicateWidget(w) {
  if (!w) return;
  saveUndoState();
  const newW = { ...w, id: `${w.t}${state.nextId++}`, x: w.x + 20, y: w.y + 20 };
  state.widgets.push(newW);
  state.selected = newW.id;
  renderWidgets();
  toast('📋 Duplicated!', 'success');
}

function randomizeWidgetColor(w) {
  if (!w) return;
  const colors = ['#ff6b6b', '#feca57', '#48dbfb', '#ff9ff3', '#54a0ff', '#00e676', '#ff9100', '#b388ff'];
  w.color = colors[Math.floor(Math.random() * colors.length)];
  renderWidgets();
  renderPropsPanel();
  toast('🎨 New color!', 'success');
}

function bringToFront(w) {
  if (!w) return;
  const idx = state.widgets.findIndex(x => x.id === w.id);
  if (idx >= 0) {
    state.widgets.splice(idx, 1);
    state.widgets.push(w);
    renderWidgets();
    toast('⬆️ Brought to front', 'success');
  }
}

function sendToBack(w) {
  if (!w) return;
  const idx = state.widgets.findIndex(x => x.id === w.id);
  if (idx >= 0) {
    state.widgets.splice(idx, 1);
    state.widgets.unshift(w);
    renderWidgets();
    toast('⬇️ Sent to back', 'success');
  }
}

// === UPDATE BUILD TOOLBAR STATE ===
function updateBuildToolbar() {
  const undoBtn = $('#undoBtn');
  const redoBtn = $('#redoBtn');
  
  if (undoBtn) undoBtn.disabled = !state.undoStack.length;
  if (redoBtn) redoBtn.disabled = !state.redoStack.length;
}

// === HAPTIC FEEDBACK ===
function vibrate(pattern = 10) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

// === PARTICLE EFFECTS ON BUTTON PRESS ===
function createParticles(x, y, count = 8) {
  const colors = ['#ff6b6b', '#feca57', '#48dbfb', '#ff9ff3', '#54a0ff'];
  
  for (let i = 0; i < count; i++) {
    const particle = document.createElement('div');
    particle.className = 'particle';
    const size = 4 + Math.random() * 8;
    const angle = (Math.PI * 2 / count) * i;
    const distance = 20 + Math.random() * 30;
    
    particle.style.width = size + 'px';
    particle.style.height = size + 'px';
    particle.style.background = colors[Math.floor(Math.random() * colors.length)];
    particle.style.left = x + 'px';
    particle.style.top = y + 'px';
    particle.style.transform = `translate(${Math.cos(angle) * distance}px, ${Math.sin(angle) * distance}px)`;
    
    document.body.appendChild(particle);
    setTimeout(() => particle.remove(), 600);
  }
}

function selectTemplate(name) {
  const t = templates[name];
  if (!t) return;

  // Kids-friendly loading overlay while building a template
  if (typeof showLoadOverlay === 'function') {
    const titles = {
      gamepad: '🎮 Building Game Pad...',
      robot: '🤖 Building Robot Remote...',
      mixer: '🎵 Building DJ Mixer...',
      racing: '🏎️ Building Race Car...',
      lights: '💡 Building Lights Panel...',
      blank: '✨ Preparing Blank Canvas...'
    };
    showBuildOverlay(titles[name] || '✨ Building...');
  }

  // Small delay so the overlay is visible and feels animated
  setTimeout(() => {
    state.widgets = t.map((w, i) => ({ id: `${w.t}${state.nextId + i}`, ...w }));
    state.nextId += t.length || 1;

    // Apply defaults for new widget types / models
    if (typeof applyWidgetDefaults === 'function') {
      state.widgets.forEach(applyWidgetDefaults);
    }

    state.selected = null;
    $('#templateModal').classList.add('hidden');
    renderWidgets();
    renderPropsPanel();

    if (typeof hideLoadOverlay === 'function') hideLoadOverlay();

    if (name === 'blank') toast('✨ Canvas ready! Pick a widget below', 'success');
    else toast('✅ Template loaded!', 'success');
  }, 250);
}

// (Duplicate definitions of toggleFullscreen and celebrate were removed —
// originals live above at the FULLSCREEN MODE / CELEBRATION sections.)

// === QUICK ACTIONS MENU ===
function showQuickActions(widgetId, x, y) {
  const menu = $('#quickActionsMenu');
  if (!menu) return;
  
  state._quickActionTarget = widgetId;
  menu.style.left = Math.min(x, window.innerWidth - 160) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 250) + 'px';
  menu.classList.add('show');
  
  if (navigator.vibrate) navigator.vibrate(30);
}

function hideQuickActions() {
  const menu = $('#quickActionsMenu');
  if (menu) menu.classList.remove('show');
}

function handleQuickAction(action) {
  const w = state.widgets.find(w => w.id === state._quickActionTarget);
  if (!w) return;
  
  switch(action) {
    case 'duplicate':
      saveUndoState();
      const newW = { ...w, id: `${w.t}${state.nextId++}`, x: w.x + 20, y: w.y + 20 };
      state.widgets.push(newW);
      state.selected = newW.id;
      renderWidgets();
      toast('📋 Duplicated!', 'success');
      break;
    case 'color':
      const colors = ['#ff6b6b', '#feca57', '#48dbfb', '#ff9ff3', '#54a0ff', '#00e676', '#ff9100', '#b388ff'];
      w.color = colors[Math.floor(Math.random() * colors.length)];
      renderWidgets();
      toast('🎨 New color!', 'success');
      break;
    case 'lock':
      w.locked = !w.locked;
      renderWidgets();
      toast(w.locked ? '🔒 Locked' : '🔓 Unlocked', 'success');
      break;
    case 'front':
      const idx = state.widgets.indexOf(w);
      state.widgets.splice(idx, 1);
      state.widgets.push(w);
      renderWidgets();
      toast('⬆️ Brought to front', 'success');
      break;
    case 'back':
      const idx2 = state.widgets.indexOf(w);
      state.widgets.splice(idx2, 1);
      state.widgets.unshift(w);
      renderWidgets();
      toast('⬇️ Sent to back', 'success');
      break;
    case 'delete':
      saveUndoState();
      state.widgets = state.widgets.filter(x => x.id !== w.id);
      state.selected = null;
      renderWidgets();
      renderPropsPanel();
      toast('🗑️ Deleted', 'success');
      break;
  }
  
  hideQuickActions();
  if (state.soundOn) beepClick();
}

// === TUTORIAL ===
const tutorialSteps = [
  { icon: '👋', title: 'Welcome!', text: 'Let\'s build your first micro:bit remote control! It\'s easy and fun!' },
  { icon: '👆', title: 'Pick a Widget', text: 'Tap any widget below (like Button or Slider) to select it.' },
  { icon: '📱', title: 'Place It', text: 'Then tap on the canvas to place your widget. You can drag it around!' },
  { icon: '🔗', title: 'Connect & Play!', text: 'When ready, go to Play mode and connect your micro:bit. Have fun!' }
];
let tutorialStep = 0;

function showTutorial() {
  tutorialStep = 0;
  updateTutorialStep();
  $('#tutorialOverlay')?.classList.remove('hidden');
}

function updateTutorialStep() {
  const step = tutorialSteps[tutorialStep];
  if (!step) {
    closeTutorial();
    return;
  }
  
  $('#tutorialIcon').textContent = step.icon;
  $('#tutorialTitle').textContent = step.title;
  $('#tutorialText').textContent = step.text;
  
  const btn = $('#tutorialNextBtn');
  btn.textContent = tutorialStep === tutorialSteps.length - 1 ? 'Start Building! 🚀' : 'Next →';
  
  $$('.tutorial-dot').forEach((dot, i) => {
    dot.classList.toggle('active', i === tutorialStep);
  });
}

function nextTutorialStep() {
  tutorialStep++;
  if (tutorialStep >= tutorialSteps.length) {
    closeTutorial();
  } else {
    updateTutorialStep();
  }
  if (state.soundOn) beepClick();
}

function closeTutorial() {
  $('#tutorialOverlay')?.classList.add('hidden');
  try { localStorage.setItem('tutorial_done', '1'); } catch(e) {}
}

// === THEME SWITCHING ===
function setTheme(theme) {
  document.body.classList.remove('theme-dark', 'theme-ocean', 'theme-space', 'theme-candy', 'theme-forest', 'theme-neon');
  if (theme !== 'dark') {
    document.body.classList.add('theme-' + theme);
  }
  state.theme = theme;
  
  $$('.theme-dot').forEach(d => d.classList.toggle('active', d.dataset.theme === theme));
  
  try { localStorage.setItem('app_theme', theme); } catch(e) {}
  toast('🎨 Theme: ' + theme.charAt(0).toUpperCase() + theme.slice(1), 'success');
  if (state.soundOn) beepClick();
}

// (Duplicate definition of autoArrangeWidgets removed — see earlier definition.)

// === MAGIC WAND - Random Style All Widgets ===
function magicStyleWidgets() {
  if (!state.widgets.length) {
    toast('Add some widgets first!', 'error');
    return;
  }
  
  saveUndoState();
  
  const colors = ['#ff6b6b', '#feca57', '#48dbfb', '#ff9ff3', '#54a0ff', '#00e676', '#ff9100', '#b388ff', '#00d4ff'];
  const models = {
    button: ['neo', 'glass', 'pill', 'flat'],
    slider: ['track', 'neon', 'min'],
    toggle: ['square', 'pill', 'icon'],
    joystick: ['classic', 'ring', 'min'],
    gauge: ['classic', 'neon', 'minimal'],
    led: ['dot', 'ring', 'bar']
  };
  
  state.widgets.forEach(w => {
    w.color = colors[Math.floor(Math.random() * colors.length)];
    if (models[w.t]) {
      w.model = models[w.t][Math.floor(Math.random() * models[w.t].length)];
    }
  });
  
  renderWidgets();
  renderPropsPanel();
  
  // Fun particle explosion
  const canvas = $('#canvas');
  if (canvas) {
    const rect = canvas.getBoundingClientRect();
    createParticles(rect.left + rect.width/2, rect.top + rect.height/2, 20);
  }
  
  toast('🪄 Magic applied!', 'success');
  if (state.soundOn) {
    beep(440, 0.1, 0.05);
    setTimeout(() => beep(554, 0.1, 0.05), 80);
    setTimeout(() => beep(659, 0.1, 0.05), 160);
    setTimeout(() => beep(880, 0.15, 0.05), 240);
  }
}

// === SHAKE TO RANDOMIZE ===
let lastShakeTime = 0;
function setupShakeDetection() {
  if (!window.DeviceMotionEvent) return;
  
  let shakeThreshold = 15;
  let lastX = 0, lastY = 0, lastZ = 0;
  
  window.addEventListener('devicemotion', (e) => {
    const acc = e.accelerationIncludingGravity;
    if (!acc) return;
    
    const deltaX = Math.abs(acc.x - lastX);
    const deltaY = Math.abs(acc.y - lastY);
    const deltaZ = Math.abs(acc.z - lastZ);
    
    if ((deltaX > shakeThreshold || deltaY > shakeThreshold || deltaZ > shakeThreshold)) {
      const now = Date.now();
      if (now - lastShakeTime > 1000) { // Debounce 1 second
        lastShakeTime = now;
        onShake();
      }
    }
    
    lastX = acc.x;
    lastY = acc.y;
    lastZ = acc.z;
  });
}

function onShake() {
  if (navigator.vibrate) navigator.vibrate([50, 50, 50]);
  magicStyleWidgets();
}

// === SWIPE GESTURES ===
function setupSwipeGestures() {
  let touchStartY = 0;
  let touchStartX = 0;
  
  document.addEventListener('touchstart', e => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  
  document.addEventListener('touchend', e => {
    const touchEndX = e.changedTouches[0].clientX;
    const touchEndY = e.changedTouches[0].clientY;
    
    const deltaX = touchEndX - touchStartX;
    const deltaY = touchEndY - touchStartY;
    
    // Only trigger if swipe is significant and more vertical than horizontal
    if (Math.abs(deltaY) > 100 && Math.abs(deltaY) > Math.abs(deltaX)) {
      const runtimeView = $('.runtime-view.active');
      if (runtimeView) {
        if (deltaY < -100) { // Swipe up
          if (!document.body.classList.contains('runtime-fullscreen')) {
            toggleFullscreen();
          }
        } else if (deltaY > 100) { // Swipe down
          if (document.body.classList.contains('runtime-fullscreen')) {
            toggleFullscreen();
          }
        }
      }
    }
  }, { passive: true });
}

function switchTab(tab) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $$('.view').forEach(v => v.classList.remove('active'));
  
  const builderView = $('.builder-view');
  const runtimeView = $('.runtime-view');
  const fullscreenBtn = $('#fullscreenBtn');
  
  if (tab === 'builder') {
    builderView.classList.add('active');
    runtimeView.classList.remove('active');
    stopDemoSim();
    
    // Hide fullscreen button
    if (fullscreenBtn) fullscreenBtn.classList.remove('visible');
    
    // Exit fullscreen mode if active
    if (document.body.classList.contains('runtime-fullscreen')) {
      document.body.classList.remove('runtime-fullscreen');
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    }
    
    // Exit arrange mode when switching to build
    if (state.arrangeMode) {
      state.arrangeMode = false;
      const arrangeBtn = $('#arrangeModeBtn');
      if (arrangeBtn) {
        arrangeBtn.classList.remove('active');
        arrangeBtn.textContent = '📐 Arrange';
      }
      const grid = $('#runtimeGrid');
      if (grid) grid.classList.remove('arrange-mode');
      const hint = $('#arrangeHint');
      if (hint) hint.style.display = 'none';
      
      // Sync any changes made
      syncRuntimeToBuild();
    }
  } else {
    // Runtime tab
    builderView.classList.remove('active');
    runtimeView.classList.add('active');
    
    // IMPORTANT: Build config from current widgets and render before starting demo
    if (state.widgets && state.widgets.length > 0) {
      state.config = { title: $('#titleInput')?.value || 'My Remote', widgets: state.widgets };
      renderRuntime();
    }
    
    startDemoSim();
    
    // If connected via BLE, auto-enter fullscreen
    if (state.ble.connected) {
      setTimeout(() => enterFullscreenAndFit(), 150);
    }
    // If we have a config (from demo), show it
    else if (state.config && state.config.widgets && state.config.widgets.length > 0) {
      $('#connectPrompt').style.display = 'none';
      $('#runtimeContent').style.display = 'flex';
      const arrangeBtn = $('#arrangeModeBtn');
      if (arrangeBtn) arrangeBtn.classList.add('visible');
      if (fullscreenBtn) fullscreenBtn.classList.add('visible');
      
      // Auto-enter fullscreen and zoom to fit
      setTimeout(() => {
        enterFullscreenAndFit();
      }, 100);
    }
    // Otherwise show connect prompt for kids
    else {
      $('#connectPrompt').style.display = 'block';
      $('#runtimeContent').style.display = 'none';
      const arrangeBtn = $('#arrangeModeBtn');
      if (arrangeBtn) arrangeBtn.classList.remove('visible');
      if (fullscreenBtn) fullscreenBtn.classList.remove('visible');
    }
  }
}

// Auto-enter fullscreen and zoom to fit the runtime grid
function enterFullscreenAndFit() {
  const btn = $('#fullscreenBtn');
  const exitBtn = $('#fullscreenExitBtn');
  const grid = $('#runtimeGrid');
  
  if (!grid) return;
  
  // Enter fullscreen mode
  document.body.classList.add('runtime-fullscreen');
  if (btn) {
    btn.classList.remove('visible');
    btn.style.display = 'none';
  }
  
  // Request native fullscreen API
  const elem = document.documentElement;
  if (elem.requestFullscreen) {
    elem.requestFullscreen().catch(() => {});
  } else if (elem.webkitRequestFullscreen) {
    elem.webkitRequestFullscreen();
  } else if (elem.mozRequestFullScreen) {
    elem.mozRequestFullScreen();
  }
  
  // Calculate and apply zoom to fit
  setTimeout(() => {
    zoomToFitScreen();
  }, 150);
}

// Calculate zoom to make runtime grid fill the screen
function zoomToFitScreen() {
  const grid = $('#runtimeGrid');
  if (!grid) return;
  
  const gridW = grid.offsetWidth;
  const gridH = grid.offsetHeight;
  
  // Available screen space
  const availW = window.innerWidth * 0.88;
  const availH = window.innerHeight * 0.82;
  
  // Calculate scale to fit
  const scaleX = availW / gridW;
  const scaleY = availH / gridH;
  const scale = Math.min(scaleX, scaleY, 1.8); // Cap at 1.8x max
  
  // Apply zoom transform
  grid.style.transform = `scale(${scale})`;
  grid.style.transformOrigin = 'center center';
}

// Collision detection helpers
function rectsOverlap(a, b, gap = 4) {
  return !(a.x + a.w + gap <= b.x || b.x + b.w + gap <= a.x || 
           a.y + a.h + gap <= b.y || b.y + b.h + gap <= a.y);
}

function resolveOverlaps(moved) {
  const GAP = 6;
  for (let iter = 0; iter < 20; iter++) {
    let anyOverlap = false;
    for (let i = 0; i < state.widgets.length; i++) {
      for (let j = i + 1; j < state.widgets.length; j++) {
        const a = state.widgets[i], b = state.widgets[j];
        if (a.locked && b.locked) continue;
        if (!rectsOverlap(a, b, GAP)) continue;
        anyOverlap = true;
        const pushed = (moved && a.id === moved.id) ? b : (moved && b.id === moved.id) ? a : (a.locked ? b : a);
        const fixed = pushed === b ? a : b;
        if (pushed.locked) continue;
        const overlapX = (fixed.w/2 + pushed.w/2 + GAP) - Math.abs((fixed.x + fixed.w/2) - (pushed.x + pushed.w/2));
        const overlapY = (fixed.h/2 + pushed.h/2 + GAP) - Math.abs((fixed.y + fixed.h/2) - (pushed.y + pushed.h/2));
        if (overlapX < overlapY) {
          pushed.x = (pushed.x > fixed.x) ? fixed.x + fixed.w + GAP : fixed.x - pushed.w - GAP;
        } else {
          pushed.y = (pushed.y > fixed.y) ? fixed.y + fixed.h + GAP : fixed.y - pushed.h - GAP;
        }
        pushed.x = Math.max(0, pushed.x);
        pushed.y = Math.max(0, pushed.y);
      }
    }
    if (!anyOverlap) break;
  }
  state.widgets.forEach(w => {
    const el = $(`.widget[data-id="${w.id}"]`);
    if (el) { el.style.left = w.x + 'px'; el.style.top = w.y + 'px'; }
  });
  updateCanvasSize();
  updateMinimap();
}

// Undo/Redo system
function saveUndoState() {
  const snapshot = JSON.stringify(state.widgets);
  if (state.undoStack.length && state.undoStack[state.undoStack.length-1] === snapshot) return;
  state.undoStack.push(snapshot);
  if (state.undoStack.length > state.maxUndo) state.undoStack.shift();
  state.redoStack = [];
}

function undo() {
  if (state.undoStack.length < 2) { toast('Nothing to undo', 'error'); return; }
  state.redoStack.push(state.undoStack.pop());
  state.widgets = JSON.parse(state.undoStack[state.undoStack.length-1]);
  state.selected = null;
  state.multiSelect = [];
  renderWidgets();
  renderPropsPanel();
  toast('↩️ Undo', 'success');
}

function redo() {
  if (!state.redoStack.length) { toast('Nothing to redo', 'error'); return; }
  const snapshot = state.redoStack.pop();
  state.undoStack.push(snapshot);
  state.widgets = JSON.parse(snapshot);
  state.selected = null;
  state.multiSelect = [];
  renderWidgets();
  renderPropsPanel();
  toast('↪️ Redo', 'success');
}

// Copy/Paste/Duplicate
function copySelected() {
  const ids = state.multiSelect.length ? state.multiSelect : (state.selected ? [state.selected] : []);
  if (!ids.length) { toast('Select widgets first', 'error'); return; }
  state.clipboard = state.widgets.filter(w => ids.includes(w.id)).map(w => ({...w}));
  toast(`📋 Copied ${state.clipboard.length} widget(s)`, 'success');
}

function pasteWidgets() {
  if (!state.clipboard.length) { toast('Nothing to paste', 'error'); return; }
  saveUndoState();
  const offset = 20;
  state.clipboard.forEach(w => {
    const newW = {...w, id: `${w.t}${state.nextId++}`, x: w.x + offset, y: w.y + offset};
    state.widgets.push(newW);
  });
  resolveOverlaps(null);
  renderWidgets();
  toast(`📋 Pasted ${state.clipboard.length} widget(s)`, 'success');
  saveUndoState();
}

function duplicateSelected() {
  const ids = state.multiSelect.length ? state.multiSelect : (state.selected ? [state.selected] : []);
  if (!ids.length) { toast('Select widgets first', 'error'); return; }
  saveUndoState();
  const toDupe = state.widgets.filter(w => ids.includes(w.id));
  toDupe.forEach(w => {
    const newW = {...w, id: `${w.t}${state.nextId++}`, x: w.x + 20, y: w.y + 20};
    state.widgets.push(newW);
  });
  resolveOverlaps(null);
  renderWidgets();
  toast(`✨ Duplicated ${toDupe.length} widget(s)`, 'success');
  saveUndoState();
}

// === SMART LAYOUT FUNCTIONS ===

// Auto-arrange in grid
function autoArrangeGrid() {
  if (!state.widgets.length) return;
  saveUndoState();
  const cols = Math.ceil(Math.sqrt(state.widgets.length));
  const gap = 10;
  let maxW = 0, maxH = 0;
  state.widgets.forEach(w => { maxW = Math.max(maxW, w.w); maxH = Math.max(maxH, w.h); });
  state.widgets.forEach((w, i) => {
    w.x = (i % cols) * (maxW + gap) + gap;
    w.y = Math.floor(i / cols) * (maxH + gap) + gap;
  });
  renderWidgets();
  toast('⊞ Arranged in grid', 'success');
  saveUndoState();
}

// Auto-arrange in rows
function autoArrangeRows() {
  if (!state.widgets.length) return;
  saveUndoState();
  const gap = 10;
  let y = gap;
  state.widgets.forEach(w => {
    w.x = gap;
    w.y = y;
    y += w.h + gap;
  });
  renderWidgets();
  toast('≡ Arranged in rows', 'success');
  saveUndoState();
}

// Auto-arrange in columns
function autoArrangeCols() {
  if (!state.widgets.length) return;
  saveUndoState();
  const gap = 10;
  let x = gap;
  state.widgets.forEach(w => {
    w.x = x;
    w.y = gap;
    x += w.w + gap;
  });
  renderWidgets();
  toast('⫾ Arranged in columns', 'success');
  saveUndoState();
}

// Distribute horizontally
function distributeH() {
  const ids = state.multiSelect.length ? state.multiSelect : state.widgets.map(w => w.id);
  const ws = state.widgets.filter(w => ids.includes(w.id)).sort((a,b) => a.x - b.x);
  if (ws.length < 3) { toast('Need 3+ widgets', 'error'); return; }
  saveUndoState();
  const first = ws[0], last = ws[ws.length-1];
  const totalSpace = last.x - first.x - first.w;
  const gap = totalSpace / (ws.length - 1);
  let x = first.x + first.w;
  ws.slice(1, -1).forEach(w => { w.x = x + gap - w.w/2 + first.w/2; x += gap; });
  renderWidgets();
  toast('↔ Distributed horizontally', 'success');
  saveUndoState();
}

// Distribute vertically
function distributeV() {
  const ids = state.multiSelect.length ? state.multiSelect : state.widgets.map(w => w.id);
  const ws = state.widgets.filter(w => ids.includes(w.id)).sort((a,b) => a.y - b.y);
  if (ws.length < 3) { toast('Need 3+ widgets', 'error'); return; }
  saveUndoState();
  const first = ws[0], last = ws[ws.length-1];
  const totalSpace = last.y - first.y - first.h;
  const gap = totalSpace / (ws.length - 1);
  let y = first.y + first.h;
  ws.slice(1, -1).forEach(w => { w.y = y + gap - w.h/2 + first.h/2; y += gap; });
  renderWidgets();
  toast('↕ Distributed vertically', 'success');
  saveUndoState();
}

// Align functions
function alignLeft() {
  const ids = state.multiSelect.length ? state.multiSelect : [state.selected];
  const ws = state.widgets.filter(w => ids.includes(w.id));
  if (ws.length < 2) return;
  saveUndoState();
  const minX = Math.min(...ws.map(w => w.x));
  ws.forEach(w => w.x = minX);
  renderWidgets();
  toast('⫷ Aligned left', 'success');
}

function alignRight() {
  const ids = state.multiSelect.length ? state.multiSelect : [state.selected];
  const ws = state.widgets.filter(w => ids.includes(w.id));
  if (ws.length < 2) return;
  saveUndoState();
  const maxX = Math.max(...ws.map(w => w.x + w.w));
  ws.forEach(w => w.x = maxX - w.w);
  renderWidgets();
  toast('⫸ Aligned right', 'success');
}

function alignTop() {
  const ids = state.multiSelect.length ? state.multiSelect : [state.selected];
  const ws = state.widgets.filter(w => ids.includes(w.id));
  if (ws.length < 2) return;
  saveUndoState();
  const minY = Math.min(...ws.map(w => w.y));
  ws.forEach(w => w.y = minY);
  renderWidgets();
  toast('⫠ Aligned top', 'success');
}

function alignBottom() {
  const ids = state.multiSelect.length ? state.multiSelect : [state.selected];
  const ws = state.widgets.filter(w => ids.includes(w.id));
  if (ws.length < 2) return;
  saveUndoState();
  const maxY = Math.max(...ws.map(w => w.y + w.h));
  ws.forEach(w => w.y = maxY - w.h);
  renderWidgets();
  toast('⫟ Aligned bottom', 'success');
}

function alignCenterH() {
  const ids = state.multiSelect.length ? state.multiSelect : [state.selected];
  const ws = state.widgets.filter(w => ids.includes(w.id));
  if (ws.length < 2) return;
  saveUndoState();
  const avgX = ws.reduce((s, w) => s + w.x + w.w/2, 0) / ws.length;
  ws.forEach(w => w.x = avgX - w.w/2);
  renderWidgets();
  toast('⫿ Aligned center H', 'success');
}

function alignCenterV() {
  const ids = state.multiSelect.length ? state.multiSelect : [state.selected];
  const ws = state.widgets.filter(w => ids.includes(w.id));
  if (ws.length < 2) return;
  saveUndoState();
  const avgY = ws.reduce((s, w) => s + w.y + w.h/2, 0) / ws.length;
  ws.forEach(w => w.y = avgY - w.h/2);
  renderWidgets();
  toast('⫿ Aligned center V', 'success');
}

// === THEME FUNCTIONS ===
function setTheme(name) {
  state.theme = name;
  document.body.className = document.body.className.replace(/theme-\w+/g, '');
  if (name !== 'dark') document.body.classList.add('theme-' + name);
  toast(`🎨 Theme: ${name}`, 'success');
  try { localStorage.setItem('widget_theme', name); } catch(e) {}
}

function cycleTheme() {
  const themes = Object.keys(THEMES);
  const idx = (themes.indexOf(state.theme) + 1) % themes.length;
  setTheme(themes[idx]);
}

// === GROUPING ===
function groupSelected() {
  if (state.multiSelect.length < 2) { toast('Select 2+ widgets', 'error'); return; }
  const groupId = 'g' + Date.now();
  state.groups[groupId] = [...state.multiSelect];
  state.widgets.filter(w => state.multiSelect.includes(w.id)).forEach(w => w.groupId = groupId);
  renderWidgets();
  toast(`⚭ Grouped ${state.multiSelect.length} widgets`, 'success');
}

function ungroupSelected() {
  const w = getSelectedWidget();
  if (!w || !w.groupId) { toast('Select a grouped widget', 'error'); return; }
  const gid = w.groupId;
  state.widgets.filter(x => x.groupId === gid).forEach(x => delete x.groupId);
  delete state.groups[gid];
  renderWidgets();
  toast('⚯ Ungrouped', 'success');
}

// === LAYERS ===
function toggleLayers() {
  state.showLayers = !state.showLayers;
  let panel = $('#layersPanel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'layersPanel';
    panel.className = 'layers-panel';
    document.body.appendChild(panel);
  }
  panel.classList.toggle('show', state.showLayers);
  if (state.showLayers) renderLayersPanel();
}

function renderLayersPanel() {
  const panel = $('#layersPanel');
  if (!panel) return;
  panel.innerHTML = `
    <div class="layers-header">Layers <button onclick="toggleLayers()" style="background:none;border:none;color:white;cursor:pointer">✕</button></div>
    <div class="layers-list">${state.widgets.map((w, i) => `
      <div class="layer-item ${w.id === state.selected ? 'selected' : ''}" onclick="state.selected='${w.id}';updateSelectionUI();renderLayersPanel()">
        <span class="layer-icon">${ICONS[w.t]}</span>
        <span>${w.label || w.id}</span>
        <span class="layer-vis visible" onclick="event.stopPropagation();toggleWidgetVis('${w.id}')">👁</span>
      </div>
    `).reverse().join('')}</div>
  `;
}

function toggleWidgetVis(id) {
  const w = state.widgets.find(x => x.id === id);
  if (w) { w.hidden = !w.hidden; renderWidgets(); renderLayersPanel(); }
}

function moveLayerUp() {
  if (!state.selected) return;
  const idx = state.widgets.findIndex(w => w.id === state.selected);
  if (idx < state.widgets.length - 1) {
    [state.widgets[idx], state.widgets[idx+1]] = [state.widgets[idx+1], state.widgets[idx]];
    renderWidgets();
  }
}

function moveLayerDown() {
  if (!state.selected) return;
  const idx = state.widgets.findIndex(w => w.id === state.selected);
  if (idx > 0) {
    [state.widgets[idx], state.widgets[idx-1]] = [state.widgets[idx-1], state.widgets[idx]];
    renderWidgets();
  }
}

// === SHARE/EXPORT ===
function shareURL() {
  const data = { title: $('#titleInput')?.value || 'Remote', widgets: state.widgets };
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(data))));
  const url = location.origin + location.pathname + '?layout=' + encoded;
  navigator.clipboard.writeText(url).then(() => toast('🔗 Link copied!', 'success'));
}

function generateQR() {
  const data = { title: $('#titleInput')?.value || 'Remote', widgets: state.widgets };
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(data))));
  const url = location.origin + location.pathname + '?layout=' + encoded;
  // Using QR code API
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}`;
  
  let modal = $('#shareModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'shareModal';
    modal.className = 'share-modal';
    modal.innerHTML = `<div class="share-content">
      <h3>📱 Scan to Share</h3>
      <img class="share-qr" src="" alt="QR Code">
      <input class="share-link" readonly>
      <button onclick="navigator.clipboard.writeText(this.previousElementSibling.value);toast('Copied!','success')" style="padding:10px 20px;border:none;border-radius:8px;background:var(--accent);cursor:pointer">📋 Copy Link</button>
      <button onclick="this.closest('.share-modal').classList.remove('show')" style="padding:10px 20px;border:none;border-radius:8px;background:rgba(255,255,255,0.1);color:white;cursor:pointer;margin-left:8px">Close</button>
    </div>`;
    document.body.appendChild(modal);
  }
  modal.querySelector('.share-qr').src = qrUrl;
  modal.querySelector('.share-link').value = url;
  modal.classList.add('show');
}

function exportScreenshot() {
  const canvas = $('#canvas');
  if (!canvas) return;
  // Use html2canvas if available, otherwise simple approach
  toast('📸 Preparing screenshot...', 'success');
  import('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.esm.min.js')
    .then(mod => mod.default(canvas))
    .then(c => {
      const link = document.createElement('a');
      link.download = 'remote-layout.png';
      link.href = c.toDataURL();
      link.click();
      toast('📸 Screenshot saved!', 'success');
    })
    .catch(() => toast('Screenshot requires html2canvas', 'error'));
}

// === WIDGET TEMPLATES ===
function saveWidgetTemplate() {
  const ids = state.multiSelect.length ? state.multiSelect : (state.selected ? [state.selected] : []);
  if (!ids.length) { toast('Select widgets first', 'error'); return; }
  const name = prompt('Template name:');
  if (!name) return;
  const widgets = state.widgets.filter(w => ids.includes(w.id)).map(w => ({...w}));
  // Normalize positions
  const minX = Math.min(...widgets.map(w => w.x));
  const minY = Math.min(...widgets.map(w => w.y));
  widgets.forEach(w => { w.x -= minX; w.y -= minY; delete w.id; });
  state.widgetTemplates.push({ name, widgets });
  try { localStorage.setItem('widget_templates', JSON.stringify(state.widgetTemplates)); } catch(e) {}
  toast(`💾 Template "${name}" saved`, 'success');
}

function loadWidgetTemplates() {
  try {
    state.widgetTemplates = JSON.parse(localStorage.getItem('widget_templates') || '[]');
  } catch(e) { state.widgetTemplates = []; }
}

function showTemplateMenu() {
  if (!state.widgetTemplates.length) { toast('No saved templates', 'error'); return; }
  const name = prompt('Templates:\n' + state.widgetTemplates.map((t,i) => `${i+1}. ${t.name}`).join('\n') + '\n\nEnter number:');
  const idx = parseInt(name) - 1;
  if (isNaN(idx) || !state.widgetTemplates[idx]) return;
  saveUndoState();
  const tpl = state.widgetTemplates[idx];
  tpl.widgets.forEach(w => {
    state.widgets.push({ ...w, id: `${w.t}${state.nextId++}`, x: w.x + 20, y: w.y + 20 });
  });
  renderWidgets();
  toast(`📂 Loaded "${tpl.name}"`, 'success');
}

// === RULER ===
function toggleRuler() {
  state.showRuler = !state.showRuler;
  const canvas = $('#canvas');
  let rulerH = canvas.querySelector('.ruler-h');
  let rulerV = canvas.querySelector('.ruler-v');
  
  if (state.showRuler) {
    if (!rulerH) {
      rulerH = document.createElement('div');
      rulerH.className = 'ruler ruler-h';
      canvas.appendChild(rulerH);
    }
    if (!rulerV) {
      rulerV = document.createElement('div');
      rulerV.className = 'ruler ruler-v';
      canvas.appendChild(rulerV);
    }
    // Add marks
    for (let i = 0; i <= 1000; i += 50) {
      const mh = document.createElement('span');
      mh.className = 'ruler-mark';
      mh.style.left = i + 'px';
      mh.textContent = i;
      rulerH.appendChild(mh);
      const mv = document.createElement('span');
      mv.className = 'ruler-mark';
      mv.style.top = i + 'px';
      mv.textContent = i;
      rulerV.appendChild(mv);
    }
    toast('📏 Ruler ON', 'success');
  } else {
    if (rulerH) rulerH.remove();
    if (rulerV) rulerV.remove();
    toast('📏 Ruler OFF', 'success');
  }
}

// === SENSOR SIMULATOR ===
function toggleSensorSim() {
  let sim = $('#sensorSim');
  if (!sim) {
    sim = document.createElement('div');
    sim.id = 'sensorSim';
    sim.className = 'sensor-sim';
    sim.innerHTML = `
      <div class="sensor-group">
        <div class="sensor-label">Accel X</div>
        <input type="range" class="sensor-slider" min="-1024" max="1024" value="0" oninput="simSensor('accelX', this.value)">
        <div class="sensor-value" id="simAccelX">0</div>
      </div>
      <div class="sensor-group">
        <div class="sensor-label">Accel Y</div>
        <input type="range" class="sensor-slider" min="-1024" max="1024" value="0" oninput="simSensor('accelY', this.value)">
        <div class="sensor-value" id="simAccelY">0</div>
      </div>
      <div class="sensor-group">
        <div class="sensor-label">Light</div>
        <input type="range" class="sensor-slider" min="0" max="255" value="128" oninput="simSensor('light', this.value)">
        <div class="sensor-value" id="simLight">128</div>
      </div>
      <div class="sensor-group">
        <div class="sensor-label">Temp</div>
        <input type="range" class="sensor-slider" min="-10" max="50" value="25" oninput="simSensor('temp', this.value)">
        <div class="sensor-value" id="simTemp">25°</div>
      </div>
      <button onclick="$('#sensorSim').classList.remove('show')" style="padding:8px;border:none;border-radius:8px;background:rgba(255,255,255,0.1);color:white;cursor:pointer">✕</button>
    `;
    document.body.appendChild(sim);
  }
  sim.classList.toggle('show');
}

function simSensor(type, value) {
  const el = $(`#sim${type.charAt(0).toUpperCase() + type.slice(1)}`);
  if (el) el.textContent = value + (type === 'temp' ? '°' : '');
  // Could send to widgets that listen to sensors
}

// === LOAD URL LAYOUT ===
function loadURLLayout() {
  const params = new URLSearchParams(location.search);
  const layout = params.get('layout');
  if (layout) {
    try {
      const data = JSON.parse(decodeURIComponent(escape(atob(layout))));
      if (data.widgets) {
        state.widgets = data.widgets.map(w => ({ ...w, id: w.id || `${w.t}${state.nextId++}` }));
        if (data.title && $('#titleInput')) $('#titleInput').value = data.title;
        renderWidgets();
        toast('📂 Layout loaded from URL', 'success');
      }
    } catch(e) { console.error('Failed to load URL layout', e); }
  }
}

// === CANVAS BACKGROUND ===
function setCanvasBackground() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = e => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = ev => {
        state.canvasBg = ev.target.result;
        const canvas = $('#canvas');
        if (canvas) {
          canvas.style.backgroundImage = `url(${state.canvasBg})`;
          canvas.style.backgroundSize = 'cover';
          canvas.style.backgroundPosition = 'center';
        }
        toast('🖼️ Background set', 'success');
      };
      reader.readAsDataURL(file);
    }
  };
  input.click();
}

function clearCanvasBackground() {
  state.canvasBg = null;
  const canvas = $('#canvas');
  if (canvas) {
    canvas.style.backgroundImage = '';
  }
  toast('🖼️ Background cleared', 'success');
}

// === HIGH CONTRAST MODE ===
function toggleHighContrast() {
  document.body.classList.toggle('high-contrast');
  const isHC = document.body.classList.contains('high-contrast');
  toast(isHC ? '◐ High Contrast ON' : '◐ High Contrast OFF', 'success');
  try { localStorage.setItem('high_contrast', isHC ? '1' : '0'); } catch(e) {}
}

// Load high contrast preference
function loadHighContrastPref() {
  try {
    if (localStorage.getItem('high_contrast') === '1') {
      document.body.classList.add('high-contrast');
    }
  } catch(e) {}
}

// === HELP/SHORTCUTS MODAL ===
function showHelp() {
  let modal = $('#helpModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'helpModal';
    modal.className = 'share-modal';
    modal.innerHTML = `<div class="share-content" style="max-width:500px;text-align:left;">
      <h3>⌨️ Keyboard Shortcuts</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px;margin:16px 0;">
        <div><kbd>Ctrl+Z</kbd> Undo</div>
        <div><kbd>Ctrl+Shift+Z</kbd> Redo</div>
        <div><kbd>Ctrl+C</kbd> Copy</div>
        <div><kbd>Ctrl+V</kbd> Paste</div>
        <div><kbd>Ctrl+D</kbd> Duplicate</div>
        <div><kbd>Ctrl+G</kbd> Group</div>
        <div><kbd>Ctrl+S</kbd> Save Template</div>
        <div><kbd>Ctrl+A</kbd> Select All</div>
        <div><kbd>Delete</kbd> Delete</div>
        <div><kbd>Escape</kbd> Deselect</div>
        <div><kbd>G</kbd> Toggle Grid</div>
        <div><kbd>L</kbd> Toggle Layers</div>
        <div><kbd>T</kbd> Cycle Theme</div>
        <div><kbd>Arrow Keys</kbd> Nudge 1px</div>
        <div><kbd>Shift+Arrow</kbd> Nudge 10px</div>
        <div><kbd>Shift+Click</kbd> Multi-select</div>
      </div>
      <h3>🖱️ Mouse Actions</h3>
      <div style="font-size:13px;margin:16px 0;">
        <div>• Shift+Drag on canvas: Selection box</div>
        <div>• Drag widget corner: Resize</div>
        <div>• Click canvas: Place selected widget type</div>
      </div>
      <button onclick="this.closest('.share-modal').classList.remove('show')" style="padding:10px 20px;border:none;border-radius:8px;background:var(--accent);cursor:pointer;width:100%">Got it!</button>
    </div>`;
    document.body.appendChild(modal);
  }
  modal.classList.add('show');
}

// === PIN MAPPING HELPER ===
function showPinMapping() {
  let modal = $('#pinModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'pinModal';
    modal.className = 'share-modal';
    modal.innerHTML = `<div class="share-content" style="max-width:450px;text-align:left;">
      <h3>📌 micro:bit Pin Reference</h3>
      <div style="font-size:13px;margin:16px 0;line-height:1.6;">
        <div><b>P0, P1, P2</b> - Large pins (touch, analog, digital)</div>
        <div><b>P3-P10</b> - LED matrix (shared)</div>
        <div><b>P11</b> - Button B (shared)</div>
        <div><b>P12</b> - Reserved</div>
        <div><b>P13-P15</b> - SPI (SCK, MISO, MOSI)</div>
        <div><b>P16</b> - General purpose</div>
        <div><b>P19, P20</b> - I2C (SCL, SDA)</div>
      </div>
      <h4>Common Uses:</h4>
      <div style="font-size:12px;margin:8px 0;opacity:0.8;">
        • Servo: P0, P1, P2 (PWM)<br>
        • LED Strip: P0 (NeoPixels)<br>
        • Sensor: P0-P2 (analog read)<br>
        • Motor: P0+P8 or P1+P12 (H-bridge)
      </div>
      <button onclick="this.closest('.share-modal').classList.remove('show')" style="padding:10px 20px;border:none;border-radius:8px;background:var(--accent);cursor:pointer;width:100%">Close</button>
    </div>`;
    document.body.appendChild(modal);
  }
  modal.classList.add('show');
}

// Grid snapping
function snapToGrid(val) {
  if (!state.gridSnap) return val;
  return Math.round(val / state.gridSize) * state.gridSize;
}

// Alignment guides
function showAlignGuides(w) {
  removeAlignGuides();
  if (!state.showGuides) return;
  const canvas = $('#canvas');
  const guides = [];
  const SNAP_DIST = 5;
  
  state.widgets.forEach(other => {
    if (other.id === w.id) return;
    // Vertical guides (left, center, right alignment)
    if (Math.abs(w.x - other.x) < SNAP_DIST) guides.push({type:'v', pos: other.x});
    if (Math.abs(w.x + w.w - other.x - other.w) < SNAP_DIST) guides.push({type:'v', pos: other.x + other.w});
    if (Math.abs(w.x + w.w/2 - other.x - other.w/2) < SNAP_DIST) guides.push({type:'v', pos: other.x + other.w/2});
    // Horizontal guides
    if (Math.abs(w.y - other.y) < SNAP_DIST) guides.push({type:'h', pos: other.y});
    if (Math.abs(w.y + w.h - other.y - other.h) < SNAP_DIST) guides.push({type:'h', pos: other.y + other.h});
    if (Math.abs(w.y + w.h/2 - other.y - other.h/2) < SNAP_DIST) guides.push({type:'h', pos: other.y + other.h/2});
  });
  
  guides.forEach(g => {
    const el = document.createElement('div');
    el.className = 'align-guide ' + (g.type === 'h' ? 'horizontal' : 'vertical');
    el.style[g.type === 'h' ? 'top' : 'left'] = g.pos + 'px';
    canvas.appendChild(el);
  });
}

function removeAlignGuides() {
  $$('.align-guide').forEach(el => el.remove());
}

// Canvas auto-expand
function updateCanvasSize() {
  const canvas = $('#canvas');
  if (!canvas) return;
  let maxX = 400, maxY = 300;
  state.widgets.forEach(w => {
    maxX = Math.max(maxX, w.x + w.w + 40);
    maxY = Math.max(maxY, w.y + w.h + 40);
  });
  canvas.style.minWidth = maxX + 'px';
  canvas.style.minHeight = maxY + 'px';
}

// Minimap
function updateMinimap() {
  const minimap = $('#minimap');
  if (!minimap) return;
  const canvas = $('#canvas');
  if (!canvas) return;
  
  const scale = 0.1;
  minimap.innerHTML = '';
  
  state.widgets.forEach(w => {
    const el = document.createElement('div');
    el.className = 'minimap-widget';
    el.style.cssText = `left:${w.x*scale}px;top:${w.y*scale}px;width:${Math.max(4,w.w*scale)}px;height:${Math.max(4,w.h*scale)}px;background:${w.color || 'var(--accent)'}`;
    minimap.appendChild(el);
  });
}

// Zoom
function setZoom(z) {
  state.zoom = Math.max(0.5, Math.min(2, z));
  const layer = $('#widgetsLayer');
  if (layer) layer.style.transform = `scale(${state.zoom})`;
  const zoomEl = $('#zoomLevel');
  if (zoomEl) zoomEl.textContent = Math.round(state.zoom * 100) + '%';
}

// Nudge with arrow keys
function nudgeSelected(dx, dy) {
  const ids = state.multiSelect.length ? state.multiSelect : (state.selected ? [state.selected] : []);
  if (!ids.length) return;
  saveUndoState();
  state.widgets.filter(w => ids.includes(w.id) && !w.locked).forEach(w => {
    w.x = Math.max(0, w.x + dx);
    w.y = Math.max(0, w.y + dy);
  });
  resolveOverlaps(null);
  renderWidgets();
}

// Setup canvas tools UI
function setupCanvasTools() {
  const canvas = $('#canvas');
  if (!canvas) return;

  // Our helper tools live in the draggable Helper Panel UI
  try { ensureHelperUI(); } catch(e) {}
}

function startSelectionBox(e) {
  const canvas = $('#canvas');
  const rect = canvas.getBoundingClientRect();
  selBoxStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  selectionBox = document.createElement('div');
  selectionBox.className = 'selection-box';
  canvas.appendChild(selectionBox);
}

function updateSelectionBox(e) {
  if (!selectionBox || !selBoxStart) return;
  const canvas = $('#canvas');
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const left = Math.min(x, selBoxStart.x);
  const top = Math.min(y, selBoxStart.y);
  const width = Math.abs(x - selBoxStart.x);
  const height = Math.abs(y - selBoxStart.y);
  selectionBox.style.cssText = `left:${left}px;top:${top}px;width:${width}px;height:${height}px`;
}

function endSelectionBox() {
  if (!selectionBox || !selBoxStart) return;
  const box = selectionBox.getBoundingClientRect();
  const canvas = $('#canvas');
  const cRect = canvas.getBoundingClientRect();
  
  const boxLeft = box.left - cRect.left;
  const boxTop = box.top - cRect.top;
  const boxRight = boxLeft + box.width;
  const boxBottom = boxTop + box.height;
  
  state.multiSelect = state.widgets.filter(w => {
    return w.x < boxRight && w.x + w.w > boxLeft && w.y < boxBottom && w.y + w.h > boxTop;
  }).map(w => w.id);
  
  selectionBox.remove();
  selectionBox = null;
  selBoxStart = null;
  updateSelectionUI();
  if (state.multiSelect.length) toast(`Selected ${state.multiSelect.length} widgets`, 'success');
}

// Auto-resize canvas based on widget positions
function autoResizeCanvas() {
  const canvas = $('#canvas');
  if (!canvas || !state.widgets.length) return;
  
  // Calculate needed size based on widget positions
  let maxX = 0, maxY = 0;
  state.widgets.forEach(w => {
    maxX = Math.max(maxX, w.x + w.w + 20);
    maxY = Math.max(maxY, w.y + w.h + 20);
  });
  
  // Minimum size, no maximum - let it grow as needed
  const minW = 400;
  const minH = 300;
  
  const newW = Math.max(minW, maxX);
  const newH = Math.max(minH, maxY);
  canvas.style.minWidth = newW + 'px';
  canvas.style.minHeight = newH + 'px';
}

function renderWidgets() {
  const layer = $('#widgetsLayer');
  layer.innerHTML = '';
  
  setupCanvasTools();
  
  state.widgets.forEach(w => {
    const el = document.createElement('div');
    const isMulti = state.multiSelect.includes(w.id);
    el.className = 'widget' + (state.selected === w.id ? ' selected' : '') + (isMulti ? ' multi-selected' : '') + (w.locked ? ' locked' : '') + (w.hidden ? ' hidden' : '') + (w.groupId ? ' grouped' : '');
    el.dataset.id = w.id;
    
    // Build style with all properties
    let styles = `left:${w.x}px;top:${w.y}px;width:${w.w}px;height:${w.h}px`;
    if (w.borderStyle) styles += `;border-style:${w.borderStyle}`;
    if (w.borderRadius !== undefined) styles += `;border-radius:${w.borderRadius}px`;
    if (w.shadow === 'soft') styles += `;box-shadow:0 10px 30px rgba(0,0,0,0.3)`;
    else if (w.shadow === 'glow') styles += `;box-shadow:0 0 30px ${w.color || 'var(--accent)'}`;
    else if (w.shadow === 'neon') styles += `;box-shadow:0 0 20px ${w.color || '#ff00ff'}, 0 0 40px ${w.color || '#ff00ff'}`;
    if (w.hidden) styles += `;display:none`;
    el.style.cssText = styles;
    
    let colorDot = w.color ? `<div class="widget-color-dot" style="background:${w.color}"></div>` : '';
    // Add orientation indicator for sliders
    let orientIndicator = '';
    if (w.t === 'slider') {
      const isVertical = (w.h || 100) > (w.w || 100);
      orientIndicator = `<div class="widget-orient-badge">${isVertical ? '↕' : '↔'}</div>`;
    }
    const resizeHandles = `
      <div class="resize-handle handle-n"></div>
      <div class="resize-handle handle-s"></div>
      <div class="resize-handle handle-e"></div>
      <div class="resize-handle handle-w"></div>
      <div class="resize-handle handle-ne"></div>
      <div class="resize-handle handle-nw"></div>
      <div class="resize-handle handle-se"></div>
      <div class="resize-handle handle-sw"></div>
    `;
    el.innerHTML = `${colorDot}<div class="widget-icon">${ICONS[w.t]}</div><div class="widget-label">${esc(w.label) || w.t}</div>${orientIndicator}${resizeHandles}`;
    layer.appendChild(el);
    
    if (!w.locked) {
      interact(el).draggable({
        inertia: false,
        listeners: {
          start() { 
            saveUndoState();
            state.selected = w.id; 
            updateSelectionUI(); 
          },
          move(e) {
            state.justDragged = true;
            clearTimeout(state._dragT);
            state._dragT = setTimeout(() => state.justDragged = false, 50);
            
            let newX = w.x + e.dx;
            let newY = w.y + e.dy;
            
            if (state.gridSnap) {
              newX = snapToGrid(newX);
              newY = snapToGrid(newY);
            }
            
            // Clamp to canvas bounds
            const canvas = $('#canvas');
            const maxX = (canvas?.offsetWidth || 500) - w.w - 10;
            const maxY = (canvas?.offsetHeight || 400) - w.h - 10;
            
            w.x = Math.max(0, Math.min(maxX, newX));
            w.y = Math.max(0, Math.min(maxY, newY));
            e.target.style.left = w.x + 'px';
            e.target.style.top = w.y + 'px';
            
            showAlignGuides(w);
            resolveOverlaps(w);
            autoResizeCanvas();
          },
          end() {
            removeAlignGuides();
            autoResizeCanvas();
            scheduleAutoSave();
          }
        }
      }).resizable({
        edges: { 
          top: '.handle-n, .handle-ne, .handle-nw',
          bottom: '.handle-s, .handle-se, .handle-sw',
          left: '.handle-w, .handle-nw, .handle-sw',
          right: '.handle-e, .handle-ne, .handle-se'
        },
        modifiers: [interact.modifiers.restrictSize({ min: { width: 60, height: 60 } })],
        listeners: {
          start() { saveUndoState(); },
          move(e) {
            // Handle position changes from top/left edges
            let newX = w.x + (e.deltaRect.left || 0);
            let newY = w.y + (e.deltaRect.top || 0);
            let newW = state.gridSnap ? snapToGrid(e.rect.width) : e.rect.width;
            let newH = state.gridSnap ? snapToGrid(e.rect.height) : e.rect.height;
            
            // Clamp to canvas
            const canvas = $('#canvas');
            const canvasW = canvas?.offsetWidth || 500;
            const canvasH = canvas?.offsetHeight || 400;
            
            // Ensure widget stays in bounds
            newX = Math.max(0, Math.min(canvasW - 60, newX));
            newY = Math.max(0, Math.min(canvasH - 60, newY));
            newW = Math.max(60, Math.min(canvasW - newX - 5, newW));
            newH = Math.max(60, Math.min(canvasH - newY - 5, newH));
            
            w.x = newX;
            w.y = newY;
            w.w = newW;
            w.h = newH;
            
            e.target.style.left = w.x + 'px';
            e.target.style.top = w.y + 'px';
            e.target.style.width = w.w + 'px';
            e.target.style.height = w.h + 'px';
            resolveOverlaps(w);
          },
          end() { autoResizeCanvas(); scheduleAutoSave(); }
        }
      });
    }
    
    el.onclick = e => { 
      e.stopPropagation(); 
      if (e.shiftKey) {
        // Multi-select with shift
        if (state.multiSelect.includes(w.id)) {
          state.multiSelect = state.multiSelect.filter(id => id !== w.id);
        } else {
          state.multiSelect.push(w.id);
        }
      } else {
        state.multiSelect = [];
        state.selected = w.id; 
      }
      updateSelectionUI(); 
    };
  });
  
  resolveOverlaps(null);
  updateMinimap();
  saveUndoState();
  
  // Auto-save project
  scheduleAutoSave();
}


function updateSelectionUI() {
  $$('.widget').forEach(el => {
    const id = el.dataset.id;
    el.classList.toggle('selected', id === state.selected);
    el.classList.toggle('multi-selected', state.multiSelect.includes(id));
  });
  renderPropsPanel();
}

function getSelectedWidget(){
  return state.widgets.find(w => w.id === state.selected);
}

function renderPropsPanel(){
  const form = $('#propsForm');
  const empty = $('#propsEmpty');
  const w = getSelectedWidget();

  if (!form || !empty) return;

  if (!w){
    empty.style.display = 'block';
    form.style.display = 'none';
    form.innerHTML = '';
    // Hide mobile panel when no widget selected
    if (typeof hideMobilePropsPanel === 'function') hideMobilePropsPanel();
    return;
  }

  empty.style.display = 'none';
  form.style.display = 'block';
  
  // Show mobile panel when widget is selected
  if (typeof showMobilePropsPanel === 'function') showMobilePropsPanel();

  // Common fields
  let html = `
    <label>Widget ID</label>
    <input id="prop_id" value="${esc(w.id)}" />

    <label>Label</label>
    <input id="prop_label" value="${esc(w.label || '')}" />

    <label>Widget Color</label>
    <input id="prop_color" type="color" value="${w.color || '#00d4ff'}" />

    <label>Lock Position</label>
    <select id="prop_locked">
      <option value="0" ${!w.locked ? 'selected' : ''}>Unlocked</option>
      <option value="1" ${w.locked ? 'selected' : ''}>Locked 🔒</option>
    </select>

    <label>Border Style</label>
    <select id="prop_borderStyle">
      <option value="solid" ${(w.borderStyle || 'solid') === 'solid' ? 'selected' : ''}>Solid</option>
      <option value="dashed" ${w.borderStyle === 'dashed' ? 'selected' : ''}>Dashed</option>
      <option value="dotted" ${w.borderStyle === 'dotted' ? 'selected' : ''}>Dotted</option>
      <option value="none" ${w.borderStyle === 'none' ? 'selected' : ''}>None</option>
    </select>

    <label>Shadow/Glow</label>
    <select id="prop_shadow">
      <option value="none" ${!w.shadow ? 'selected' : ''}>None</option>
      <option value="soft" ${w.shadow === 'soft' ? 'selected' : ''}>Soft Shadow</option>
      <option value="glow" ${w.shadow === 'glow' ? 'selected' : ''}>Glow ✨</option>
      <option value="neon" ${w.shadow === 'neon' ? 'selected' : ''}>Neon 🌈</option>
    </select>

    <label>Border Radius</label>
    <input id="prop_radius" type="range" min="0" max="50" value="${w.borderRadius ?? 16}" />

    <label>📐 Size & Orientation</label>
    <div class="props-row" style="gap:8px; margin-top:6px;">
      <div style="flex:1;">
        <label style="font-size:0.7rem; margin:0;">Width</label>
        <input id="prop_width" type="number" min="40" max="600" value="${w.w || 100}" style="width:100%;" />
      </div>
      <div style="flex:1;">
        <label style="font-size:0.7rem; margin:0;">Height</label>
        <input id="prop_height" type="number" min="40" max="600" value="${w.h || 100}" style="width:100%;" />
      </div>
    </div>
    <div class="props-row" style="gap:8px; margin-top:8px;">
      <button class="props-apply" id="prop_swapOrientation" style="flex:1; margin:0;">🔄 Swap W↔H</button>
      <button class="props-apply" id="prop_resetSize" style="flex:1; margin:0;">↩️ Reset</button>
    </div>
    <div class="props-row" style="gap:4px; margin-top:8px; flex-wrap:wrap;">
      <button class="props-apply prop-preset-size" data-w="80" data-h="80" style="flex:1; margin:0; min-width:60px; padding:8px 4px; font-size:0.75rem;">S</button>
      <button class="props-apply prop-preset-size" data-w="120" data-h="120" style="flex:1; margin:0; min-width:60px; padding:8px 4px; font-size:0.75rem;">M</button>
      <button class="props-apply prop-preset-size" data-w="180" data-h="180" style="flex:1; margin:0; min-width:60px; padding:8px 4px; font-size:0.75rem;">L</button>
      <button class="props-apply prop-preset-size" data-w="250" data-h="250" style="flex:1; margin:0; min-width:60px; padding:8px 4px; font-size:0.75rem;">XL</button>
    </div>
  `;

  // Model selector (3 presets per widget type)
  const opts = modelOptionsForType(w.t);
  if (opts){
    html += `
      <label>Model</label>
      <select id="prop_model">
        ${opts.map(o => `<option value="${o.v}" ${w.model === o.v ? 'selected' : ''}>${o.name}</option>`).join('')}
      </select>
      <button class="props-apply" id="prop_applyAll">Apply this model to ALL ${w.t}s</button>
    `;
  }

  // Type-specific fields
  if (w.t === 'led'){
    html += `
      <label>LED On Color</label>
      <input id="prop_colorOn" type="color" value="${w.colorOn || '#ff5252'}" />

      <label>LED Off Color</label>
      <input id="prop_colorOff" type="color" value="${w.colorOff || '#2a2a3a'}" />
    `;
  }

  if (w.t === 'slider'){
    const isVertical = (w.h || 100) > (w.w || 100);
    html += `
      <label>🔄 Orientation</label>
      <select id="prop_sliderOrient">
        <option value="horizontal" ${!isVertical ? 'selected' : ''}>↔ Horizontal</option>
        <option value="vertical" ${isVertical ? 'selected' : ''}>↕ Vertical</option>
      </select>

      <label>Min</label>
      <input id="prop_min" type="number" value="${w.min ?? 0}" />

      <label>Max</label>
      <input id="prop_max" type="number" value="${w.max ?? 100}" />

      <label>Step</label>
      <input id="prop_step" type="number" value="${w.step ?? 1}" />
    `;
  }

  
  if (w.t === 'gauge'){
    html += `
      <label>Min</label>
      <input id="prop_gmin" type="number" value="${w.min ?? 0}" />

      <label>Max</label>
      <input id="prop_gmax" type="number" value="${w.max ?? 100}" />

      <label>Decimals</label>
      <input id="prop_gdec" type="number" value="${w.decimals ?? 0}" />

      <label>Units (optional)</label>
      <input id="prop_gunits" value="${esc(w.units || '')}" />

      <label>Warn (optional)</label>
      <input id="prop_gwarn" type="number" value="${w.warn ?? ''}" />

      <label>Danger (optional)</label>
      <input id="prop_gdanger" type="number" value="${w.danger ?? ''}" />
    `;
  }

  if (w.t === 'graph'){
    html += `
      <label>Series (1-10)</label>
      <input id="prop_series" type="number" min="1" max="10" value="${w.series ?? 1}" />

      <label>Window (seconds)</label>
      <input id="prop_window" type="number" min="5" max="120" value="${w.windowSec ?? 30}" />

      <label>Auto scale</label>
      <select id="prop_autoscale">
        <option value="1" ${w.autoScale !== false ? 'selected' : ''}>Yes</option>
        <option value="0" ${w.autoScale === false ? 'selected' : ''}>No</option>
      </select>

      <label>Fixed Min (when auto off)</label>
      <input id="prop_ymin" type="number" value="${w.yMin ?? 0}" />

      <label>Fixed Max (when auto off)</label>
      <input id="prop_ymax" type="number" value="${w.yMax ?? 100}" />

      <label>Series Names (comma separated)</label>
      <input id="prop_names" value="${esc((w.seriesNames || '').toString())}" placeholder="Temp,Level,Power" />

      <label>Y Axis Label (optional)</label>
      <input id="prop_ylabel" value="${esc(w.yLabel || '')}" placeholder="°C / % / rpm" />
    `;
  }

  if (w.t === 'image'){
    html += `
      <label>Image URL</label>
      <input id="prop_imageSrc" value="${esc(w.imageSrc || '')}" placeholder="https://..." />
      <button class="props-apply" id="prop_uploadImg">📁 Upload Image</button>
    `;
  }

  if (w.t === 'battery'){
    html += `
      <label>Initial Level (%)</label>
      <input id="prop_batteryLevel" type="number" min="0" max="100" value="${w.level ?? 100}" />
    `;
  }

  if (w.t === 'timer'){
    html += `
      <label>Count Direction</label>
      <select id="prop_timerDir">
        <option value="up" ${(w.timerDir || 'up') === 'up' ? 'selected' : ''}>Count Up ⏱️</option>
        <option value="down" ${w.timerDir === 'down' ? 'selected' : ''}>Countdown ⏳</option>
      </select>
      <label>Initial Seconds (for countdown)</label>
      <input id="prop_timerStart" type="number" min="0" value="${w.timerStart ?? 60}" />
    `;
  }

form.innerHTML = html;

  // Wire events
  $('#prop_label').oninput = e => {
    w.label = e.target.value;
    const el = $(`.widget[data-id="${w.id}"] .widget-label`);
    if (el) el.textContent = w.label || w.t;
  };

  $('#prop_color').oninput = e => {
    w.color = e.target.value;
    const dot = $(`.widget[data-id="${w.id}"] .widget-color-dot`);
    if (dot) dot.style.background = w.color;
    else renderWidgets();
    updateMinimap();
  };

  $('#prop_locked').onchange = e => {
    w.locked = e.target.value === '1';
    renderWidgets();
    toast(w.locked ? '🔒 Widget locked' : '🔓 Widget unlocked', 'success');
  };

  $('#prop_borderStyle').onchange = e => {
    w.borderStyle = e.target.value;
    const el = $(`.widget[data-id="${w.id}"]`);
    if (el) el.style.borderStyle = w.borderStyle;
  };

  $('#prop_shadow').onchange = e => {
    w.shadow = e.target.value;
    const el = $(`.widget[data-id="${w.id}"]`);
    if (el) {
      if (w.shadow === 'soft') el.style.boxShadow = '0 10px 30px rgba(0,0,0,0.3)';
      else if (w.shadow === 'glow') el.style.boxShadow = `0 0 30px ${w.color || 'var(--accent)'}`;
      else if (w.shadow === 'neon') el.style.boxShadow = `0 0 20px ${w.color || '#ff00ff'}, 0 0 40px ${w.color || '#ff00ff'}`;
      else el.style.boxShadow = '';
    }
  };

  $('#prop_radius').oninput = e => {
    w.borderRadius = parseInt(e.target.value);
    const el = $(`.widget[data-id="${w.id}"]`);
    if (el) el.style.borderRadius = w.borderRadius + 'px';
  };

  // Size and orientation controls
  const widthInput = $('#prop_width');
  const heightInput = $('#prop_height');
  
  if (widthInput) {
    widthInput.oninput = e => {
      const newW = Math.max(40, Math.min(600, parseInt(e.target.value) || 100));
      w.w = newW;
      const el = $(`.widget[data-id="${w.id}"]`);
      if (el) el.style.width = w.w + 'px';
      resolveOverlaps(w);
      updateMinimap();
    };
  }
  
  if (heightInput) {
    heightInput.oninput = e => {
      const newH = Math.max(40, Math.min(600, parseInt(e.target.value) || 100));
      w.h = newH;
      const el = $(`.widget[data-id="${w.id}"]`);
      if (el) el.style.height = w.h + 'px';
      resolveOverlaps(w);
      updateMinimap();
    };
  }
  
  const swapBtn = $('#prop_swapOrientation');
  if (swapBtn) {
    swapBtn.onclick = () => {
      saveUndoState();
      const oldW = w.w;
      const oldH = w.h;
      w.w = oldH;
      w.h = oldW;
      // Update inputs
      if (widthInput) widthInput.value = w.w;
      if (heightInput) heightInput.value = w.h;
      // Update widget visual
      const el = $(`.widget[data-id="${w.id}"]`);
      if (el) {
        el.style.width = w.w + 'px';
        el.style.height = w.h + 'px';
      }
      resolveOverlaps(w);
      updateMinimap();
      toast('🔄 Orientation swapped!', 'success');
    };
  }
  
  const resetBtn = $('#prop_resetSize');
  if (resetBtn) {
    resetBtn.onclick = () => {
      saveUndoState();
      const defaults = SIZES[w.t] || [100, 100];
      w.w = defaults[0];
      w.h = defaults[1];
      // Update inputs
      if (widthInput) widthInput.value = w.w;
      if (heightInput) heightInput.value = w.h;
      // Update widget visual
      const el = $(`.widget[data-id="${w.id}"]`);
      if (el) {
        el.style.width = w.w + 'px';
        el.style.height = w.h + 'px';
      }
      resolveOverlaps(w);
      updateMinimap();
      toast('↩️ Size reset to default!', 'success');
    };
  }
  
  // Preset size buttons
  $$('.prop-preset-size').forEach(btn => {
    btn.onclick = () => {
      saveUndoState();
      const presetW = parseInt(btn.dataset.w) || 100;
      const presetH = parseInt(btn.dataset.h) || 100;
      w.w = presetW;
      w.h = presetH;
      // Update inputs
      if (widthInput) widthInput.value = w.w;
      if (heightInput) heightInput.value = w.h;
      // Update widget visual
      const el = $(`.widget[data-id="${w.id}"]`);
      if (el) {
        el.style.width = w.w + 'px';
        el.style.height = w.h + 'px';
      }
      resolveOverlaps(w);
      updateMinimap();
      toast(`📐 Size set to ${presetW}×${presetH}`, 'success');
    };
  });

  $('#prop_id').onchange = e => {
    const newId = e.target.value.trim();
    if (!newId || state.widgets.some(x => x.id === newId && x !== w)){
      toast('❌ ID must be unique', 'error');
      e.target.value = w.id;
      return;
    }
    const oldId = w.id;
    w.id = newId;

    const root = $(`.widget[data-id="${oldId}"]`);
    if (root) root.dataset.id = newId;

    if (state.values[oldId] != null){
      state.values[newId] = state.values[oldId];
      delete state.values[oldId];
    }

    state.selected = newId;
    updateSelectionUI();
    toast('✅ ID updated', 'success');
  };

  // Model wiring (and quick apply to all widgets of same type)
  const modelSel = $('#prop_model');
  if (modelSel){
    modelSel.onchange = e => { w.model = e.target.value; toast('✅ Model updated', 'success'); };
  }
  const applyBtn = $('#prop_applyAll');
  if (applyBtn){
    applyBtn.onclick = () => {
      const val = w.model;
      state.widgets.forEach(x => { if (x.t === w.t) x.model = val; });
      if (state.config?.widgets) state.config.widgets.forEach(x => { if (x.t === w.t) x.model = val; });
      renderWidgets();
      if (state.config) renderRuntime();
      toast(`✨ Applied model to all ${w.t}s`, 'success');
    };
  }


  if (w.t === 'led'){
    $('#prop_colorOn').oninput = e => { w.colorOn = e.target.value; };
    $('#prop_colorOff').oninput = e => { w.colorOff = e.target.value; };
  }

  if (w.t === 'slider'){
    const orientSel = $('#prop_sliderOrient');
    if (orientSel) {
      orientSel.onchange = e => {
        saveUndoState();
        const isVertical = e.target.value === 'vertical';
        const currentW = w.w || 100;
        const currentH = w.h || 100;
        
        // If orientation doesn't match current dimensions, swap them
        const currentIsVertical = currentH > currentW;
        if (isVertical !== currentIsVertical) {
          w.w = currentH;
          w.h = currentW;
          // Update the width/height inputs
          const widthInput = $('#prop_width');
          const heightInput = $('#prop_height');
          if (widthInput) widthInput.value = w.w;
          if (heightInput) heightInput.value = w.h;
        }
        
        renderWidgets();
        updateMinimap();
        toast(isVertical ? '↕ Slider set to vertical' : '↔ Slider set to horizontal', 'success');
      };
    }
    $('#prop_min').oninput = e => { w.min = parseFloat(e.target.value); };
    $('#prop_max').oninput = e => { w.max = parseFloat(e.target.value); };
    $('#prop_step').oninput = e => { w.step = parseFloat(e.target.value); };
  }

  if (w.t === 'gauge'){
    $('#prop_gmin').oninput = e => { w.min = parseFloat(e.target.value); if (state.config) renderRuntime(); };
    $('#prop_gmax').oninput = e => { w.max = parseFloat(e.target.value); if (state.config) renderRuntime(); };
    $('#prop_gdec').oninput = e => { w.decimals = parseInt(e.target.value, 10); if (state.config) renderRuntime(); };
    $('#prop_gunits').oninput = e => { w.units = e.target.value; if (state.config) renderRuntime(); };
    $('#prop_gwarn').oninput = e => { w.warn = e.target.value === '' ? null : parseFloat(e.target.value); };
    $('#prop_gdanger').oninput = e => { w.danger = e.target.value === '' ? null : parseFloat(e.target.value); };
  }

  if (w.t === 'graph'){
    $('#prop_series').oninput = e => { w.series = Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 1)); if (state.config) renderRuntime(); };
    $('#prop_window').oninput = e => { w.windowSec = Math.max(5, parseInt(e.target.value, 10) || 30); };
    $('#prop_autoscale').onchange = e => { w.autoScale = (e.target.value === '1'); };
    $('#prop_ymin').oninput = e => { w.yMin = parseFloat(e.target.value); };
    $('#prop_ymax').oninput = e => { w.yMax = parseFloat(e.target.value); };
    $('#prop_names').oninput = e => { w.seriesNames = e.target.value; if (state.config) renderRuntime(); };
    $('#prop_ylabel').oninput = e => { w.yLabel = e.target.value; };
  }

  if (w.t === 'image'){
    $('#prop_imageSrc').oninput = e => { w.imageSrc = e.target.value; renderWidgets(); };
    const uploadBtn = $('#prop_uploadImg');
    if (uploadBtn) {
      uploadBtn.onclick = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = e => {
          const file = e.target.files[0];
          if (file) {
            const reader = new FileReader();
            reader.onload = ev => {
              w.imageSrc = ev.target.result;
              $('#prop_imageSrc').value = '[Uploaded Image]';
              renderWidgets();
              toast('🖼️ Image uploaded', 'success');
            };
            reader.readAsDataURL(file);
          }
        };
        input.click();
      };
    }
  }

  if (w.t === 'battery'){
    const battInput = $('#prop_batteryLevel');
    if (battInput) battInput.oninput = e => { w.level = parseInt(e.target.value); };
  }

  if (w.t === 'timer'){
    const timerDir = $('#prop_timerDir');
    if (timerDir) timerDir.onchange = e => { w.timerDir = e.target.value; };
    const timerStart = $('#prop_timerStart');
    if (timerStart) timerStart.oninput = e => { w.timerStart = parseInt(e.target.value); };
  }

}


function deleteSelected() {
  if (!state.selected) { toast('👆 Select a widget first!', 'error'); return; }
  saveUndoState();
  state.widgets = state.widgets.filter(w => w.id !== state.selected);
  state.selected = null;
  renderWidgets();
  renderPropsPanel();
  toast('🗑️ Deleted!', 'success');
  saveUndoState();
}

function showCode() {
  if (state.widgets.length === 0) {
    toast('👆 Add some widgets first!', 'error');
    return;
  }
  const cfg = { title: $('#titleInput').value || 'My Remote', widgets: state.widgets };
  $('#modalTitle').innerHTML = '📄 Your micro:bit Code <small style="display:block;font-size:0.7rem;font-weight:400;opacity:0.7;margin-top:4px;">Copy to MakeCode or click ⚡Flash to send directly to micro:bit via Bluetooth</small>';
  $('#modalCode').textContent = generateDemoCode(cfg);
  // Reset flash progress
  const progressEl = $('#flashProgress');
  if (progressEl) progressEl.style.display = 'none';
  $('#modalBg').classList.add('show');
}

function downloadCode() {
  const blob = new Blob([$('#modalCode').textContent], { type: 'text/plain' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'microbit-remote.ts'; a.click();
  toast('💾 Downloaded!', 'success');
}

function toast(msg, type = '') {
  const t = $('#toast'); t.textContent = msg;
  t.className = `toast ${type} show`;
  setTimeout(() => t.classList.remove('show'), 2500);
}



function showBuildOverlay(sub='✨ Building...'){
  const ov = $('#loadingOverlay');
  if (!ov) return;
  ov.classList.add('show');
  ov.setAttribute('aria-hidden','false');
  const subEl = $('#loadingSub'); if (subEl) subEl.textContent = sub;
  const pctEl = $('#loadingPct'); if (pctEl) pctEl.textContent = '';
  const bar = $('#loadingBarFill'); if (bar) bar.style.width = '100%';
}

// Loading overlay helpers
let _loadingIndeterminate = null;
function showLoading(title = '🧩 Loading your remote...', sub = 'Getting layout from micro:bit'){
  if (!state._allowLoadingOverlay) return;
  const ov = $('#loadingOverlay');
  if (!ov) return;
  ov.classList.add('show');
  ov.setAttribute('aria-hidden','false');
  const subEl = $('#loadingSub'); if (subEl) subEl.textContent = sub;
  const pctEl = $('#loadingPct'); if (pctEl) pctEl.textContent = '0%';
  const bar = $('#loadingBarFill'); if (bar) bar.style.width = '8%';

  clearInterval(_loadingIndeterminate);
  // fun, kid-friendly "wiggle" while chunks arrive
  let p = 8; let dir = 1;
  _loadingIndeterminate = setInterval(() => {
    p += dir * 3;
    if (p > 22) { p = 22; dir = -1; }
    if (p < 8)  { p = 8;  dir = 1; }
    if (bar) bar.style.width = p + '%';
  }, 220);
}

function setLoadingProgress(pct, sub){
  const bar = $('#loadingBarFill');
  const pctEl = $('#loadingPct');
  const subEl = $('#loadingSub');
  if (subEl && sub) subEl.textContent = sub;
  const clamped = Math.max(0, Math.min(100, pct));
  if (bar) bar.style.width = clamped + '%';
  if (pctEl) pctEl.textContent = Math.round(clamped) + '%';
}

function hideLoading(){
  const ov = $('#loadingOverlay');
  if (!ov) return;
  clearInterval(_loadingIndeterminate);
  _loadingIndeterminate = null;
  ov.classList.remove('show');
  ov.setAttribute('aria-hidden','true');
}

// BLE Connection
async function connectBle() {
  console.log('[BLE] Starting connection...');
  state._allowLoadingOverlay = true;
  try {
    console.log('[BLE] Requesting device...');
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'BBC micro:bit' }],
      optionalServices: [UART_SERVICE]
    });
    console.log('[BLE] Device selected:', device.name);
    
    device.addEventListener('gattserverdisconnected', () => {
      console.log('[BLE] GATT server disconnected event');
      onDisconnect();
    });
    
    console.log('[BLE] Connecting to GATT server...');
    const server = await device.gatt.connect();
    console.log('[BLE] GATT connected');
    
    console.log('[BLE] Getting UART service...');
    const service = await server.getPrimaryService(UART_SERVICE);
    console.log('[BLE] UART service found');
    
    console.log('[BLE] Getting TX characteristic...');
    const notifyChar = await service.getCharacteristic(UART_TX_CHAR);
    console.log('[BLE] TX characteristic found');
    
    console.log('[BLE] Getting RX characteristic...');
    const writeChar = await service.getCharacteristic(UART_RX_CHAR);
    console.log('[BLE] RX characteristic found');
    
    console.log('[BLE] Starting notifications...');
    await notifyChar.startNotifications();
    notifyChar.addEventListener('characteristicvaluechanged', onNotify);
    console.log('[BLE] Notifications started');
    
    state.ble = { device, server, service, notifyChar, writeChar, connected: true };
    state.rxBuffer = '';
    updateBleUI();
    toast('Connected!', 'success');
    
    console.log('[BLE] Waiting 500ms then sending GETCFG...');
    showLoading('🧩 Loading your remote...', 'Requesting layout (GETCFG)…');
    setTimeout(() => { 
      console.log('[BLE] Sending GETCFG now');
      state.rxBuffer = ''; 
      send('GETCFG'); 
    }, 500);
  } catch (err) {
    console.error('[BLE] Connection error:', err);
    toast('Connection failed', 'error');
  }
}

function onDisconnect() {
  console.log('[BLE] Disconnected!');
  state._allowLoadingOverlay = false;
  if (typeof hideLoading==='function') hideLoading();
  state.ble = { device:null, server:null, service:null, notifyChar:null, writeChar:null, connected:false };
  updateBleUI();
  hideLoading();
  beepDanger();
  toast('Disconnected', 'error');
}

function updateBleUI() {
  const btn = $('#bleBtn');
  const arrangeBtn = $('#arrangeModeBtn');
  const fullscreenBtn = $('#fullscreenBtn');
  if (state.ble.connected) {
    btn.classList.add('connected');
    btn.querySelector('span:last-child').textContent = (I18N[state.lang]||I18N.en).connected;
    $('#connectPrompt').style.display = 'none';
    $('#runtimeContent').style.display = 'flex';
    if (arrangeBtn) arrangeBtn.classList.add('visible');
    if (fullscreenBtn) fullscreenBtn.classList.add('visible');
    
    // Celebrate connection!
    if (!state._celebrated) {
      state._celebrated = true;
      celebrate('🎉 Connected!');
    }
    
    // Auto-enter fullscreen if in play tab
    const activeTab = document.querySelector('.tab.active');
    if (activeTab && activeTab.dataset.tab === 'runtime') {
      setTimeout(() => enterFullscreenAndFit(), 150);
    }
  } else {
    btn.classList.remove('connected');
    btn.querySelector('span:last-child').textContent = (I18N[state.lang]||I18N.en).connect;
    $('#connectPrompt').style.display = 'block';
    $('#runtimeContent').style.display = 'none';
    state._celebrated = false;
    if (arrangeBtn) {
      arrangeBtn.classList.remove('visible');
      // Also exit arrange mode if disconnected
      if (state.arrangeMode) {
        state.arrangeMode = false;
        arrangeBtn.classList.remove('active');
        arrangeBtn.textContent = '📐 Arrange';
        const grid = $('#runtimeGrid');
        if (grid) grid.classList.remove('arrange-mode');
        const hint = $('#arrangeHint');
        if (hint) hint.style.display = 'none';
      }
    }
    if (fullscreenBtn) fullscreenBtn.classList.remove('visible');
  }
}

let configBuffer = '';
    configChunks = 0;
    showLoading('🧩 Loading your remote...', 'Receiving layout…');
    setLoadingProgress(12, 'Receiving layout…');
var configChunks = 0;
function onNotify(event) {
  const value = event.target.value;
  let str = '';
  for (let i = 0; i < value.byteLength; i++) {
    const byte = value.getUint8(i);
    if (byte !== 13) str += String.fromCharCode(byte);
  }
  console.log('[BLE RX] Received:', str.replace(/\n/g, '\\n'));
  state.rxBuffer += str;
  let nl;
  while ((nl = state.rxBuffer.indexOf('\n')) !== -1) {
    const line = state.rxBuffer.slice(0, nl).trim();
    state.rxBuffer = state.rxBuffer.slice(nl + 1);
    if (line) processLine(line);
  }
}

function processLine(line) {
  console.log('[BLE] Processing line:', line);
  if (line.startsWith('CFGBEGIN')) {
    console.log('[BLE] Config begin');
    configBuffer = '';
  }
  else if (line.startsWith('CFG ')) {
    configBuffer += line.substring(4);
    configChunks++;
    setLoadingProgress(Math.min(90, 12 + configChunks * 4), `Receiving layout… (${configChunks} chunks)`);
    console.log('[BLE] Config chunk, total length:', configBuffer.length);
  }
  else if (line === 'CFGEND') {
    console.log('[BLE] Config end, decoding...');
    setLoadingProgress(96, 'Decoding layout…');
    try { 
      // Unicode-safe base64 decoding (handles emojis!)
      state.config = JSON.parse(decodeURIComponent(escape(atob(configBuffer))));
      if (state.config?.widgets) state.config.widgets.forEach(applyWidgetDefaults); 
      console.log('[BLE] Config decoded:', state.config);
      renderRuntime();
      setLoadingProgress(100, 'Ready!');
      setTimeout(hideLoading, 250);
      state._allowLoadingOverlay = false;
      hideLoading();
      toast('Remote loaded!', 'success'); 
    }
    catch(e) { console.error('[BLE] Config parse error:', e); hideLoading();
      toast('Config error', 'error'); }
  } else if (line.startsWith('UPD ')) {
    const parts = line.substring(4).split(' ');
    const id = parts[0];
    const val = parts.slice(1).join(' ');
    console.log('[BLE] Update widget:', id, '=', val);
    state.values[id] = val;
    updateRuntimeWidget(id, val);
  }
}

function renderRuntime() {
  if (!state.config) return;
  const cfg = state.config;
  // Add "Powered by Workshop-Diy" branding
  const title = cfg.title || 'My Remote';
  const titleEl = $('#runtimeTitle');
  titleEl.innerHTML = `${title} <span class="powered-by">Powered by Workshop-Diy</span>`;
  const grid = $('#runtimeGrid');
  let maxX = 0, maxY = 0;
  cfg.widgets.forEach(w => { maxX = Math.max(maxX, w.x + w.w); maxY = Math.max(maxY, w.y + w.h); });
  
  // Use saved canvas size or calculate from widgets - with reasonable limits
  const canvasW = state.runtimeCanvasSize?.w || Math.max(350, maxX + 20);
  const canvasH = state.runtimeCanvasSize?.h || Math.max(300, maxY + 20);
  grid.style.width = `${canvasW}px`;
  grid.style.height = `${canvasH}px`;
  grid.innerHTML = '';
  
  // Add canvas resize handle and size badge
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'canvas-resize-handle';
  grid.appendChild(resizeHandle);
  
  const sizeBadge = document.createElement('div');
  sizeBadge.className = 'runtime-size-badge';
  sizeBadge.textContent = `${canvasW} × ${canvasH}`;
  grid.appendChild(sizeBadge);
  
  cfg.widgets.forEach(w => {
    const el = document.createElement('div');
    el.className = 'rt-widget'; el.dataset.id = w.id;
    el.style.cssText = `left:${w.x}px;top:${w.y}px;width:${w.w}px;height:${w.h}px`;
    el.innerHTML = createRuntimeWidget(w) + '<div class="rt-resize-handle" style="display:none;"></div>';
    grid.appendChild(el);
    bindRuntimeWidget(el, w);
  });

  // Initial draw for graphs & gauges
  cfg.widgets.forEach(w => {
    applyWidgetDefaults(w);
    if (w.t === 'graph') drawGraphWidget(w);
    if (w.t === 'gauge') updateGaugeWidget(w, state.values[w.id] || '0');
  });
  
  // Re-apply arrange mode if it was active
  if (state.arrangeMode) {
    setupArrangeMode();
  }
}

// === RUNTIME ARRANGE MODE ===
function toggleArrangeMode() {
  state.arrangeMode = !state.arrangeMode;
  const btn = $('#arrangeModeBtn');
  const grid = $('#runtimeGrid');
  const hint = $('#arrangeHint');
  
  if (state.arrangeMode) {
    btn.classList.add('active');
    btn.textContent = '✓ Done';
    grid.classList.add('arrange-mode');
    hint.style.display = 'block';
    
    // Show resize handles
    grid.querySelectorAll('.rt-resize-handle').forEach(h => h.style.display = 'block');
    
    setupArrangeMode();
    toast('📐 Arrange mode ON - drag widgets to move', 'success');
  } else {
    btn.classList.remove('active');
    btn.textContent = '📐 Arrange';
    grid.classList.remove('arrange-mode');
    hint.style.display = 'none';
    
    // Hide resize handles
    grid.querySelectorAll('.rt-resize-handle').forEach(h => h.style.display = 'none');
    
    teardownArrangeMode();
    
    // Sync changes back to build mode widgets
    syncRuntimeToBuild();
    
    toast('✅ Layout saved!', 'success');
  }
}

function setupArrangeMode() {
  const grid = $('#runtimeGrid');
  if (!grid) return;
  
  // Setup canvas resize
  const canvasHandle = grid.querySelector('.canvas-resize-handle');
  if (canvasHandle && !canvasHandle._resizeSetup) {
    canvasHandle._resizeSetup = true;
    let isResizingCanvas = false;
    let canvasStartX, canvasStartY, canvasStartW, canvasStartH;
    
    const onCanvasResizeStart = (e) => {
      if (!state.arrangeMode) return;
      e.preventDefault();
      e.stopPropagation();
      isResizingCanvas = true;
      
      const touch = e.touches ? e.touches[0] : e;
      canvasStartX = touch.clientX;
      canvasStartY = touch.clientY;
      canvasStartW = parseInt(grid.style.width) || 400;
      canvasStartH = parseInt(grid.style.height) || 320;
    };
    
    const onCanvasResizeMove = (e) => {
      if (!isResizingCanvas || !state.arrangeMode) return;
      e.preventDefault();
      
      const touch = e.touches ? e.touches[0] : e;
      const dx = touch.clientX - canvasStartX;
      const dy = touch.clientY - canvasStartY;
      
      const newW = Math.max(300, canvasStartW + dx);
      const newH = Math.max(200, canvasStartH + dy);
      
      grid.style.width = newW + 'px';
      grid.style.height = newH + 'px';
      
      // Update size badge
      const badge = grid.querySelector('.runtime-size-badge');
      if (badge) badge.textContent = `${newW} × ${newH}`;
    };
    
    const onCanvasResizeEnd = () => {
      if (!isResizingCanvas) return;
      isResizingCanvas = false;
      
      // Save canvas size
      state.runtimeCanvasSize = {
        w: parseInt(grid.style.width) || 400,
        h: parseInt(grid.style.height) || 320
      };
    };
    
    canvasHandle.addEventListener('mousedown', onCanvasResizeStart);
    canvasHandle.addEventListener('touchstart', onCanvasResizeStart, { passive: false });
    document.addEventListener('mousemove', onCanvasResizeMove);
    document.addEventListener('touchmove', onCanvasResizeMove, { passive: false });
    document.addEventListener('mouseup', onCanvasResizeEnd);
    document.addEventListener('touchend', onCanvasResizeEnd);
    
    canvasHandle._cleanup = () => {
      canvasHandle.removeEventListener('mousedown', onCanvasResizeStart);
      canvasHandle.removeEventListener('touchstart', onCanvasResizeStart);
      document.removeEventListener('mousemove', onCanvasResizeMove);
      document.removeEventListener('touchmove', onCanvasResizeMove);
      document.removeEventListener('mouseup', onCanvasResizeEnd);
      document.removeEventListener('touchend', onCanvasResizeEnd);
    };
  }
  
  grid.querySelectorAll('.rt-widget').forEach(el => {
    // Skip if already set up
    if (el._arrangeSetup) return;
    el._arrangeSetup = true;
    
    const wid = el.dataset.id;
    let startX, startY, startLeft, startTop;
    let isDragging = false;
    
    // Touch/Mouse drag
    const onStart = (e) => {
      if (!state.arrangeMode) return;
      if (e.target.closest('.rt-resize-handle')) return;
      
      e.preventDefault();
      e.stopPropagation();
      isDragging = true;
      el.classList.add('dragging');
      
      const touch = e.touches ? e.touches[0] : e;
      startX = touch.clientX;
      startY = touch.clientY;
      startLeft = parseInt(el.style.left) || 0;
      startTop = parseInt(el.style.top) || 0;
    };
    
    const onMove = (e) => {
      if (!isDragging || !state.arrangeMode) return;
      e.preventDefault();
      
      const touch = e.touches ? e.touches[0] : e;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      
      const newLeft = Math.max(0, startLeft + dx);
      const newTop = Math.max(0, startTop + dy);
      
      el.style.left = newLeft + 'px';
      el.style.top = newTop + 'px';
    };
    
    const onEnd = (e) => {
      if (!isDragging) return;
      isDragging = false;
      el.classList.remove('dragging');
      
      // Update config
      if (state.config) {
        const w = state.config.widgets.find(w => w.id === wid);
        if (w) {
          w.x = parseInt(el.style.left) || 0;
          w.y = parseInt(el.style.top) || 0;
        }
      }
      
      // Update grid size if widget moved outside
      updateRuntimeGridSize();
    };
    
    el.addEventListener('mousedown', onStart);
    el.addEventListener('touchstart', onStart, { passive: false });
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchend', onEnd);
    
    // Store cleanup functions
    el._arrangeCleanup = () => {
      el.removeEventListener('mousedown', onStart);
      el.removeEventListener('touchstart', onStart);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchend', onEnd);
    };
    
    // Resize handle
    const handle = el.querySelector('.rt-resize-handle');
    if (handle) {
      let isResizing = false;
      let resizeStartX, resizeStartY, resizeStartW, resizeStartH;
      
      const onResizeStart = (e) => {
        if (!state.arrangeMode) return;
        e.preventDefault();
        e.stopPropagation();
        isResizing = true;
        
        const touch = e.touches ? e.touches[0] : e;
        resizeStartX = touch.clientX;
        resizeStartY = touch.clientY;
        resizeStartW = parseInt(el.style.width) || 100;
        resizeStartH = parseInt(el.style.height) || 100;
      };
      
      const onResizeMove = (e) => {
        if (!isResizing || !state.arrangeMode) return;
        e.preventDefault();
        
        const touch = e.touches ? e.touches[0] : e;
        const dx = touch.clientX - resizeStartX;
        const dy = touch.clientY - resizeStartY;
        
        const newW = Math.max(50, resizeStartW + dx);
        const newH = Math.max(50, resizeStartH + dy);
        
        el.style.width = newW + 'px';
        el.style.height = newH + 'px';
      };
      
      const onResizeEnd = () => {
        if (!isResizing) return;
        isResizing = false;
        
        // Update config
        if (state.config) {
          const w = state.config.widgets.find(w => w.id === wid);
          if (w) {
            w.w = parseInt(el.style.width) || 100;
            w.h = parseInt(el.style.height) || 100;
          }
        }
        
        updateRuntimeGridSize();
      };
      
      handle.addEventListener('mousedown', onResizeStart);
      handle.addEventListener('touchstart', onResizeStart, { passive: false });
      document.addEventListener('mousemove', onResizeMove);
      document.addEventListener('touchmove', onResizeMove, { passive: false });
      document.addEventListener('mouseup', onResizeEnd);
      document.addEventListener('touchend', onResizeEnd);
      
      handle._resizeCleanup = () => {
        handle.removeEventListener('mousedown', onResizeStart);
        handle.removeEventListener('touchstart', onResizeStart);
        document.removeEventListener('mousemove', onResizeMove);
        document.removeEventListener('touchmove', onResizeMove);
        document.removeEventListener('mouseup', onResizeEnd);
        document.removeEventListener('touchend', onResizeEnd);
      };
    }
  });
}

function teardownArrangeMode() {
  const grid = $('#runtimeGrid');
  if (!grid) return;
  
  // Cleanup canvas resize
  const canvasHandle = grid.querySelector('.canvas-resize-handle');
  if (canvasHandle && canvasHandle._cleanup) {
    canvasHandle._cleanup();
    canvasHandle._cleanup = null;
    canvasHandle._resizeSetup = false;
  }
  
  grid.querySelectorAll('.rt-widget').forEach(el => {
    if (el._arrangeCleanup) {
      el._arrangeCleanup();
      el._arrangeCleanup = null;
    }
    el._arrangeSetup = false;
    
    const handle = el.querySelector('.rt-resize-handle');
    if (handle && handle._resizeCleanup) {
      handle._resizeCleanup();
      handle._resizeCleanup = null;
    }
  });
}

function updateRuntimeGridSize() {
  const grid = $('#runtimeGrid');
  if (!grid || !state.config) return;
  
  let maxX = 0, maxY = 0;
  state.config.widgets.forEach(w => {
    maxX = Math.max(maxX, w.x + w.w);
    maxY = Math.max(maxY, w.y + w.h);
  });
  
  grid.style.width = `${Math.max(400, maxX + 20)}px`;
  grid.style.height = `${Math.max(320, maxY + 20)}px`;
}

function syncRuntimeToBuild() {
  if (!state.config || !state.config.widgets) return;
  
  // Update state.widgets with new positions from runtime config
  state.config.widgets.forEach(rtW => {
    const buildW = state.widgets.find(w => w.id === rtW.id);
    if (buildW) {
      buildW.x = rtW.x;
      buildW.y = rtW.y;
      buildW.w = rtW.w;
      buildW.h = rtW.h;
    }
  });
  
  // Re-render build view with updated positions
  renderWidgets();
  
  // Auto-save
  scheduleAutoSave();
}


function createRuntimeWidget(w) {
  const val = esc(state.values[w.id] || '0');
  const label = esc(w.label || w.t);
  const rawVal = state.values[w.id] || '0';
  const model = (w.model || '').trim();

  switch (w.t) {
    case 'button': {
      const m = model || 'neo';
      const icons = ['🎯', '⚡', '🚀', '💥', '✨', '🎮', '🔥', '💫'];
      const icon = icons[Math.abs(w.id.charCodeAt(w.id.length-1) || 0) % icons.length];
      return `<button class="rt-button model-${m}"><span class="icon">${icon}</span><span>${label}</span></button>`;
    }

    case 'slider': {
      const m = model || 'track';
      const min = (w.min ?? 0);
      const max = (w.max ?? 100);
      const step = (w.step ?? 1);
      const clamped = Math.max(min, Math.min(max, parseFloat(rawVal) || min));
      const isVertical = (w.h || 100) > (w.w || 100);
      const orientClass = isVertical ? ' vertical' : '';
      return `<div class="rt-slider-wrap${orientClass}">
        <div class="rt-slider-label">${label}</div>
        <input type="range" class="rt-slider model-${m}" min="${min}" max="${max}" step="${step}" value="${clamped}"${isVertical ? ' orient="vertical"' : ''}>
        <div class="rt-slider-val">${esc(String(clamped))}</div>
      </div>`;
    }

    case 'toggle': {
      const m = model || 'square';
      const on = rawVal === '1';
      const glyph = m === 'icon' ? (on ? '⏻' : '⭘') : (on ? '😃' : '😴');
      return `<div class="rt-toggle-wrap">
        <button class="rt-toggle model-${m}${on ? ' on' : ''}">${glyph}</button>
        <span>${label}</span>
      </div>`;
    }

    case 'led': {
      const m = model || 'dot';
      const on = rawVal === '1';
      const onColor = w.colorOn || '#ff5252';
      const offColor = w.colorOff || '#333';
      // Create dynamic styles for the bulb effect
      const offStyle = `background: radial-gradient(circle at 30% 30%, #666, #333 40%, #222 70%, #111);`;
      const onStyle = `background: radial-gradient(circle at 30% 30%, ${onColor}99, ${onColor} 30%, ${onColor}cc 60%, ${onColor}88); border-color: ${onColor}88;`;
      const style = on ? onStyle : offStyle;
      const shadow = on 
        ? `box-shadow: inset 0 -8px 15px rgba(0,0,0,0.3), inset 0 8px 15px rgba(255,255,255,0.3), 0 0 30px ${onColor}, 0 0 60px ${onColor}88, 0 0 90px ${onColor}44;`
        : `box-shadow: inset 0 -8px 15px rgba(0,0,0,0.6), inset 0 8px 15px rgba(255,255,255,0.1), 0 4px 10px rgba(0,0,0,0.5);`;

      return `<div class="rt-led-wrap">
        <div class="rt-led model-${m}${on ? ' on' : ''}" style="${style}${shadow}" data-color="${onColor}"></div>
        <span>${label}</span>
      </div>`;
    }

    case 'joystick': {
      const m = model || 'classic';
      const stickM = m === 'min' ? 'min' : 'classic';
      return `<div class="rt-joystick-wrap">
        <div class="rt-joystick-base model-${m}"><div class="rt-joystick-stick model-${stickM}"></div></div>
        <span>${label}</span>
      </div>`;
    }

    case 'label': {
      const m = model || 'plain';
      return `<div class="rt-label-text model-${m}">${val || label}</div>`;
    }

    case 'gauge': {
      const m = model || 'classic';
      const units = esc(w.units || '');
      const decimals = (w.decimals ?? 0);
      // 11 tick marks across the arc
      const ticks = Array.from({length: 11}, (_, i) => {
        const a = (-180 + (180 * (i/10))) * Math.PI/180; // -180..0
        const cx = 60, cy = 70;
        const r1 = 42, r2 = 50;
        const x1 = cx + Math.cos(a) * r1;
        const y1 = cy + Math.sin(a) * r1;
        const x2 = cx + Math.cos(a) * r2;
        const y2 = cy + Math.sin(a) * r2;
        return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" />`;
      }).join('');
      return `<div class="rt-gauge-wrap model-${m}">
        <div class="rt-gauge-svg">
          <svg viewBox="0 0 120 80" width="100%" height="100%">
            <g class="rt-gauge-ticks">${ticks}</g>
            <path class="rt-gauge-bg" d="M10,70 A50,50 0 0 1 110,70" />
            <path class="rt-gauge-fg" data-role="gaugeArc" d="M10,70 A50,50 0 0 1 110,70" />
          </svg>
        </div>
        <div class="rt-gauge-center">
          <div class="rt-gauge-emoji" data-role="gaugeEmoji">😃</div>
          <div class="rt-gauge-value" data-role="gaugeValue">${esc((parseFloat(rawVal)||0).toFixed(decimals))}</div>
          <div class="rt-gauge-label">${label}${units ? ' ' + units : ''}</div>
        </div>
      </div>`;
    }
    
    case 'graph': {
      const m = model || 'grid';
      const win = parseInt(w.windowSec ?? 30, 10) || 30;
      const auto = (w.autoScale !== false);
      const series = Math.max(1, Math.min(10, parseInt(w.series ?? 1, 10) || 1));
      return `<div class="rt-graph-wrap model-${m}">
        <div class="rt-graph-head">
          <span>${label}</span>
          <span data-role="graphLast"></span>
        </div>
        <div class="rt-graph-sub" data-role="graphLegend"></div>
        <canvas class="rt-graph-canvas" data-role="graphCanvas"></canvas>
        <div class="rt-graph-sub">Win:${win}s&nbsp;&nbsp;${auto ? 'Auto' : 'Fixed'}&nbsp;&nbsp;Series:${series}</div>
      </div>`;
    }

    case 'dpad': {
      return `<div class="rt-dpad">
        <div></div>
        <button class="dpad-btn" data-dir="up" type="button">&#9650;</button>
        <div></div>
        <button class="dpad-btn" data-dir="left" type="button">&#9664;</button>
        <div class="dpad-center"></div>
        <button class="dpad-btn" data-dir="right" type="button">&#9654;</button>
        <div></div>
        <button class="dpad-btn" data-dir="down" type="button">&#9660;</button>
        <div></div>
      </div>`;
    }

    case 'xypad': {
      return `<div class="rt-xypad">
        <div class="xypad-crosshair"></div>
        <div class="xypad-dot" style="left:50%;top:50%"></div>
        <div class="xypad-label">${label}</div>
      </div>`;
    }

    case 'battery': {
      const level = parseInt(rawVal) || 100;
      const levelClass = level < 20 ? 'critical' : level < 40 ? 'low' : '';
      const emoji = level < 20 ? '😱' : level < 40 ? '😰' : level < 60 ? '😊' : level < 80 ? '😄' : '🤩';
      return `<div class="rt-battery">
        <div class="battery-tip"></div>
        <div class="battery-body">
          <div class="battery-level ${levelClass}" style="height:${level}%"></div>
        </div>
        <div class="battery-text">${level}%</div>
        <div class="battery-emoji">${emoji}</div>
      </div>`;
    }

    case 'timer': {
      return `<div class="rt-timer">
        <div class="timer-label">⏱️ ${label || 'Timer'}</div>
        <div class="timer-display" data-role="timerDisplay">00:00</div>
        <div class="timer-controls">
          <button class="timer-btn" data-action="start">▶️ Go!</button>
          <button class="timer-btn" data-action="pause">⏸️</button>
          <button class="timer-btn" data-action="reset">🔄</button>
        </div>
      </div>`;
    }

    case 'image': {
      const src = w.imageSrc || '';
      return `<div class="rt-image" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:8px;">
        ${src ? `<img src="${esc(src)}" style="max-width:100%;max-height:100%;object-fit:contain;">` : `<span style="opacity:0.5">${label || '🖼️'}</span>`}
      </div>`;
    }

    default:
      return `<div>${w.t}</div>`;
  }
}


function bindRuntimeWidget(el, w) {
  switch (w.t) {
    case 'button':
      const btn = el.querySelector('.rt-button');
      let btnPressed = false;
      const press = e => { 
        e.preventDefault();
        if (btnPressed) return;
        btnPressed = true;
        beepClick();
        send(`SET ${w.id} 1`); 
        btn.style.transform = 'scale(0.9)'; 
      };
      const release = () => {
        if (!btnPressed) return;
        btn.style.transform = '';
        // Delay release message slightly
        setTimeout(() => {
          btnPressed = false;
          send(`SET ${w.id} 0`);
        }, 100);
      };
      btn.onmousedown = btn.ontouchstart = press;
      btn.onmouseup = btn.onmouseleave = btn.ontouchend = release;
      break;
    case 'slider':
      let sliderEl = el.querySelector('.rt-slider');
      // Update display during drag (no BLE send)
      sliderEl.oninput = e => {
        el.querySelector('.rt-slider-val').textContent = Math.round(e.target.value);
      };
      // Only send on release (onChange fires when user stops dragging)
      sliderEl.onchange = e => {
        const val = Math.round(parseFloat(e.target.value) || 0);
        console.log('[SLIDER] Sending final value:', val);
        send(`SET ${w.id} ${val}`);
      };
      break;
    case 'toggle':
      el.querySelector('.rt-toggle').onclick = function() {
        const on = this.classList.toggle('on');
        this.textContent = on ? '😃' : '😴';
        beepToggle(on);
        send(`SET ${w.id} ${on ? '1' : '0'}`);
      };
      break;
    case 'joystick':
      const stick = el.querySelector('.rt-joystick-stick');
      const base = el.querySelector('.rt-joystick-base');
      let isDown = false;
      let currentAngle = 0;
      let currentDist = 0;
      let resetTimer = null; // Debounce timer for reset
      const handleMove = e => {
        if (!isDown) return;
        const rect = base.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const dx = clientX - centerX;
        const dy = -(clientY - centerY); // Invert Y so up is positive
        const maxDist = Math.min(rect.width, rect.height) / 2 - 10;
        const rawAngle = Math.atan2(dy, dx) * 180 / Math.PI;
        const distance = Math.min(maxDist, Math.hypot(dx, dy));
        currentDist = Math.round((distance / maxDist) * 100);
        // Normalize angle: 0=right, 90=up, 180=left, 270=down
        currentAngle = Math.round(((rawAngle + 360) % 360));
        // Visual position uses screen coordinates (Y not inverted)
        const visualDy = clientY - centerY;
        stick.style.transform = `translate(${(dx / Math.hypot(dx, visualDy || 1)) * distance}px, ${(visualDy / Math.hypot(dx, visualDy || 1)) * distance}px)`;
        // Don't send during drag - only on release
      };
      const resetJoystick = () => {
        if (!isDown) return;
        isDown = false;
        // Clear any pending reset timer
        if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
        // Send final position before reset (only if moved significantly)
        const finalAngle = currentAngle;
        const finalDist = currentDist;
        stick.style.transform = '';
        currentAngle = 0;
        currentDist = 0;
        // Single combined send: final position then center, with proper delay
        if (finalDist > 5) {
          send(`SET ${w.id} ${finalAngle} ${finalDist}`);
          // Wait longer than BLE minInterval before sending center
          resetTimer = setTimeout(() => {
            resetTimer = null;
            send(`SET ${w.id} 0 0`);
          }, 250);
        } else {
          // Just send center if no significant movement
          send(`SET ${w.id} 0 0`);
        }
      };
      const startJoystick = (e) => {
        if (e.type === 'touchstart') e.preventDefault();
        if (isDown) return; // Prevent multiple starts
        isDown = true;
        if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
      };
      base.onmousedown = startJoystick;
      base.ontouchstart = startJoystick;
      document.addEventListener('mousemove', handleMove);
      document.addEventListener('touchmove', handleMove, { passive: false });
      document.addEventListener('mouseup', resetJoystick);
      document.addEventListener('touchend', resetJoystick);
      break;
    
    case 'dpad':
      const dpadBtns = el.querySelectorAll('.dpad-btn[data-dir]');
      console.log('[DPAD] Found buttons:', dpadBtns.length, Array.from(dpadBtns).map(b => b.dataset.dir));
      dpadBtns.forEach(btn => {
        const dir = btn.dataset.dir;
        console.log('[DPAD] Binding button:', dir, btn);
        let dpadPressed = false;
        let releaseTimer = null;
        
        const press = e => { 
          e.preventDefault();
          e.stopPropagation();
          if (dpadPressed) return;
          dpadPressed = true;
          clearTimeout(releaseTimer);
          btn.classList.add('active');
          beepClick();
          console.log('[DPAD] Pressed:', dir);
          send(`SET ${w.id} ${dir} 1`); 
        };
        
        const release = e => {
          if (e) {
            e.preventDefault();
            e.stopPropagation();
          }
          if (!dpadPressed) return;
          btn.classList.remove('active');
          // Debounce release to avoid rapid press/release
          clearTimeout(releaseTimer);
          releaseTimer = setTimeout(() => {
            dpadPressed = false;
            console.log('[DPAD] Released:', dir);
            send(`SET ${w.id} ${dir} 0`);
          }, 100);
        };
        
        // Use addEventListener for better compatibility
        btn.addEventListener('mousedown', press, { passive: false });
        btn.addEventListener('touchstart', press, { passive: false });
        btn.addEventListener('mouseup', release, { passive: false });
        btn.addEventListener('touchend', release, { passive: false });
        btn.addEventListener('touchcancel', release, { passive: false });
        
        // Only release on mouseleave if the button is pressed (mouse left the button while down)
        btn.addEventListener('mouseleave', e => {
          if (dpadPressed && e.buttons === 0) {
            release(e);
          }
        }, { passive: false });
        
        // EXTRA: Also add onclick as fallback
        btn.onclick = press;
      });
      break;
    
    case 'xypad':
      const xypad = el.querySelector('.rt-xypad');
      const xydot = el.querySelector('.xypad-dot');
      let xyDown = false;
      let lastX = 50, lastY = 50;
      const handleXY = e => {
        if (!xyDown) return;
        e.preventDefault();
        const rect = xypad.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
        lastX = Math.round(x * 100);
        lastY = Math.round(y * 100);
        xydot.style.left = (x * 100) + '%';
        xydot.style.top = (y * 100) + '%';
        // Don't send during drag - only on release
      };
      const releaseXY = () => {
        if (!xyDown) return;
        xyDown = false;
        // Send final position on release
        console.log('[XYPAD] Sending final:', lastX, lastY);
        send(`SET ${w.id} ${lastX} ${lastY}`);
      };
      xypad.onmousedown = xypad.ontouchstart = e => { 
        xyDown = true; 
        handleXY(e); 
      };
      document.addEventListener('mousemove', handleXY);
      document.addEventListener('touchmove', handleXY, { passive: false });
      document.addEventListener('mouseup', releaseXY);
      document.addEventListener('touchend', releaseXY);
      break;
    
    case 'timer':
      let timerVal = 0;
      let timerInterval = null;
      let lastTimerSend = 0;
      const display = el.querySelector('[data-role="timerDisplay"]');
      const formatTime = s => {
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
      };
      el.querySelector('[data-action="start"]').onclick = () => {
        if (timerInterval) return;
        timerInterval = setInterval(() => {
          timerVal++;
          display.textContent = formatTime(timerVal);
          // Only send every 5 seconds to avoid BLE spam
          if (timerVal - lastTimerSend >= 5) {
            lastTimerSend = timerVal;
            send(`SET ${w.id} ${timerVal}`);
          }
        }, 1000);
        beepClick();
      };
      el.querySelector('[data-action="pause"]').onclick = () => {
        clearInterval(timerInterval);
        timerInterval = null;
        // Send current value on pause
        send(`SET ${w.id} ${timerVal}`);
        beepClick();
      };
      el.querySelector('[data-action="reset"]').onclick = () => {
        clearInterval(timerInterval);
        timerInterval = null;
        timerVal = 0;
        lastTimerSend = 0;
        display.textContent = '00:00';
        send(`SET ${w.id} 0`);
        beepClick();
      };
      break;
  }
}


// --- Graph & Gauge helpers ---
state.history = state.history || {}; // { [id]: { points: Array<{t:number, v:number[]}>, colors:string[] } }

function parseCsvNumbers(s){
  return String(s ?? '').split(',').map(x => parseFloat(x.trim())).filter(x => isFinite(x));
}

function ensureGraphState(id, series){
  if (!state.history[id]) state.history[id] = { points: [], colors: [] };
  const hs = state.history[id];
  if (!hs.colors || hs.colors.length !== series){
    // generate distinct-ish hues using HSL (no hard-coded palette)
    hs.colors = Array.from({length: series}).map((_,i)=>`hsl(${(i*360/series)|0} 85% 60%)`);
  }
  return hs;
}

function pushGraphPoint(w, csvVal){
  const nums = parseCsvNumbers(csvVal);
  const series = Math.max(1, Math.min(10, parseInt(w.series ?? 1, 10)));
  const hs = ensureGraphState(w.id, series);
  const now = performance.now();
  const arr = Array.from({length: series}).map((_,i)=> (nums[i] != null ? nums[i] : NaN));
  hs.points.push({ t: now, v: arr });

  // trim window
  const winMs = Math.max(5, Math.min(300, parseFloat(w.windowSec ?? 30))) * 1000;
  const cutoff = now - winMs;
  while (hs.points.length && hs.points[0].t < cutoff) hs.points.shift();
  
  // Also limit max points for smoother rendering
  const maxPoints = 150;
  while (hs.points.length > maxPoints) hs.points.shift();
}

function resizeCanvasToDisplaySize(canvas){
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(10, Math.floor(rect.width * dpr));
  const h = Math.max(10, Math.floor(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h){
    canvas.width = w; canvas.height = h;
    return true;
  }
  return false;
}

function drawGraphWidget(w){
  const root = document.querySelector(`.rt-widget[data-id="${w.id}"]`);
  if (!root) return;
  const canvas = root.querySelector('[data-role="graphCanvas"]');
  if (!canvas) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const cssW = Math.max(50, rect.width);
  const cssH = Math.max(40, rect.height);
  const W = Math.floor(cssW * dpr);
  const H = Math.floor(cssH * dpr);
  if (canvas.width !== W || canvas.height !== H){
    canvas.width = W; canvas.height = H;
  }

  const ctx = canvas.getContext('2d');
  // draw in CSS pixels for predictable fonts/line widths
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,cssW,cssH);

  const seriesCount = Math.max(1, Math.min(10, parseInt(w.series ?? 1, 10)));
  const hs = ensureGraphState(w.id, seriesCount);
  const pts = hs.points || [];


  // legend (kid-friendly)
  const legend = root.querySelector('[data-role="graphLegend"]');
  if (legend){
    const names = (w.seriesNames || '').split(',').map(s => s.trim()).filter(Boolean);
    legend.innerHTML = Array.from({length: seriesCount}).map((_,i) => {
      const nm = esc(names[i] || `S${i+1}`);
      return `<span class="legend-item"><span class="rt-graph-dot" data-s="${i}"></span>${nm}</span>`;
    }).join('');
  }

  // layout
  const mL = 36, mR = 10, mT = 10, mB = 22;
  const plotX = mL, plotY = mT;
  const plotW = Math.max(10, cssW - mL - mR);
  const plotH = Math.max(10, cssH - mT - mB);

  // background
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(0,0,0,0)';
  ctx.fillRect(0,0,cssW,cssH);

  // axes + grid
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;

  // y grid + labels
  ctx.font = '10px system-ui, Segoe UI, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';

  // if no data, draw frame + hint
  ctx.strokeRect(plotX, plotY, plotW, plotH);
  if (pts.length < 2){
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText('waiting for UPD...', plotX + 8, plotY + 16);
    // legend colors
    const legend2 = root.querySelector('[data-role="graphLegend"]');
    if (legend2){
      legend2.querySelectorAll('.rt-graph-dot').forEach(dot => {
        const i = parseInt(dot.getAttribute('data-s') || '0', 10);
        dot.style.background = hs.colors[i] || 'var(--accent)';
      });
    }
    return;
  }

  const t0 = pts[0].t;
  const t1 = pts[pts.length-1].t;
  const span = Math.max(0.001, t1 - t0);

  // y scale
  let yMin = Infinity, yMax = -Infinity;
  if (w.autoScale ?? true){
    pts.forEach(p => p.v.forEach(v => { if (isFinite(v)) { yMin = Math.min(yMin, v); yMax = Math.max(yMax, v); } }));
    if (!isFinite(yMin) || !isFinite(yMax)){ yMin = 0; yMax = 1; }
  } else {
    yMin = parseFloat(w.yMin ?? 0);
    yMax = parseFloat(w.yMax ?? 100);
    if (!isFinite(yMin) || !isFinite(yMax)){ yMin = 0; yMax = 1; }
  }
  if (yMin === yMax){ yMin -= 1; yMax += 1; }
  const pad = (yMax - yMin) * 0.08;
  yMin -= pad; yMax += pad;

  const xForT = t => plotX + ((t - t0) / span) * plotW;
  const yForV = v => plotY + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // Y ticks
  const yTicks = 4;
  for (let i=0;i<=yTicks;i++){
    const p = i / yTicks;
    const y = plotY + p * plotH;
    ctx.beginPath(); ctx.moveTo(plotX, y); ctx.lineTo(plotX+plotW, y); ctx.stroke();
    const v = (yMax - (yMax - yMin) * p);
    ctx.fillText(v.toFixed(1), 4, y + 3);
  }

  
  // Y axis label
  if ((w.yLabel || '').trim()){
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '11px system-ui, Segoe UI, sans-serif';
    ctx.translate(12, plotY + plotH/2);
    ctx.rotate(-Math.PI/2);
    ctx.fillText(w.yLabel, 0, 0);
    ctx.restore();
  }

  // X ticks (seconds)
  const xTicks = 4;
  for (let i=0;i<=xTicks;i++){
    const p = i / xTicks;
    const x = plotX + p * plotW;
    ctx.beginPath(); ctx.moveTo(x, plotY); ctx.lineTo(x, plotY+plotH); ctx.stroke();
    const sec = ((t0 + span * p) - t1) / 1000; // negative to 0
    ctx.fillText(sec.toFixed(0) + 's', x - 10, plotY + plotH + 16);
  }

  // draw each series with smooth lines
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  
  hs.colors.forEach((c, si) => {
    // Draw glow effect first
    ctx.strokeStyle = c;
    ctx.lineWidth = 6;
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    let started = false;
    for (let i=0;i<pts.length;i++){
      const v = pts[i].v[si];
      if (!isFinite(v)) continue;
      const x = xForT(pts[i].t);
      const y = yForV(v);
      if (!started){ ctx.moveTo(x,y); started = true; }
      else { ctx.lineTo(x,y); }
    }
    if (started) ctx.stroke();
    
    // Draw main line
    ctx.globalAlpha = 1;
    ctx.lineWidth = 3;
    ctx.beginPath();
    started = false;
    for (let i=0;i<pts.length;i++){
      const v = pts[i].v[si];
      if (!isFinite(v)) continue;
      const x = xForT(pts[i].t);
      const y = yForV(v);
      if (!started){ ctx.moveTo(x,y); started = true; }
      else { ctx.lineTo(x,y); }
    }
    if (started) ctx.stroke();
  });

  // update legend dots colors
  const legend2 = root.querySelector('[data-role="graphLegend"]');
  if (legend2){
    legend2.querySelectorAll('.rt-graph-dot').forEach(dot => {
      const i = parseInt(dot.getAttribute('data-s') || '0', 10);
      dot.style.background = hs.colors[i] || 'var(--accent)';
    });
  }
}

function stopDemoSim(){
  if (state._demoTimer){
    clearInterval(state._demoTimer);
    state._demoTimer = null;
  }
}

function startDemoSim(){
  stopDemoSim();
  
  // Check for any demo widgets
  const hasGraph = !!document.querySelector('.rt-widget[data-id="graph_env"] [data-role="graphCanvas"]');
  const hasGauge = !!document.querySelector('.rt-widget[data-id="gauge_temp"] .rt-gauge-wrap');
  const hasBattery = !!document.querySelector('.rt-widget[data-id="battery_level"]');
  const hasTimer = !!document.querySelector('.rt-widget[data-id="timer_game"]');
  const hasLed = !!document.querySelector('.rt-widget[data-id="led_status"]');
  
  if (!hasGraph && !hasGauge && !hasBattery && !hasTimer && !hasLed) return;

  let t0 = Date.now();
  let ledBlinkState = false;
  let timerSeconds = 0;
  
  state._demoTimer = setInterval(() => {
    const t = (Date.now() - t0) / 1000;

    // Smooth sine waves for gauges
    const temp = 25 + 8 * Math.sin(t / 4);
    const level = 50 + 35 * Math.sin(t / 5);

    state.values['gauge_temp'] = temp.toFixed(1);
    state.values['gauge_level'] = level.toFixed(0);

    updateRuntimeWidget('gauge_temp', state.values['gauge_temp']);
    updateRuntimeWidget('gauge_level', state.values['gauge_level']);

    // Smooth waves for graph - slower, more gradual changes
    const s1 = 50 + 30 * Math.sin(t / 2);
    const s2 = 40 + 25 * Math.cos(t / 2.5);
    const csv = `${s1.toFixed(1)},${s2.toFixed(1)}`;
    state.values['graph_env'] = csv;
    updateRuntimeWidget('graph_env', csv);

    // Update score label
    const scoreEl = state.config?.widgets?.find(x => x.id === 'label_score');
    if (scoreEl){
      const sc = Math.floor((t * 3) % 999);
      const txt = `Score: ${sc}`;
      state.values['label_score'] = txt;
      updateRuntimeWidget('label_score', txt);
    }
    
    // Animate battery level (cycles between 10-100%)
    if (hasBattery) {
      const batteryLevel = Math.floor(50 + 45 * Math.sin(t / 8));
      state.values['battery_level'] = batteryLevel.toString();
      updateRuntimeWidget('battery_level', batteryLevel.toString());
    }
    
    // Animate timer (counts up)
    if (hasTimer) {
      timerSeconds = Math.floor(t);
      const mins = Math.floor(timerSeconds / 60);
      const secs = timerSeconds % 60;
      const timerStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
      state.values['timer_game'] = timerStr;
      updateRuntimeWidget('timer_game', timerStr);
    }
    
    // Blink LEDs alternately
    if (hasLed) {
      ledBlinkState = !ledBlinkState;
      state.values['led_status'] = ledBlinkState ? '1' : '0';
      state.values['led_alert'] = ledBlinkState ? '0' : '1';
      updateRuntimeWidget('led_status', state.values['led_status']);
      updateRuntimeWidget('led_alert', state.values['led_alert']);
    }
  }, 400); // Slower updates for smoother appearance
}


function updateGaugeWidget(w, valStr){
  const root = document.querySelector(`.rt-widget[data-id="${w.id}"]`);
  if (!root) return;
  const wrap = root.querySelector('.rt-gauge-wrap');
  if (!wrap) return;

  const arc = wrap.querySelector('[data-role="gaugeArc"]') || wrap.querySelector('.rt-gauge-fg');
  const txt = wrap.querySelector('[data-role="gaugeValue"]');
  const emo = wrap.querySelector('[data-role="gaugeEmoji"]');

  const min = parseFloat(w.min ?? 0);
  const max = parseFloat(w.max ?? 100);
  const dec = parseInt(w.decimals ?? 0, 10);

  let v = parseFloat(valStr);
  if (!isFinite(v)) v = min;

  const denom = (max - min) || 1;
  const t = Math.max(0, Math.min(1, (v - min) / denom));

  // Match CSS dasharray (half-ish arc). If changed in CSS, keep in sync.
  const L = 157.1;

  // Color zones (kid-friendly)
  const warn = (w.warn != null) ? parseFloat(w.warn) : null;
  const danger = (w.danger != null) ? parseFloat(w.danger) : null;

  let color = 'var(--green)';
  if (danger != null && isFinite(danger) && v >= danger) color = 'var(--red)';
  else if (warn != null && isFinite(warn) && v >= warn) color = 'var(--orange)';
  else color = 'var(--green)';

  if (arc){
    arc.style.strokeDasharray = String(L);
    arc.style.strokeDashoffset = String(L * (1 - t));
    arc.style.stroke = color;
  }

  if (txt){
    const d = isFinite(dec) ? dec : 0;
    txt.textContent = v.toFixed(d);
  }

  if (emo){
    // Cute emoji based on percent
    const pct = Math.round(t * 100);
    emo.textContent = pct < 20 ? '😴' : pct < 40 ? '🙂' : pct < 60 ? '😃' : pct < 80 ? '🤩' : '🚀';
  }
}



function updateRuntimeWidget(id, val) {
  console.log('[UI] Updating widget:', id, 'to', val);
  const el = document.querySelector(`.rt-widget[data-id="${id}"]`);
  if (!el || !state.config) {
    console.log('[UI] Widget not found or no config. Element:', el, 'Config:', !!state.config);
    return;
  }
  const w = state.config.widgets.find(x => x.id === id);
  if (!w) {
    console.log('[UI] Widget definition not found');
    return;
  }
  console.log('[UI] Widget type:', w.t);
  switch (w.t) {
    case 'slider': el.querySelector('.rt-slider').value = val; el.querySelector('.rt-slider-val').textContent = val; break;
    case 'toggle': el.querySelector('.rt-toggle').classList.toggle('on', val === '1'); el.querySelector('.rt-toggle').textContent = val === '1' ? '😃' : '😴'; break;
    case 'led': {
      const ledEl = el.querySelector('.rt-led');
      const wdef = state.config.widgets.find(x => x.id === id);
      const onColor = wdef?.colorOn || '#ff5252';
      const offColor = wdef?.colorOff || '#2a2a3a';
      const model = (wdef?.model || 'dot');
      const on = val === '1';

      // Ensure model class is present (in case config changed live)
      ledEl.className = `rt-led model-${model}${on ? ' on' : ''}`;

      if (model === 'ring'){
        ledEl.style.background = 'transparent';
        ledEl.style.borderColor = on ? onColor : 'rgba(255,255,255,0.18)';
        ledEl.style.boxShadow = on ? `0 0 40px ${onColor}` : 'none';
      } else {
        ledEl.style.borderColor = '';
        ledEl.style.background = on ? onColor : offColor;
        ledEl.style.boxShadow = on ? `0 0 40px ${onColor}` : 'none';
      }

      console.log('[UI] LED', id, 'is now', on ? 'ON' : 'OFF');
      break;
    }
    case 'label': el.querySelector('.rt-label-text').textContent = val; break;
    case 'gauge': updateGaugeWidget(w, val); break;
    case 'graph': {
      // val is comma-separated numbers: "23.4,2.1"
      pushGraphPoint(w, val);
      const last = el.querySelector('[data-role="graphLast"]');
      if (last) last.textContent = val;
      drawGraphWidget(w);
      break;
    }
  }
}


// --- Move Build/Play tabs + Name input to top-right (no redesign) ---
function moveBuildPlayNameTopRight(){
  // UI polish: keep Build/Play tabs in the header (.hero-tabs) and the
  // title input in .builder-header where the HTML puts them. No-op.
  return;
}



// --- Place Build/Play + Name centered above the canvas (no overlap) ---

// --- Play mode UI: hide Build + Name, show a tiny Back control ---
function updateToolbarForMode(activeTab){
  const inner = document.getElementById('canvasToolbarInner') || document.querySelector('.canvas-toolbar-inner');
  if (!inner) return;

  const tabs = inner.querySelector('.tabs');
  const buildBtn = tabs ? tabs.querySelector('[data-tab="builder"]') : null;
  const playBtn  = tabs ? tabs.querySelector('[data-tab="runtime"]') : null;
  const nameInput = inner.querySelector('#titleInput');

  // Create back button once
  let back = inner.querySelector('#playBackBtn');
  if (!back){
    back = document.createElement('button');
    back.id = 'playBackBtn';
    back.className = 'tab';
    back.title = 'Back to edit';
    back.textContent = '⬅';
    back.style.display = 'none';
    back.addEventListener('click', () => {
      // switch to builder without using the Build label/button
      if (tabs){
        const b = tabs.querySelector('[data-tab="builder"]');
        if (b) b.click();
      }
    });
    // put it at the start
    if (tabs) tabs.insertBefore(back, tabs.firstChild);
    else inner.insertBefore(back, inner.firstChild);
  }

  if (activeTab === 'runtime'){
    if (buildBtn) buildBtn.style.display = 'none';
    if (nameInput) nameInput.style.display = 'none';
    back.style.display = '';
    // ensure play button looks active
    if (playBtn) playBtn.classList.add('active');
  }else{
    if (buildBtn) buildBtn.style.display = '';
    if (nameInput) nameInput.style.display = '';
    back.style.display = 'none';
  }
}


function ensureCanvasToolbar(){
  // UI polish: do not create a second toolbar above the canvas. Tabs live
  // in the header (.hero-tabs); titleInput lives in .builder-header. No-op.
  return;
}



// --- Replace "Tap a widget..." hint with the Build/Play/Name toolbar ---
function placeToolbarWhereHintWas(){
  // UI polish: keep the canvas hint in place and do not relocate the
  // (now non-existent) canvas toolbar over it. No-op.
  return;
}


document.addEventListener('DOMContentLoaded', init);

document.addEventListener('click', (e)=>{
  const btn = e.target && e.target.closest ? e.target.closest('[data-tab]') : null;
  if (!btn) return;
  const tab = btn.getAttribute('data-tab');
  try{ updateToolbarForMode(tab); }catch(e){}
});

(function(){
  // --- header height -> CSS var (avoid overlap with sticky header) ---
  function updateHeaderH(){
    const hdr = document.querySelector('.hero-header, header');
    const h = hdr ? Math.ceil(hdr.getBoundingClientRect().height) : 90;
    document.documentElement.style.setProperty('--headerH', h+'px');
  }
  window.addEventListener('resize', updateHeaderH);
  window.addEventListener('load', updateHeaderH);

  // --- auto-tidy widgets when canvas shrinks below their bounds ---
  let autoTidyT = null;
  function maybeAutoTidy(){
    try{
      if (!window.state || !Array.isArray(state.widgets) || !state.widgets.length) return;
      const wrap = document.querySelector('.canvas-wrap');
      const canvas = document.getElementById('canvas');
      if (!canvas) return;
      // Use the parent wrap's width as the real budget — the canvas itself
      // can over-grow if a widget is positioned past its max-width.
      const budget = Math.min(canvas.clientWidth, wrap ? wrap.clientWidth - 24 : canvas.clientWidth);
      if (budget < 80) return;
      const overflow = state.widgets.some(w => (w.x + w.w) > budget - 8);
      if (overflow && typeof autoArrangeWidgets === 'function'){
        autoArrangeWidgets();
      }
    }catch(e){}
  }
  window.addEventListener('resize', () => {
    clearTimeout(autoTidyT);
    autoTidyT = setTimeout(maybeAutoTidy, 180);
  });
  // Run several times after load — fonts, panels, and the resizable wrap
  // settle on different ticks.
  window.addEventListener('load', () => {
    setTimeout(maybeAutoTidy, 250);
    setTimeout(maybeAutoTidy, 800);
  });
  // Run when the user switches to builder tab (templates loaded into the
  // wrong canvas size before render).
  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest && e.target.closest('[data-tab="builder"]');
    if (t) setTimeout(maybeAutoTidy, 80);
  });
  // Run after a template card is chosen.
  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest && e.target.closest('.template-card');
    if (t) setTimeout(maybeAutoTidy, 120);
  });

  // --- helper UI creation ---
  function ensureHelperUI(){
    if (document.getElementById('helperPanel')) return;

    const panel = document.createElement('div');
    panel.id = 'helperPanel';
    panel.className = 'helper-panel';
    panel.style.display = 'none'; // default: avoid overlapping anything

    panel.innerHTML = `
      <div class="helper-titlebar" id="helperDrag">
        <div class="helper-title">🧰 Helper Tools</div>
        <div class="helper-actions">
          <button class="helper-action" id="helperFold" title="Fold">–</button>
          <button class="helper-action" id="helperClose" title="Hide">✕</button>
        </div>
      </div>
      <div class="helper-body">
        <details class="helper-details" open>
          <summary>🛠 Edit <span>▾</span></summary>
          <div class="helper-content" id="helperEdit"></div>
        </details>
        <details class="helper-details">
          <summary>📐 Arrange <span>▾</span></summary>
          <div class="helper-content" id="helperArrange"></div>
        </details>
        <details class="helper-details">
          <summary>🔎 View <span>▾</span></summary>
          <div class="helper-content" id="helperView"></div>
        </details>
        <details class="helper-details">
          <summary>🗺️ Minimap <span>▾</span></summary>
          <div class="helper-content" id="helperMini"></div>
        </details>
      </div>
    `;
    document.body.appendChild(panel);

    const fab = document.createElement('div');
    fab.id = 'helperFab';
    fab.className = 'helper-fab';
    fab.textContent = '🧰';
    document.body.appendChild(fab);

    // restore panel position if saved
    const saved = localStorage.getItem('helperPanelPos');
    if (saved){
      try{
        const {x,y} = JSON.parse(saved);
        if (Number.isFinite(x) && Number.isFinite(y)){
          panel.style.left = x+'px';
          panel.style.top = y+'px';
          panel.style.right = 'auto';
        }
      }catch(e){}
    }

    function isBad(el){
      if (!el) return true;
      if (el === document.documentElement || el === document.body) return false;
      if (el.closest && el.closest('.helper-panel')) return true;
      if (el.closest && el.closest('.modal, .modal-bg, .template-modal')) return true;
      // if it's a control, it's "not empty"
      if (el.closest && el.closest('button, a, input, select, textarea, .palette, .palette-card, .props-panel, .hero-header, header')) return true;
      return false;
    }
    function isGoodEmpty(el){
      if (!el) return true;
      if (el === document.documentElement || el === document.body) return true;
      // canvas area counts as "empty enough" for placing the icon (won't block clicks much)
      if (el.closest && (el.closest('#canvas') || el.closest('.canvas') || el.closest('main'))) return true;
      return false;
    }

    function pickFabSide(){
      const y = Math.max(80, window.innerHeight - 70);
      // candidate LEFT: either after left sidebar (if any) or 18px
      const leftBlock = document.querySelector('.left-panel, .sidebar-left, .side-left, .menu-left, .builder-sidebar, .palette-card, .palette');
      const leftX = leftBlock ? Math.ceil(leftBlock.getBoundingClientRect().right) + 14 : 18;

      // sample a few points in the icon area
      const sample = (x) => {
        const pts = [[x+18,y-18],[x+36,y-18],[x+18,y-36],[x+36,y-36]];
        for (const [px,py] of pts){
          const el = document.elementFromPoint(Math.min(window.innerWidth-1, px), Math.min(window.innerHeight-1, py));
          if (isBad(el)) return false;
        }
        // allow placement if area is generally background/canvas/main
        const el2 = document.elementFromPoint(Math.min(window.innerWidth-1, x+26), Math.min(window.innerHeight-1, y-26));
        return isGoodEmpty(el2);
      };

      if (sample(leftX)) return {side:'left', x:leftX};
      return {side:'right', x: null};
    }

    function placeFab(){
      const pick = pickFabSide();
      if (pick.side === 'left'){
        fab.style.left = pick.x + 'px';
        fab.style.right = 'auto';
      } else {
        fab.style.right = '18px';
        fab.style.left = 'auto';
      }
    }

    function showPanel(){
      fab.style.display = 'none';
      panel.style.display = 'block';
      updateHeaderH();
    }
    function hidePanel(){
      panel.style.display = 'none';
      placeFab();
      fab.style.display = 'flex';
    }

        // close hides; fold just collapses (does NOT hide)
    panel.querySelector('#helperClose').onclick = hidePanel;

    const foldBtn = panel.querySelector('#helperFold');
    function setFolded(on){
      panel.classList.toggle('folded', !!on);
      // icon switch: – when open, + when folded
      foldBtn.textContent = on ? '＋' : '–';
      foldBtn.title = on ? 'Expand' : 'Fold';
      try{ localStorage.setItem('helperPanelFolded', on ? '1' : '0'); }catch(e){}
    }
    // restore folded state - default to folded
    try{
      const savedFold = localStorage.getItem('helperPanelFolded');
      if (savedFold !== '0') setFolded(true); // Folded unless explicitly expanded
    }catch(e){ setFolded(true); }
    foldBtn.onclick = () => setFolded(!panel.classList.contains('folded'));

    fab.onclick = showPanel;

    // Place FAB initially (panel hidden by default)
    placeFab();
    window.addEventListener('resize', placeFab);

    // Dragging (use interact.js if present, else pointer events)
    function enableDrag(){
      const handle = panel.querySelector('#helperDrag');
      if (window.interact){
        let x = panel.offsetLeft, y = panel.offsetTop;
        // if positioned by right/top, offsetLeft might be 0; derive from rect
        const r = panel.getBoundingClientRect();
        x = r.left; y = r.top;

        interact(panel).draggable({
          allowFrom: '#helperDrag',
          listeners: {
            move (event) {
              x += event.dx;
              y += event.dy;
              // clamp in viewport
              const maxX = window.innerWidth - panel.offsetWidth - 6;
              const maxY = window.innerHeight - panel.offsetHeight - 6;
              x = Math.max(6, Math.min(maxX, x));
              y = Math.max(6, Math.min(maxY, y));

              panel.style.left = x + 'px';
              panel.style.top = y + 'px';
              panel.style.right = 'auto';
              localStorage.setItem('helperPanelPos', JSON.stringify({x, y}));
            }
          }
        });
      } else {
        let dragging=false, dx=0, dy=0;
        handle.addEventListener('pointerdown', (e)=>{
          dragging=true;
          const r = panel.getBoundingClientRect();
          dx = e.clientX - r.left;
          dy = e.clientY - r.top;
          handle.setPointerCapture(e.pointerId);
        });
        handle.addEventListener('pointermove', (e)=>{
          if (!dragging) return;
          let x = e.clientX - dx;
          let y = e.clientY - dy;
          const maxX = window.innerWidth - panel.offsetWidth - 6;
          const maxY = window.innerHeight - panel.offsetHeight - 6;
          x = Math.max(6, Math.min(maxX, x));
          y = Math.max(6, Math.min(maxY, y));
          panel.style.left = x+'px';
          panel.style.top = y+'px';
          panel.style.right = 'auto';
          localStorage.setItem('helperPanelPos', JSON.stringify({x,y}));
        });
        handle.addEventListener('pointerup', ()=> dragging=false);
      }
    }
    enableDrag();

    // Move existing canvas tools into this panel when they appear
    function moveToolsOnce(){
      const canvas = document.getElementById('canvas') || document.querySelector('.canvas');
      const smart = document.querySelector('.smart-toolbar');
      const tools = document.querySelector('.canvas-tools');
      const zoom = document.querySelector('.zoom-controls');
      const mini = document.querySelector('.minimap');

      if (!smart && !tools && !zoom && !mini) return false;

      // If they are inside canvas, move them
      if (smart) document.getElementById('helperView').appendChild(smart);
      if (zoom) document.getElementById('helperView').appendChild(zoom);
      if (tools) document.getElementById('helperEdit').appendChild(tools);
      if (mini) document.getElementById('helperMini').appendChild(mini);

      // Arrange buttons sometimes were inside smart-toolbar; keep as-is.
      // If there is a second toolbar group for arrange, keep it under Arrange section if present:
      const arrangeBar = document.querySelector('.smart-toolbar.arrange, .arrange-toolbar');
      if (arrangeBar) document.getElementById('helperArrange').appendChild(arrangeBar);

      // Remove any empty leftover wrappers in canvas
      if (canvas){
        canvas.querySelectorAll('.smart-toolbar, .canvas-tools, .zoom-controls, .minimap').forEach(()=>{});
      }
      return true;
    }

    // try a few times until app builds the tools
    let tries = 0;
    const timer = setInterval(()=>{
      tries++;
      if (moveToolsOnce() || tries > 40) clearInterval(timer);
    }, 250);

    // expose for debugging
    window.__helperTools = {showPanel, hidePanel, placeFab};
  }

  // Start after DOM is ready
  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', ensureHelperUI);
  } else {
    ensureHelperUI();
  }
})();
/*
  Single Source of Truth + Prop Sync + Warnings + Export Validation
  Source of truth: state.config.widgets
  - Builder DOM widgets mirror config widgets (props + x/y/w/h)
  - Runtime builds ONLY from config widgets (existing behavior)
  - Any UI parameter change must call setProp(id,key,val)
*/
(function(){
  if (window.__SST_PATCH__) return;
  window.__SST_PATCH__ = true;

  // Expose state for debugging/tools if not already
  try { if (window.state == null && typeof state !== "undefined") window.state = state; } catch(e){}

  function deepClone(o){ try{return JSON.parse(JSON.stringify(o));}catch(e){ return o; } }

  function cfgWidgets(){ return (window.state && state.config && Array.isArray(state.config.widgets)) ? state.config.widgets : null; }

  function findCfg(id){
    const arr = cfgWidgets(); if(!arr) return null;
    return arr.find(w=>w && w.id === id) || null;
  }

  // Ensure every config widget has props object
  function ensureProps(cfg){
    if(!cfg) return;
    if(!cfg.props || typeof cfg.props !== "object") cfg.props = {};
  }

  // Apply props to builder DOM widget (visual parity)
  function applyPropsToBuilder(el, cfg){
    if(!el || !cfg) return;
    ensureProps(cfg);
    const p = cfg.props;

    // Store type for generic handling
    if (cfg.type) el.dataset.type = cfg.type;

    // Generic label
    if (p.label != null){
      const lab = el.querySelector('.widget-label');
      if(lab) lab.textContent = p.label;
      el.dataset.label = p.label;
    }

    // LED colors
    if ((cfg.type === 'led') || el.classList.contains('led') || el.dataset.type === 'led'){
      // Use onColor/offColor if present; else fallback to previous defaults
      const onC  = p.onColor  || '#ff5252';
      const offC = p.offColor || 'rgba(255,82,82,0.2)';
      el.dataset.onColor = onC;
      el.dataset.offColor = offC;
      // In builder we show "off" by default unless p.isOn
      const isOn = !!p.isOn;
      el.style.background = isOn ? onC : offC;
    }

    // Button bg color (optional)
    if (cfg.type === 'button' && p.color){
      el.style.background = p.color;
    }

    // Switch/toggle colors (optional)
    if ((cfg.type === 'toggle' || cfg.type === 'switch') && (p.onColor || p.offColor)){
      const isOn = !!p.isOn;
      if (isOn && p.onColor) el.style.background = p.onColor;
      if (!isOn && p.offColor) el.style.background = p.offColor;
    }
  }

  // Apply props to runtime element right after creation (visual parity)
  function applyPropsToRuntime(rtEl, cfg){
    if(!rtEl || !cfg) return;
    ensureProps(cfg);
    const p = cfg.props;

    // LED runtime element uses .rt-led
    if ((cfg.type === 'led') || rtEl.classList.contains('rt-led')){
      const led = rtEl.querySelector('.rt-led') || rtEl;
      const onC  = p.onColor  || '#ff5252';
      const offC = p.offColor || 'rgba(255,82,82,0.2)';
      const isOn = !!p.isOn;
      led.style.background = isOn ? onC : offC;
      if (led.classList.contains('rt-led')){
        led.classList.toggle('on', isOn);
      }
    }

    // Generic label
    if (p.label != null){
      const t = rtEl.querySelector('.rt-label-text');
      if(t) t.textContent = p.label;
    }

    // Button
    if (cfg.type === 'button' && p.color){
      const b = rtEl.querySelector('button') || rtEl;
      b.style.background = p.color;
    }
  }

  // === Single Source of Truth API ===
  window.setProp = function(id, key, val){
    const cfg = findCfg(id);
    if(!cfg) return false;
    ensureProps(cfg);
    cfg.props[key] = val;

    // Mirror to builder element if present
    const el = document.querySelector(`.widget[data-id="${CSS.escape(id)}"]`) || document.getElementById(id);
    if(el) applyPropsToBuilder(el, cfg);

    // If runtime is active, re-render (safe)
    if (state && state.mode === 'runtime' && typeof window.renderRuntime === 'function'){
      try { window.renderRuntime(); } catch(e){}
    }
    return true;
  };

  window.getProp = function(id, key){
    const cfg = findCfg(id);
    if(!cfg || !cfg.props) return undefined;
    return cfg.props[key];
  };

  // === Hook: whenever a builder widget is created/loaded, copy its visual props into config if missing ===
  function normalizeBuilderWidget(el){
    if(!el) return;
    const id = el.dataset.id || el.id;
    if(!id) return;
    const cfg = findCfg(id);
    if(!cfg) return;
    ensureProps(cfg);

    // If LED has dataset or style but props missing -> fill
    if ((cfg.type === 'led') || el.dataset.type === 'led'){
      if(!cfg.props.onColor){
        const c = el.dataset.onColor || el.style.backgroundColor || '#ff5252';
        cfg.props.onColor = c;
      }
      if(!cfg.props.offColor){
        cfg.props.offColor = el.dataset.offColor || 'rgba(255,82,82,0.2)';
      }
    }

    // Label
    const lab = el.querySelector('.widget-label');
    if(lab && cfg.props.label == null) cfg.props.label = lab.textContent;

    applyPropsToBuilder(el, cfg);
  }

  // Run once after load
  window.addEventListener('load', ()=>{
    document.querySelectorAll('.widget').forEach(normalizeBuilderWidget);
  });

  // Observe widgets layer to normalize new widgets
  const layer = document.getElementById('widgetsLayer') || document.querySelector('#widgetsLayer');
  if (layer && window.MutationObserver){
    const mo = new MutationObserver(muts=>{
      muts.forEach(m=>{
        m.addedNodes && m.addedNodes.forEach(n=>{
          if(n && n.classList && n.classList.contains('widget')) normalizeBuilderWidget(n);
          if(n && n.querySelectorAll) n.querySelectorAll('.widget').forEach(normalizeBuilderWidget);
        });
      });
    });
    mo.observe(layer, {childList:true, subtree:true});
  }

  // === Hook color inputs in properties panel (generic) ===
  // Many color pickers exist; we map by label text near it if possible, else fallback to LED onColor.
  document.addEventListener('input', (e)=>{
    const t = e.target;
    if(!t || t.type !== 'color') return;
    const sw = window.selectedWidget;
    if(!sw) return;
    const id = sw.dataset.id || sw.id;
    if(!id) return;

    // Try infer which color field it is
    let key = 'color';
    const lab = t.closest('label') || t.parentElement;
    const txt = (lab && lab.textContent) ? lab.textContent.toLowerCase() : '';
    if (txt.includes('on')) key = 'onColor';
    else if (txt.includes('off')) key = 'offColor';
    else if ((findCfg(id)||{}).type === 'led') key = 'onColor';

    window.setProp(id, key, t.value);
  }, true);

  // === Runtime creation hook: after renderRuntime finishes, apply props to runtime nodes ===
  const origRender = window.renderRuntime;
  if (typeof origRender === 'function'){
    window.renderRuntime = function(){
      const r = origRender.apply(this, arguments);
      try{
        // Attempt to map runtime nodes by data-id or id
        const arr = cfgWidgets() || [];
        arr.forEach(cfg=>{
          const rid = cfg.id;
          let rt = document.querySelector(`#runtimeGrid [data-id="${CSS.escape(rid)}"]`)
                || document.querySelector(`#runtimeGrid #${CSS.escape(rid)}`);
          // If not found, try common class container
          if(rt) applyPropsToRuntime(rt, cfg);
        });
      }catch(e){}
      return r;
    };
  }

  // === Warnings panel: visual state but no props ===
  const warn = document.createElement('div');
  warn.id = 'warnPanel';
  warn.style.cssText = `
    position:fixed; top:calc(var(--headerH, 90px) + 8px); left:10px;
    width:min(340px, 90vw); max-height:32vh; overflow:auto;
    background:rgba(255,165,0,.12); border:2px solid rgba(255,165,0,.85);
    border-radius:12px; padding:10px; z-index:160; color:#fff;
    font:12px system-ui, sans-serif; display:none;
  `;
  warn.innerHTML = `<div style="font-weight:900;letter-spacing:.08em;text-transform:uppercase;">⚠ Props Warnings</div>
  <div id="warnBody" style="margin-top:6px;opacity:.95"></div>`;
  document.body.appendChild(warn);

  function scanWarnings(){
    const arr = cfgWidgets(); if(!arr) return;
    const issues = [];
    arr.forEach(w=>{
      if(!w) return;
      if(!w.props) issues.push({id:w.id, msg:'Missing props object'});
      else if (w.type === 'led'){
        if(!w.props.onColor) issues.push({id:w.id, msg:'LED missing onColor (runtime will default red)'});
        if(!w.props.offColor) issues.push({id:w.id, msg:'LED missing offColor'});
      }
    });
    const body = document.getElementById('warnBody');
    if(!body) return;
    if(issues.length===0){ warn.style.display='none'; return; }
    warn.style.display='block';
    body.innerHTML = issues.map(x=>`<div style="margin:6px 0;"><b>${x.id}</b>: ${x.msg}</div>`).join('');
  }
  setInterval(scanWarnings, 800);

  // === Export-time validation ===
  // If there is an export function, wrap it; else add a button in helper tools if found.
  function validateConfig(){
    const arr = cfgWidgets(); if(!arr) return {ok:true, issues:[]};
    const issues = [];
    arr.forEach(w=>{
      if(!w) return;
      if(!w.props) issues.push(`${w.id}: missing props`);
      if(w.type==='led' && w.props){
        if(!w.props.onColor) issues.push(`${w.id}: LED missing onColor`);
      }
    });
    return {ok: issues.length===0, issues};
  }

  function alertIssues(res){
    if(res.ok) return true;
    alert("Export blocked: fix these first\\n\\n" + res.issues.join("\\n"));
    return false;
  }

  // Try wrap exportProject if exists
  if (typeof window.exportProject === 'function'){
    const orig = window.exportProject;
    window.exportProject = function(){
      const res = validateConfig();
      if(!alertIssues(res)) return;
      return orig.apply(this, arguments);
    };
  }
})();
(function(){
  if(window.__SEL_PATCH__) return;
  window.__SEL_PATCH__ = true;

  function cfgArr(){ return (window.state && state.config && Array.isArray(state.config.widgets)) ? state.config.widgets : []; }
  function findCfg(id){ return cfgArr().find(w=>w && w.id===id) || null; }
  function linkProps(el){
    if(!el) return;
    const id = el.dataset.id || el.id;
    if(!id) return;
    const cfg = findCfg(id);
    if(!cfg) return;
    if(!cfg.props || typeof cfg.props!=="object") cfg.props = {};
    // Single source of truth: builder widget points to cfg.props (same object)
    el.props = cfg.props;
    try{ el.dataset.type = cfg.type || el.dataset.type; }catch(e){}
  }

  // Capture clicks/taps to set selectedWidget reliably
  document.addEventListener('pointerdown', (e)=>{
    const w = e.target && e.target.closest ? e.target.closest('.widget') : null;
    if(!w) return;
    linkProps(w);
    window.selectedWidget = w;
  }, true);

  // Also sync when original code sets selection via click
  document.addEventListener('click', (e)=>{
    const w = e.target && e.target.closest ? e.target.closest('.widget') : null;
    if(!w) return;
    linkProps(w);
    window.selectedWidget = w;
  }, true);

  // Normalize existing widgets once
  window.addEventListener('load', ()=>{
    document.querySelectorAll('.widget').forEach(linkProps);
  });
})();
/* === Helper Tools: ensure buttons actually exist (create if missing) === */
(function(){
  if (window.__HELPER_TOOLS_BUILDER__) return;
  window.__HELPER_TOOLS_BUILDER__ = true;

  function $(s){ return document.querySelector(s); }

  function buildHelperTools(){
    const panel = document.getElementById('helperPanel');
    if(!panel) return false;

    const edit = document.getElementById('helperEdit');
    const arrange = document.getElementById('helperArrange');
    const view = document.getElementById('helperView');
    const miniWrap = document.getElementById('helperMini');

    if(!edit || !arrange || !view || !miniWrap) return false;

    // If already populated, do nothing
    if (edit.children.length || arrange.children.length || view.children.length) return true;

    // --- Create toolbars (same ids as the rest of your app expects) ---
    const tools = document.createElement('div');
    tools.className = 'canvas-tools';
    tools.innerHTML = `
      <button class="canvas-tool-btn" id="duplicateBtn" title="Duplicate (Ctrl+D)">⧉</button>
      <button class="canvas-tool-btn" id="groupBtn" title="Group (Ctrl+G)">⚭</button>
      <button class="canvas-tool-btn" id="layersBtn" title="Layers (L)">☰</button>
      <button class="canvas-tool-btn" id="themeBtn" title="Theme (T)">🎨</button>
      <button class="canvas-tool-btn" id="bgBtn" title="Canvas Background">🖼️</button>
      <button class="canvas-tool-btn" id="shareBtn" title="Share QR">📱</button>
      <button class="canvas-tool-btn" id="screenshotBtn" title="Screenshot">📸</button>
      <button class="canvas-tool-btn" id="sensorBtn" title="Sensor Sim">🎮</button>
      <button class="canvas-tool-btn" id="pinBtn" title="Pin Reference">📌</button>
      <button class="canvas-tool-btn" id="contrastBtn" title="High Contrast">◐</button>
      <button class="canvas-tool-btn" id="helpBtn" title="Help (?)">❓</button>
    `;
    edit.appendChild(tools);

    const arrangeBar = document.createElement('div');
    arrangeBar.className = 'smart-toolbar arrange-toolbar';
    arrangeBar.innerHTML = `
      <div class="toolbar-group">
        <button class="canvas-tool-btn" id="arrangeGrid" title="Auto Grid">⊞</button>
        <button class="canvas-tool-btn" id="arrangeRows" title="Rows">≡</button>
        <button class="canvas-tool-btn" id="arrangeCols" title="Columns">⫾</button>
      </div>
      <div class="toolbar-group">
        <button class="canvas-tool-btn" id="alignL" title="Align Left">⫷</button>
        <button class="canvas-tool-btn" id="alignR" title="Align Right">⫸</button>
        <button class="canvas-tool-btn" id="alignT" title="Align Top">⊤</button>
        <button class="canvas-tool-btn" id="alignB" title="Align Bottom">⊥</button>
        <button class="canvas-tool-btn" id="distH" title="Distribute H">↔</button>
        <button class="canvas-tool-btn" id="distV" title="Distribute V">↕</button>
      </div>
    `;
    arrange.appendChild(arrangeBar);

    const viewBar = document.createElement('div');
    viewBar.className = 'smart-toolbar';
    viewBar.innerHTML = `
      <div class="toolbar-group">
        <button class="canvas-tool-btn ${window.state?.gridSnap ? 'active' : ''}" id="gridToggle" title="Grid Snap (G)">⊞</button>
        <button class="canvas-tool-btn ${window.state?.showGuides ? 'active' : ''}" id="guidesToggle" title="Guides">┼</button>
        <button class="canvas-tool-btn" id="rulerToggle" title="Ruler">📏</button>
      </div>
    `;
    view.appendChild(viewBar);

    const zoom = document.createElement('div');
    zoom.className = 'zoom-controls';
    zoom.innerHTML = `
      <button class="zoom-btn" id="zoomOut">−</button>
      <div class="zoom-level" id="zoomLevel">100%</div>
      <button class="zoom-btn" id="zoomIn">+</button>
    `;
    view.appendChild(zoom);

    // Minimap container exists in panel; make sure minimap element exists
    let mini = miniWrap.querySelector('.minimap');
    if(!mini){
      mini = document.createElement('div');
      mini.className = 'minimap';
      miniWrap.appendChild(mini);
    }

    // --- Wire events (guard if functions exist) ---
    const bind = (id, fnName) => {
      const el = document.getElementById(id);
      const fn = window[fnName];
      if(el && typeof fn === 'function') el.onclick = fn;
    };

    bind('duplicateBtn','duplicateSelected');
    bind('groupBtn','groupSelected');
    bind('layersBtn','toggleLayers');
    bind('themeBtn','cycleTheme');
    bind('bgBtn','setCanvasBackground');
    bind('shareBtn','generateQR');
    bind('screenshotBtn','exportScreenshot');
    bind('sensorBtn','toggleSensorSim');
    bind('pinBtn','showPinMapping');
    bind('contrastBtn','toggleHighContrast');
    bind('helpBtn','showHelp');

    bind('arrangeGrid','autoArrangeGrid');
    bind('arrangeRows','autoArrangeRows');
    bind('arrangeCols','autoArrangeCols');
    bind('alignL','alignLeft');
    bind('alignR','alignRight');
    bind('alignT','alignTop');
    bind('alignB','alignBottom');
    bind('distH','distributeH');
    bind('distV','distributeV');

    const gridToggle = document.getElementById('gridToggle');
    if(gridToggle){
      gridToggle.onclick = () => {
        if(!window.state) return;
        state.gridSnap = !state.gridSnap;
        gridToggle.classList.toggle('active', state.gridSnap);
        const c = document.getElementById('canvas');
        if(c) c.classList.toggle('show-grid', state.gridSnap);
        if(typeof window.toast==='function') toast(state.gridSnap ? '⊞ Grid ON' : '⊞ Grid OFF', 'success');
      };
    }
    const guidesToggle = document.getElementById('guidesToggle');
    if(guidesToggle){
      guidesToggle.onclick = () => {
        if(!window.state) return;
        state.showGuides = !state.showGuides;
        guidesToggle.classList.toggle('active', state.showGuides);
        if(typeof window.toast==='function') toast(state.showGuides ? '┼ Guides ON' : '┼ Guides OFF', 'success');
      };
    }
    bind('rulerToggle','toggleRuler');

    const zoomIn = document.getElementById('zoomIn');
    const zoomOut = document.getElementById('zoomOut');
    if(zoomIn && typeof window.setZoom==='function') zoomIn.onclick = () => setZoom((state.zoom||1) + 0.1);
    if(zoomOut && typeof window.setZoom==='function') zoomOut.onclick = () => setZoom((state.zoom||1) - 0.1);

    return true;
  }

  // Make sure the helper panel exists and is populated once the app is ready
  const origEnsure = window.ensureHelperUI;
  window.ensureHelperUI = function(){
    const r = origEnsure ? origEnsure.apply(this, arguments) : undefined;
    // try populate after creation
    setTimeout(buildHelperTools, 0);
    setTimeout(buildHelperTools, 250);
    setTimeout(buildHelperTools, 800);
    return r;
  };

  // If setupCanvasTools exists, ensure it creates panel + tools
  const origSetup = window.setupCanvasTools;
  window.setupCanvasTools = function(){
    const r = origSetup ? origSetup.apply(this, arguments) : undefined;
    try{ window.ensureHelperUI(); }catch(e){}
    setTimeout(buildHelperTools, 0);
    return r;
  };

  window.addEventListener('load', ()=>{
    try{ window.ensureHelperUI(); }catch(e){}
    buildHelperTools();
  });
})();
/* === Default View Settings === */
(function(){
  try{
    if(window.state){
      state.gridSnap = false;
      state.showGrid = false;
      state.showGuides = false;
      state.showRuler = true;
    }
  }catch(e){}
})();
/* === Default View Settings (final) === */
(function(){
  try{
    if(window.state){
      state.gridSnap = false;
      state.showGrid = false;
      state.showGuides = true;   // guides ON
      state.showRuler = true;   // ruler ON
    }
  }catch(e){}
})();
(function(){
  const DEFAULT_FILTERS = { ble:true, ok:true, warn:true, error:true, info:true, debug:false, log:true };
  let filters = {...DEFAULT_FILTERS};
  let collapsed = true;
  const MAX_ITEMS = 1500;
  const items = [];
  const $ = (id)=>document.getElementById(id);

  function pad(n,w=2){ return String(n).padStart(w,'0'); }
  function stamp(){
    const d=new Date();
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(),3)}`;
  }
  function safeJson(x){ try{ return JSON.stringify(x); }catch(e){ return String(x); } }
  function fmt(args){
    return args.map(x=>{
      if (x instanceof Error) return (x.stack || x.message || String(x));
      if (typeof x === 'object') return safeJson(x);
      return String(x);
    }).join(' ');
  }

  function detect(level,msg){
    const s=String(msg);
    let dir=null, out=s, lvl=level||'log';
    const rx=/^\s*\[?BLE\s*RX\]?\s*[:\-]?\s*/i;
    const tx=/^\s*\[?BLE\s*TX\]?\s*[:\-]?\s*/i;
    if (rx.test(s)){ dir='RX'; out=s.replace(rx,''); lvl='ble'; }
    else if (tx.test(s)){ dir='TX'; out=s.replace(tx,''); lvl='ble'; }
    else if (/^\s*\[BLE\]\s*/i.test(s)){ lvl='ble'; out=s.replace(/^\s*\[BLE\]\s*/i,''); }
    return {lvl,dir,out};
  }

  function push(level,msg,meta={}){
    const d=detect(level,msg);
    const it={ ts: stamp(), level: d.lvl, dir: d.dir || meta.dir || null, msg: d.out };
    items.push(it);
    while(items.length>MAX_ITEMS) items.shift();
    updateCount();
    renderSoon();
  }

  function updateCount(){
    const c=$('logCount'); if(!c) return;
    c.textContent = String(items.length);
  }

  function escapeHtml(s){
    return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#039;");
  }

  let raf=0;
  function renderSoon(force=false){
    if (collapsed && !force) return;
    if (raf) return;
    raf=requestAnimationFrame(()=>{ raf=0; render(); adjustLayout(); });
  }

  function render(){
    const body=$('logBody'); if(!body) return;
    const allow=(lvl)=>!!filters[lvl];
    const html=[];
    for(const it of items){
      if(!allow(it.level)) continue;
      const cls=['log-line', `level-${it.level}`, it.dir?`dir-${it.dir.toLowerCase()}`:''].filter(Boolean).join(' ');
      const tag = it.dir ? `${it.level.toUpperCase()} ${it.dir}` : it.level.toUpperCase();
      html.push(
        `<div class="${cls}"><span class="ts">${escapeHtml(it.ts)}</span><span class="tag">${escapeHtml(tag)}</span><span class="msg">${escapeHtml(it.msg)}</span></div>`
      );
    }
    body.innerHTML = html.join('');
    body.scrollTop = body.scrollHeight;
  }

  // Expose layout adjuster for other injections
  window.__adjustLogsLayout = adjustLayout;
  function adjustLayout(){
    const card=$('logCard');
    const canvasWrap=document.querySelector('.canvas-wrap');
    const resizableWrap=document.getElementById('resizableWrap');
    if(!card) return;
    const h=card.getBoundingClientRect().height||0;
    if(canvasWrap) canvasWrap.style.paddingBottom=(h+14)+'px';
    if(resizableWrap){
      const top=resizableWrap.getBoundingClientRect().top||0;
      const maxH=Math.max(320, Math.floor(window.innerHeight - top - h - 24));
      resizableWrap.style.maxHeight=maxH+'px';
    }
  }

  // Filters UI
  function buildFilters(){
    const host=$('logFilters'); if(!host) return;
    try{
      const saved=JSON.parse(localStorage.getItem('logFilters')||'null');
      if(saved && typeof saved==='object') filters={...filters, ...saved};
    }catch(e){}
    host.innerHTML = `
      <label class="log-chip"><input type="checkbox" data-lvl="ble">BLE</label>
      <label class="log-chip"><input type="checkbox" data-lvl="ok">OK</label>
      <label class="log-chip"><input type="checkbox" data-lvl="warn">WARN</label>
      <label class="log-chip"><input type="checkbox" data-lvl="error">ERROR</label>
      <label class="log-chip"><input type="checkbox" data-lvl="info">INFO</label>
      <label class="log-chip"><input type="checkbox" data-lvl="debug">DEBUG</label>
      <label class="log-chip"><input type="checkbox" data-lvl="log">LOG</label>
    `;
    host.querySelectorAll('input[data-lvl]').forEach(inp=>{
      const lvl=inp.getAttribute('data-lvl');
      inp.checked=!!filters[lvl];
      inp.addEventListener('change', ()=>{
        filters[lvl]=inp.checked;
        localStorage.setItem('logFilters', JSON.stringify(filters));
        renderSoon(true);
      });
    });
  }

  // Export
  function exportTxt(){
    const lines = items.map(it => `[${it.ts}] ${it.level.toUpperCase()}${it.dir?(' '+it.dir):''}  ${it.msg}`);
    const blob = new Blob([lines.join('\\n')], {type:'text/plain'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download='logs.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function exportJson(){
    const blob = new Blob([JSON.stringify(items, null, 2)], {type:'application/json'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download='logs.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // Toggle open/close
  function setCollapsed(next){
    collapsed = next;
    const card=$('logCard'), t=$('logToggle');
    if(card) card.classList.toggle('collapsed', collapsed);
    if(t){
      t.textContent = collapsed ? '▸' : '▾';
      t.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
    try{ localStorage.setItem('logCardCollapsed', collapsed ? '1':'0'); }catch(e){}
    // When expanding, force immediate render after DOM updates
    if (!collapsed) {
      setTimeout(() => { render(); adjustLayout(); }, 10);
    }
    adjustLayout();
  }
  function toggle(){ setCollapsed(!collapsed); }

  // APPLOG API (use this for important events)
  window.APPLOG = {
    log:(...a)=>push('log',fmt(a)),
    info:(...a)=>push('info',fmt(a)),
    debug:(...a)=>push('debug',fmt(a)),
    ble:(...a)=>push('ble',fmt(a)),
    rx:(...a)=>push('ble',fmt(a),{dir:'RX'}),
    tx:(...a)=>push('ble',fmt(a),{dir:'TX'}),
    ok:(...a)=>push('ok',fmt(a)),
    warn:(...a)=>push('warn',fmt(a)),
    err:(...a)=>push('error',fmt(a)),
    clear:()=>{ items.length=0; updateCount(); renderSoon(true); },
    exportTxt, exportJson, toggle, open:()=>setCollapsed(false)
  };

  // Silence DevTools console completely, but capture into logs:
  console.log   = (...a)=>push('log',fmt(a));
  console.info  = (...a)=>push('info',fmt(a));
  console.debug = (...a)=>push('debug',fmt(a));
  console.warn  = (...a)=>push('warn',fmt(a));
  console.error = (...a)=>push('error',fmt(a));

  // Capture uncaught errors (and prevent console spam)
  window.addEventListener('error', (e)=>{ push('error', e.message || 'Uncaught error'); e.preventDefault && e.preventDefault(); }, true);
  window.addEventListener('unhandledrejection', (e)=>{ push('error', String(e.reason)); e.preventDefault && e.preventDefault(); }, true);

  // Wire UI
  window.addEventListener('DOMContentLoaded', ()=>{
    buildFilters();

    // restore collapsed state - default to collapsed
    const saved = localStorage.getItem('logCardCollapsed');
    setCollapsed(saved !== '0'); // Collapsed unless explicitly set to expanded

    $('logToggle')?.addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation(); toggle(); }, {passive:false});
    $('logTab')?.addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation(); toggle(); }, {passive:false});

    $('logClear')?.addEventListener('click', ()=>window.APPLOG.clear());
    $('logExportTxt')?.addEventListener('click', exportTxt);
    $('logExportJson')?.addEventListener('click', exportJson);

    // keyboard toggle
    window.addEventListener('keydown', (e)=>{
      if(e.ctrlKey && e.shiftKey && (e.key==='L' || e.key==='l')){ e.preventDefault(); toggle(); }
    }, {passive:false});

    // initial message
    push('ok', 'Logs ready (Ctrl+Shift+L). TX=orange, RX=cyan.');
    adjustLayout();
  });

  window.addEventListener('resize', ()=>adjustLayout());

})();
(function() {
  // Zoom functionality
  let currentZoom = 1;
  const minZoom = 0.5;
  const maxZoom = 3;
  const zoomStep = 0.15;
  
  const zoomLevel = document.getElementById('zoomLevel');
  const zoomInBtn = document.getElementById('zoomInBtn');
  const zoomOutBtn = document.getElementById('zoomOutBtn');
  const zoomFitBtn = document.getElementById('zoomFitBtn');
  const zoomResetBtn = document.getElementById('zoomResetBtn');
  
  function getZoomTarget() {
    // In fullscreen mode, zoom the runtime grid only
    if (document.body.classList.contains('runtime-fullscreen')) {
      return document.getElementById('runtimeGrid');
    }
    // In normal runtime view, still zoom the grid
    const runtimeView = document.querySelector('.runtime-view');
    if (runtimeView && runtimeView.classList.contains('active')) {
      return document.getElementById('runtimeGrid');
    }
    // Otherwise zoom the app (builder mode)
    return document.querySelector('.app');
  }
  
  function applyZoom(zoom) {
    currentZoom = Math.max(minZoom, Math.min(maxZoom, zoom));
    
    const target = getZoomTarget();
    if (target) {
      // Use top left origin for consistent cross-browser behavior
      // Center origin can cause layout shifts in some browsers
      target.style.transform = `scale(${currentZoom})`;
      target.style.transformOrigin = 'top left';
      
      // For the app container, adjust body scroll if needed
      if (target.classList.contains('app') || target.classList.contains('app-scaler')) {
        document.body.classList.toggle('scaled', currentZoom !== 1);
      }
    }
    
    // Update display
    if (zoomLevel) {
      zoomLevel.textContent = Math.round(currentZoom * 100) + '%';
    }
    
    // Save preference (only if valid)
    if (currentZoom >= 0.5 && currentZoom <= 3) {
      try { localStorage.setItem('app_zoom', currentZoom); } catch(e) {}
    }
  }
  
  function zoomIn() {
    applyZoom(currentZoom + zoomStep);
  }
  
  function zoomOut() {
    applyZoom(currentZoom - zoomStep);
  }
  
  function zoomFit() {
    // Fit the runtime grid to screen
    const grid = document.getElementById('runtimeGrid');
    if (!grid) return;
    
    // Reset zoom first to get actual size
    grid.style.transform = '';
    
    const gridW = grid.offsetWidth;
    const gridH = grid.offsetHeight;
    const availW = window.innerWidth - 80;
    const availH = window.innerHeight - 120;
    
    const fitZoom = Math.min(availW / gridW, availH / gridH, 2);
    applyZoom(fitZoom);
  }
  
  function zoomReset() {
    applyZoom(1);
  }
  
  // Event listeners
  if (zoomInBtn) zoomInBtn.onclick = zoomIn;
  if (zoomOutBtn) zoomOutBtn.onclick = zoomOut;
  if (zoomFitBtn) zoomFitBtn.onclick = zoomFit;
  if (zoomResetBtn) zoomResetBtn.onclick = zoomReset;
  
  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + Plus/Minus for zoom
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        zoomIn();
      } else if (e.key === '-') {
        e.preventDefault();
        zoomOut();
      } else if (e.key === '0') {
        e.preventDefault();
        zoomReset();
      }
    }
  });
  
  // Mouse wheel zoom with Ctrl
  document.addEventListener('wheel', (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      if (e.deltaY < 0) {
        zoomIn();
      } else {
        zoomOut();
      }
    }
  }, { passive: false });
  
  // Pinch zoom for touch devices
  let lastTouchDistance = 0;
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastTouchDistance = Math.sqrt(dx * dx + dy * dy);
    }
  }, { passive: true });
  
  document.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      if (lastTouchDistance > 0) {
        const delta = (distance - lastTouchDistance) / 200;
        applyZoom(currentZoom + delta);
      }
      
      lastTouchDistance = distance;
    }
  }, { passive: true });
  
  document.addEventListener('touchend', () => {
    lastTouchDistance = 0;
  }, { passive: true });
  
  // Load saved zoom (with validation)
  try {
    // Check for reset parameter in URL
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('reset_zoom') === '1' || urlParams.get('reset') === '1') {
      localStorage.removeItem('app_zoom');
      console.log('[Zoom] Reset via URL parameter');
      // Clean URL
      if (window.history.replaceState) {
        const cleanUrl = window.location.pathname + window.location.hash;
        window.history.replaceState({}, '', cleanUrl);
      }
    }
    
    const savedZoom = localStorage.getItem('app_zoom');
    if (savedZoom) {
      const parsed = parseFloat(savedZoom);
      // Validate zoom is in reasonable range (0.5 to 3)
      if (!isNaN(parsed) && parsed >= 0.5 && parsed <= 3) {
        applyZoom(parsed);
      } else {
        // Invalid zoom value - remove it and use default
        console.warn('[Zoom] Invalid saved zoom:', savedZoom, '- resetting to 1');
        localStorage.removeItem('app_zoom');
        applyZoom(1);
      }
    }
  } catch(e) {
    console.warn('[Zoom] Error loading saved zoom:', e);
  }
  
  // Expose for other scripts
  window.appZoom = {
    zoomIn,
    zoomOut,
    zoomFit,
    zoomReset,
    getZoom: () => currentZoom,
    setZoom: applyZoom
  };
})();
(function(){
  const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
  function applyWH(w,h){
    const card=document.getElementById('logCard'); if(!card) return;
    const W=clamp(Math.floor(w||380), 260, 960);
    const H=clamp(Math.floor(h||420), 220, Math.floor(window.innerHeight-20));
    card.style.setProperty('--logsW', W+'px');
    card.style.setProperty('--logsH', H+'px');
    card.style.setProperty('width', W+'px', 'important');
    card.style.setProperty('height', H+'px', 'important');
    card.style.width=W+'px'; card.style.height=H+'px';
    try{ localStorage.setItem('logsWidth', String(W)); localStorage.setItem('logsHeight', String(H)); }catch(e){}
    try{
      const pad = card.classList.contains('collapsed') ? 0 : Math.min(740, W + 18);
      const canvasWrap=document.querySelector('.canvas-wrap');
      if(canvasWrap){ canvasWrap.style.paddingRight = pad+'px'; canvasWrap.style.paddingBottom=''; }
    }catch(e){}
  }
  function ensure(){
    const card=document.getElementById('logCard'); if(!card) return false;
    // Add handles
    if(!document.getElementById('logResizeHandleX')){
      const hx=document.createElement('div'); hx.id='logResizeHandleX'; card.appendChild(hx);
      const hy=document.createElement('div'); hy.id='logResizeHandleY'; card.appendChild(hy);
      const hxy=document.createElement('div'); hxy.id='logResizeHandleXY'; card.appendChild(hxy);
    }
    // Apply saved
    try{
      const sw=parseInt(localStorage.getItem('logsWidth')||'380',10);
      const sh=parseInt(localStorage.getItem('logsHeight')||'420',10);
      applyWH(Number.isNaN(sw)?380:sw, Number.isNaN(sh)?420:sh);
    }catch(e){ applyWH(380,420); }
    if(card.__resizerBound) return true;
    card.__resizerBound=true;

    function cx(e){ if(e.touches&&e.touches[0]) return e.touches[0].clientX; if(e.changedTouches&&e.changedTouches[0]) return e.changedTouches[0].clientX; return e.clientX; }
    function cy(e){ if(e.touches&&e.touches[0]) return e.touches[0].clientY; if(e.changedTouches&&e.changedTouches[0]) return e.changedTouches[0].clientY; return e.clientY; }

    const hx=document.getElementById('logResizeHandleX');
    const hy=document.getElementById('logResizeHandleY');
    const hxy=document.getElementById('logResizeHandleXY');

    let mode=null, startX=0, startY=0, startW=0, startH=0;

    function down(m,e){
      if(card.classList.contains('collapsed')) return;
      mode=m;
      startX=cx(e); startY=cy(e);
      const r=card.getBoundingClientRect();
      startW=r.width; startH=r.height;
      document.body.style.userSelect='none';
      document.body.style.cursor = (m==='x'?'ew-resize':m==='y'?'ns-resize':'nwse-resize');
      e.preventDefault?.();
    }
    function move(e){
      if(!mode) return;
      const dx=cx(e)-startX;
      const dy=cy(e)-startY;
      // left-edge drag for X => width increases when moving left (negative dx)
      let W=startW, H=startH;
      if(mode==='x') W = startW - dx;
      if(mode==='y') H = startH + dy; // bottom edge
      if(mode==='xy'){ W = startW - dx; H = startH + dy; }
      applyWH(W,H);
      e.preventDefault?.();
    }
    function up(){
      if(!mode) return;
      mode=null;
      document.body.style.userSelect='';
      document.body.style.cursor='';
    }

    // Bind events
    function bindHandle(el,m){
      el.addEventListener('pointerdown', down.bind(null,m), {passive:false});
      el.addEventListener('mousedown', down.bind(null,m), {passive:false});
      el.addEventListener('touchstart', down.bind(null,m), {passive:false});
    }
    bindHandle(hx,'x'); bindHandle(hy,'y'); bindHandle(hxy,'xy');

    window.addEventListener('pointermove', move, {passive:false});
    window.addEventListener('pointerup', up, {passive:true});
    window.addEventListener('pointercancel', up, {passive:true});
    window.addEventListener('mousemove', move, {passive:false});
    window.addEventListener('mouseup', up, {passive:true});
    window.addEventListener('touchmove', move, {passive:false});
    window.addEventListener('touchend', up, {passive:true});
    window.addEventListener('touchcancel', up, {passive:true});

    return true;
  }

  let tries=0;
  const timer=setInterval(()=>{ if(ensure() || ++tries>140) clearInterval(timer); }, 150);
  const obs=new MutationObserver(()=>{ ensure(); });
  obs.observe(document.documentElement, {childList:true, subtree:true});
})();
/* v21: Only the right-side LOGS tab toggles collapse/expand */
(function(){
  function $(sel, root=document){ return root.querySelector(sel); }
  function $all(sel, root=document){ return Array.from(root.querySelectorAll(sel)); }

  function bindOnce(){
    const card = document.getElementById('logCard');
    const tab  = document.getElementById('logTab');
    if(!card || !tab) return false;

    // Hide/remove any extra toggle controls in the header, but keep action buttons (Clear/TXT/JSON).
    const head = card.querySelector('#logHead') || card.querySelector('.logTop') || card;
    const actions = head.querySelector('#logActions') || head; // safe fallback

    // Any buttons inside head that are NOT inside #logActions are treated as toggles/UI chrome -> hide them.
    $all('button', head).forEach(btn=>{
      if(actions && actions.contains(btn)) return; // keep Clear/TXT/JSON etc.
      // keep nothing else in header
      btn.style.display = 'none';
      btn.disabled = true;
      btn.setAttribute('aria-hidden','true');
    });

    // Also disable click toggles on title area if any (some builds make LOGS title clickable)
    const title = head.querySelector('#logTitle') || head.querySelector('.logTitle');
    if(title){
      title.style.pointerEvents = 'none';
    }

    // Make sure tab toggles collapsed state
    if(!tab.__onlyToggleBound){
      tab.__onlyToggleBound = true;
      tab.addEventListener('click', ()=>{
        card.classList.toggle('collapsed');
        try{ localStorage.setItem('logsCollapsed', String(card.classList.contains('collapsed'))); }catch(e){}
        // When expanding: re-enable pointer events automatically via CSS (not collapsed).
        try{ if(typeof window.__adjustLogsLayout==='function') window.__adjustLogsLayout(); }catch(e){}
      });
    }

    // Ensure card reflects saved collapsed state
    try{
      const saved = (localStorage.getItem('logsCollapsed') ?? 'true') === 'true';
      card.classList.toggle('collapsed', saved);
    }catch(e){}

    return true;
  }

  let tries=0;
  const t=setInterval(()=>{
    if(bindOnce() || ++tries>200) clearInterval(t);
  }, 100);

  const obs=new MutationObserver(()=>{ bindOnce(); });
  obs.observe(document.documentElement, {childList:true, subtree:true});
})();

// 🎉 Fun random logo reactions
document.addEventListener('DOMContentLoaded', () => {
  const logo = document.querySelector('.hero-logo.fun-logo');
  if (!logo) return;

  const effects = ['spin', 'shake', 'flip'];

  logo.addEventListener('dblclick', () => {
    const effect = effects[Math.floor(Math.random() * effects.length)];
    logo.classList.remove('spin', 'shake', 'flip');
    // force reflow to restart animation
    void logo.offsetWidth;
    logo.classList.add(effect);
  });
});
