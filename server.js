const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '150mb' }));

// Configuração de Pastas
const BASE_DIR = __dirname;
const BACKUP_ROOT = path.join(BASE_DIR, 'backups');

if (!fs.existsSync(BACKUP_ROOT)) fs.mkdirSync(BACKUP_ROOT, { recursive: true });

// Clientes SSE conectados à página principal
const sseClients = new Set();

async function downloadFile(url, folder, index) {
    const cleanUrl = url.split('?')[0].split('#')[0];
    let ext = path.extname(cleanUrl) || '.png';
    const fileName = `media_${index}${ext}`;
    const filePath = path.join(folder, fileName);

    try {
        // Garante que a pasta existe antes de tentar abrir o WriteStream
        if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

        const response = await axios({ 
            url, 
            method: 'GET', 
            responseType: 'stream', 
            timeout: 15000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);

        return new Promise((resolve) => {
            writer.on('finish', () => {
                console.log(`✅ Salvo: ${fileName}`);
                resolve();
            });
            writer.on('error', (err) => {
                console.error(`❌ Erro de escrita no arquivo ${fileName}:`, err.message);
                resolve(); // Prossegue mesmo com erro para não derrubar o servidor
            });
        });
    } catch (e) {
        console.error(`❌ Erro ao baixar link ${index}: ${e.message}`);
        return Promise.resolve(); 
    }
}

app.post('/save-backup', async (req, res) => {
    const { html, links, title } = req.body;
    const safeTitle = (title || 'backup')
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/\s+/g, '_')
        .slice(0, 100)
        .trim() || 'backup';
    const sessionName = `${safeTitle}_${Date.now()}`;
    const sessionDir = path.join(BACKUP_ROOT, sessionName);

    try {
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

        // Salva o HTML
        fs.writeFileSync(path.join(sessionDir, 'index.html'), html || '');
        console.log(`\n📄 Pasta criada: ${sessionName}`);

        res.json({ message: "Processando...", folder: sessionName });

        // Downloads sequenciais para evitar gargalo
        for (let i = 0; i < links.length; i++) {
            await downloadFile(links[i], sessionDir, i);
        }
        console.log(`✨ Backup finalizado em: ${sessionName}`);

        // Notifica todos os clientes SSE que um novo backup foi concluído
        for (const client of sseClients) {
            client.write(`data: ${JSON.stringify({ folder: sessionName })}\n\n`);
        }
    } catch (err) {
        console.error("Critical Error:", err);
        if (!res.headersSent) res.status(500).send("Erro interno");
    }
});

// Serve arquivos estáticos da pasta de backups
app.use('/backups', express.static(BACKUP_ROOT));

// SSE: cliente se conecta e recebe eventos quando um backup é concluído
app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(':\n\n'); // comentário inicial para manter conexão viva

    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
});

// Página principal: lista todas as pastas de backup
app.get('/', (req, res) => {
    let folders = [];
    if (fs.existsSync(BACKUP_ROOT)) {
        folders = fs.readdirSync(BACKUP_ROOT)
            .filter(name => fs.statSync(path.join(BACKUP_ROOT, name)).isDirectory())
            .map(name => ({ name, mtime: fs.statSync(path.join(BACKUP_ROOT, name)).mtime }))
            .sort((a, b) => b.mtime - a.mtime) // mais recentes primeiro pela data real
            .map(f => f.name);
    }

    const items = folders.map(name => {
        const folderPath = path.join(BACKUP_ROOT, name);
        const allFiles = fs.readdirSync(folderPath);
        const imgCount = allFiles.filter(f => /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(f)).length;
        const vidCount = allFiles.filter(f => /\.(mp4|webm|ogg|mov|avi|mkv)$/i.test(f)).length;
        const hasHtml = allFiles.includes('index.html');
        const mtime = fs.statSync(folderPath).mtime;
        const dateStr = mtime.toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
        const parts = [];
        if (imgCount) parts.push(`${imgCount} img`);
        if (vidCount) parts.push(`${vidCount} vídeo${vidCount !== 1 ? 's' : ''}`);
        const htmlSrc = `/backups/${encodeURIComponent(name)}/index.html`;
        return `
            <div class="card">
                <a href="/gallery/${encodeURIComponent(name)}" class="card-link">
                    <div class="icon">🗂️</div>
                    <div class="name">${name}</div>
                    <div class="meta">${dateStr}</div>
                    <div class="meta">${parts.join(' · ') || 'vazio'}</div>
                </a>
                ${hasHtml ? `<button class="html-btn" onclick="openModal('${htmlSrc}', '${name.replace(/'/g, "\\'")}')">Ver HTML</button>` : ''}
            </div>`;
    }).join('');

    res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Backups</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #111; color: #eee; font-family: monospace; padding: 40px 20px; }
  h1 { color: #0f0; margin-bottom: 8px; }
  p.sub { color: #666; margin-bottom: 32px; font-size: 13px; }
  .grid { display: flex; flex-wrap: wrap; gap: 16px; }
  .card {
    background: #1a1a1a; border: 1px solid #333; border-radius: 8px;
    padding: 16px; width: 260px; color: #eee;
    transition: border-color .2s, background .2s;
    display: flex; flex-direction: column; gap: 8px;
  }
  .card:hover { border-color: #0f0; background: #1f2f1f; }
  .card-link { text-decoration: none; color: inherit; display: block; }
  .icon { font-size: 28px; margin-bottom: 6px; }
  .name { font-size: 12px; word-break: break-all; color: #cfc; margin-bottom: 2px; }
  .meta { font-size: 11px; color: #666; }
  .html-btn {
    margin-top: 4px; width: 100%; padding: 6px 0; background: none;
    border: 1px solid #8af; color: #8af; border-radius: 4px;
    font-family: monospace; font-size: 11px; cursor: pointer;
  }
  .html-btn:hover { background: #8af2; }
  .empty { color: #555; margin-top: 40px; }
  #status { font-size: 11px; color: #0f0; margin-left: 12px; opacity: 0; transition: opacity .4s; }
  #status.show { opacity: 1; }

  /* Modal */
  #modal { display: none; position: fixed; inset: 0; background: #000c; z-index: 999; align-items: center; justify-content: center; }
  #modal.open { display: flex; }
  #modal-box { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; width: 92vw; height: 90vh; display: flex; flex-direction: column; overflow: hidden; }
  #modal-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid #333; flex-shrink: 0; }
  #modal-title { font-size: 12px; color: #8af; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #modal-close { background: none; border: none; color: #f44; font-size: 20px; cursor: pointer; padding: 0 4px; line-height: 1; flex-shrink: 0; }
  #modal-close:hover { color: #f66; }
  #modal-frame { flex: 1; border: none; background: #fff; }
</style>
</head>
<body>
  <h1>📡 Servidor de Backups <span id="status">● novo backup</span></h1>
  <p class="sub">${folders.length} backup${folders.length !== 1 ? 's' : ''} encontrado${folders.length !== 1 ? 's' : ''}</p>
  <div class="grid">
    ${items || '<p class="empty">Nenhum backup ainda. Use a extensão para capturar páginas.</p>'}
  </div>

  <div id="modal">
    <div id="modal-box">
      <div id="modal-header">
        <span id="modal-title"></span>
        <button id="modal-close" onclick="closeModal()">✕</button>
      </div>
      <iframe id="modal-frame" src="" sandbox="allow-same-origin allow-scripts"></iframe>
    </div>
  </div>

  <script>
    function openModal(src, name) {
      document.getElementById('modal-title').textContent = name + ' — index.html';
      document.getElementById('modal-frame').src = src;
      document.getElementById('modal').classList.add('open');
      document.body.style.overflow = 'hidden';
    }
    function closeModal() {
      document.getElementById('modal').classList.remove('open');
      document.getElementById('modal-frame').src = '';
      document.body.style.overflow = '';
    }
    document.getElementById('modal').addEventListener('click', function(e) {
      if (e.target === this) closeModal();
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeModal();
    });

    // SSE: atualiza a página quando um backup for concluído
    const evtSource = new EventSource('/events');
    evtSource.onmessage = function() {
      const status = document.getElementById('status');
      status.classList.add('show');
      setTimeout(() => location.reload(), 1200);
    };
  </script>
</body>
</html>`);
});

// Galeria de imagens de uma pasta de backup
app.get('/gallery/:folder', (req, res) => {
    const folderName = req.params.folder;
    const folderPath = path.join(BACKUP_ROOT, folderName);

    if (!fs.existsSync(folderPath)) {
        return res.status(404).send('<body style="background:#111;color:#f44;padding:40px;font-family:monospace;">Pasta não encontrada.</body>');
    }

    const files = fs.readdirSync(folderPath);
    const images = files.filter(f => /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(f));
    const videos = files.filter(f => /\.(mp4|webm|ogg|mov|avi|mkv)$/i.test(f));
    const hasHtml = files.includes('index.html');
    const total = images.length + videos.length;

    const mediaItems = [
        ...images.map(img => {
            const src = `/backups/${encodeURIComponent(folderName)}/${encodeURIComponent(img)}`;
            return `
        <div class="media-card">
            <a href="${src}" target="_blank">
                <img src="${src}" alt="${img}" loading="lazy">
            </a>
            <div class="media-name">${img}</div>
        </div>`;
        }),
        ...videos.map(vid => {
            const src = `/backups/${encodeURIComponent(folderName)}/${encodeURIComponent(vid)}`;
            return `
        <div class="media-card">
            <video src="${src}" controls preload="metadata"></video>
            <div class="media-name">${vid}</div>
        </div>`;
        })
    ].join('');

    const htmlSrc = `/backups/${encodeURIComponent(folderName)}/index.html`;

    res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>${folderName}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #111; color: #eee; font-family: monospace; padding: 40px 20px; }
  .top { display: flex; align-items: center; gap: 16px; margin-bottom: 32px; flex-wrap: wrap; }
  a.back { color: #0f0; text-decoration: none; font-size: 13px; border: 1px solid #0f0; padding: 6px 12px; border-radius: 4px; }
  a.back:hover { background: #0f02; }
  h1 { color: #cfc; font-size: 16px; word-break: break-all; flex: 1; }
  button.html-btn { color: #8af; font-size: 12px; background: none; cursor: pointer; border: 1px solid #8af; padding: 6px 12px; border-radius: 4px; font-family: monospace; }
  button.html-btn:hover { background: #8af2; }
  .grid { display: flex; flex-wrap: wrap; gap: 12px; }
  .media-card { background: #1a1a1a; border: 1px solid #333; border-radius: 6px; overflow: hidden; width: 200px; }
  .media-card img { width: 100%; height: 150px; object-fit: cover; display: block; }
  .media-card video { width: 100%; height: 150px; display: block; background: #000; }
  .media-card:hover { border-color: #0f0; }
  .media-name { font-size: 10px; color: #666; padding: 6px 8px; word-break: break-all; }
  .empty { color: #555; margin-top: 20px; }
  .meta { color: #666; font-size: 12px; }

  /* Modal */
  #modal { display: none; position: fixed; inset: 0; background: #000c; z-index: 999; align-items: center; justify-content: center; }
  #modal.open { display: flex; }
  #modal-box { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; width: 92vw; height: 90vh; display: flex; flex-direction: column; overflow: hidden; }
  #modal-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid #333; flex-shrink: 0; }
  #modal-header span { font-size: 12px; color: #8af; }
  #modal-close { background: none; border: none; color: #f44; font-size: 20px; cursor: pointer; padding: 0 4px; line-height: 1; }
  #modal-close:hover { color: #f66; }
  #modal-frame { flex: 1; border: none; background: #fff; }
</style>
</head>
<body>
  <div class="top">
    <a class="back" href="/">← Voltar</a>
    <h1>${folderName}</h1>
    <span class="meta">${total} mídia${total !== 1 ? 's' : ''} (${images.length} img · ${videos.length} vídeo${videos.length !== 1 ? 's' : ''})</span>
    ${hasHtml ? `<button class="html-btn" onclick="openModal()">Ver HTML</button>` : ''}
  </div>
  <div class="grid">
    ${mediaItems || '<p class="empty">Nenhuma mídia nesta pasta.</p>'}
  </div>

  ${hasHtml ? `
  <div id="modal">
    <div id="modal-box">
      <div id="modal-header">
        <span>${folderName} — index.html</span>
        <button id="modal-close" onclick="closeModal()">✕</button>
      </div>
      <iframe id="modal-frame" src="" sandbox="allow-same-origin allow-scripts"></iframe>
    </div>
  </div>
  <script>
    function openModal() {
      const modal = document.getElementById('modal');
      const frame = document.getElementById('modal-frame');
      if (!frame.src || frame.src === window.location.href) frame.src = '${htmlSrc}';
      modal.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
    function closeModal() {
      document.getElementById('modal').classList.remove('open');
      document.body.style.overflow = '';
    }
    document.getElementById('modal').addEventListener('click', function(e) {
      if (e.target === this) closeModal();
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeModal();
    });
  </script>` : ''}
</body>
</html>`);
});

app.listen(5000, '0.0.0.0', () => {
    console.log(`🚀 Servidor rodando em http://localhost:5000`);
    console.log(`📂 Os backups serão salvos em: ${BACKUP_ROOT}`);
});