const { app, BrowserWindow, ipcMain, desktopCapturer, session, Menu } = require('electron');
const path = require('path');
const { startServer } = require('./server');

// ---- Ajustes de desempenho / áudio ----
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); // som do espectador sem precisar clicar
app.commandLine.appendSwitch('disable-renderer-backgrounding');               // não reduzir fps quando a janela estiver em segundo plano
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('ignore-gpu-blocklist');                          // permite aceleração por GPU em mais placas
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns'); // IPs reais nos candidatos (necessário p/ Radmin/Hamachi)

if (!app.requestSingleInstanceLock()) { app.quit(); }   // evita abrir duas cópias (segunda cópia = porta ocupada)
let win = null;
let server = null;
let pending = { id: null, audio: true };

function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 760, minHeight: 520, backgroundColor: '#1e1f22', autoHideMenuBar: true,
    title: 'LAN Screen Share',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.setWebRTCIPHandlingPolicy('default');
  win.loadFile(path.join(__dirname, 'public', 'index.html'));
}

app.whenReady().then(() => {
  // Captura: a tela escolhida no seletor + áudio do sistema (loopback do Windows)
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const src = sources.find(s => s.id === pending.id) || sources[0];
      const resp = { video: src };
      if (pending.audio) resp.audio = 'loopback';
      callback(resp);
    } catch (e) { try { callback({}); } catch {} }
  });

  ipcMain.handle('get-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true,
    });
    return sources
      .filter(s => s.name && s.name.trim())
      .map(s => ({
        id: s.id, name: s.name, screen: s.id.startsWith('screen:'),
        thumb: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : '',
      }));
  });

  ipcMain.handle('select-source', (_e, id, audio) => { pending = { id, audio: !!audio }; return true; });

  ipcMain.handle('start-server', async (_e, port, room) => {
    if (server) { server.close(); server = null; }
    let lastErr;
    for (let p = port; p < port + 10; p++) {          // porta ocupada? tenta a próxima
      try {
        server = await startServer(p, room || 'Sala de Lives');
        return { ok: true, port: p, ips: server.ips, moved: p !== port, wanted: port };
      } catch (e) { lastErr = e; if (e.code !== 'EADDRINUSE') break; }
    }
    server = null;
    return { ok: false, error: lastErr ? lastErr.message : 'erro desconhecido' };
  });

  ipcMain.handle('stop-server', () => { if (server) { server.close(); server = null; } return true; });

  createWindow();
});

app.on('window-all-closed', () => { if (server) server.close(); app.quit(); });
