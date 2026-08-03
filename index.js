const express = require('express');
const path = require('path');
const multer = require('multer');
const chokidar = require('chokidar');
const fs = require('fs');
const { decryptFile, decryptDirectory } = require('./lib/decrypt');
const { createZip } = require('./lib/zip');
const { exportBuffer, exportStream } = require('./lib/exportClient');

const app = express();
const PORT = process.env.PORT || 3000;

// 全局错误处理中间件，确保API错误返回JSON格式
app.use((err, req, res, next) => {
  if (req.path.startsWith('/api/')) {
    // API请求返回JSON错误
    res.status(500).json({ error: err.message || '服务器内部错误' });
  } else {
    // 非API请求使用默认错误处理
    next(err);
  }
});

// 配置模板引擎
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 静态文件服务
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 配置multer用于文件上传
const upload = multer({ dest: 'uploads/' });

let logMessages = [];
let currentWatchers = [];
let watcherLogHeaders = new Map(); // 存储每个监控任务的日志头部信息

// 添加日志消息的函数
function addLog(message) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}`;
  logMessages.push(logEntry);
  console.log(logEntry);
  
  // 保持日志数量在合理范围内
  if (logMessages.length > 1000) {
    logMessages = logMessages.slice(-500);
  }
}

// ---- 配置持久化 ----
// 配置优先级：环境变量 > 已保存的配置(config.json) > 内置默认。
// 通过 Web 界面改过的目录 / 导出设置会被写入 config.json，重启服务后不丢失。
const CONFIG_FILE = path.join(__dirname, 'config.json');
function loadSavedConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); }
  catch (e) { return null; }
}

// 已验证明文安全区：批量上传写 decrypted/ 能产出明文，证明该目录不受绿盾“写时加密”管控。
// 监控输出默认落在此目录（不带受管控的子目录），以规避写时加密导致的二次加密。
const KNOWN_SAFE_DIR = path.join(__dirname, 'decrypted');
function isKnownSafeDir(dir) {
  try { return path.resolve(dir || '') === path.resolve(KNOWN_SAFE_DIR); }
  catch (e) { return false; }
}

// 运行时配置（含网络导出设置）。导出模式开启条件：runtimeCfg.exportUrl 非空。
const runtimeCfg = Object.assign(
  { sourceDir: 'D:/fileWatch', targetDir: KNOWN_SAFE_DIR, exportUrl: '', exportToken: '' },
  loadSavedConfig() || {}
);
function persistConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
      sourceDir: runtimeCfg.sourceDir,
      targetDir: runtimeCfg.targetDir,
      exportUrl: runtimeCfg.exportUrl || '',
      exportToken: runtimeCfg.exportToken || ''
    }, null, 2), 'utf-8');
  } catch (e) { addLog(`保存配置失败: ${e.message}`); }
}
function saveConfig(partial) {
  Object.assign(runtimeCfg, partial || {});
  persistConfig();
}

// 监控统计：累计已被监控解密的文件数（供 Web 界面展示）
let monitorProcessed = 0;

// 统计目录下（不含隐藏项）的文件总数，用于“立即扫描”报告
function countFiles(dir) {
  let n = 0;
  try {
    for (const it of fs.readdirSync(dir)) {
      if (it.startsWith('.')) continue; // 跳过隐藏文件
      const p = path.join(dir, it);
      const st = fs.statSync(p);
      if (st.isDirectory()) n += countFiles(p);
      else if (st.isFile()) n++;
    }
  } catch (e) { /* ignore */ }
  return n;
}

// 网络导出：递归把源目录下的文件读出明文并流式推送到接收端（全程不落本机磁盘）
function exportDirectory(srcDir) {
  const url = runtimeCfg.exportUrl;
  const token = runtimeCfg.exportToken;
  async function walk(dir) {
    const items = fs.readdirSync(dir);
    for (const item of items) {
      if (item === 'node_modules' || item.startsWith('.')) continue;
      const p = path.join(dir, item);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        await walk(p);
      } else if (st.isFile()) {
        const rel = path.relative(srcDir, p);
        try {
          await exportStream(url, token, path.basename(rel), rel, fs.createReadStream(p));
          addLog(`[网络导出] ${rel}`);
        } catch (e) {
          addLog(`[网络导出] 失败 ${rel}: ${e.message}`);
        }
      }
    }
  }
  return walk(srcDir);
}

// 主页路由
app.get('/', (req, res) => {
  const active = currentWatchers[0];
  const cfg = loadSavedConfig() || {};
  const src = active ? active.sourceDir
    : (process.env.MONITORED_PATH || cfg.sourceDir || 'D:/fileWatch');
  const tgt = active ? active.targetDir
    : (process.env.MONITORED_DECRYPT_PATH || cfg.targetDir || KNOWN_SAFE_DIR);
  res.render('index', { sourceDir: src, targetDir: tgt });
});

// API解密端点
app.post('/api/decrypt', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '未提供文件' });
    }

    const inputFile = req.file.path;
    const origName = decodeUploadName(req.file.originalname);
    const reqMode = (req.body && req.body.mode) || 'local';
    const useNetwork = reqMode === 'network';

    // 网络导出模式：读出明文直接推送，绝不写本机磁盘
    if (useNetwork) {
      if (!runtimeCfg.exportUrl) {
        safeUnlink(req.file.path);
        return res.status(400).json({ error: '未配置网络导出接收端，请先在「④ 网络导出」中启用并保存接收端地址' });
      }
      try {
        await exportStream(runtimeCfg.exportUrl, runtimeCfg.exportToken, origName, origName, fs.createReadStream(inputFile));
        addLog(`[网络导出] 单文件: ${origName}`);
      } catch (e) {
        addLog(`[网络导出] 单文件失败 ${origName}: ${e.message}`);
        return res.status(500).json({ error: e.message });
      } finally {
        safeUnlink(req.file.path); // 清理 multer 临时(密文)文件
      }
      return res.json({ ok: true, mode: 'export', message: `已网络导出: ${origName}` });
    }

    const outputFile = path.join('decrypted', path.basename(origName));

    // 确保输出目录存在
    const outputDir = path.dirname(outputFile);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    await decryptFile(inputFile, outputFile, { useRename: true });
    addLog(`API解密完成: ${origName} -> ${outputFile}`);

    // 返回解密后的文件（显式指定下载文件名，避免乱码）
    res.download(outputFile, path.basename(origName), (err) => {
      if (err) {
        addLog(`下载文件出错: ${err.message}`);
      }
      
      // 清理临时文件
      fs.unlinkSync(req.file.path);
      if (req.body.deleteFlag !== '0') {
        fs.unlinkSync(outputFile);
      }
    });
  } catch (error) {
    addLog(`API解密失败: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// 批量解密端点（多文件 -> ZIP）
const batchUpload = multer({ dest: 'uploads/' });

// 清理辅助：删除失败不应影响主流程（例如某些环境拦截了删除操作）
function safeUnlink(p) {
  try { if (p) fs.unlinkSync(p); } catch (e) { addLog(`清理临时文件失败: ${e.message}`); }
}
function safeRm(p) {
  try { if (p) fs.rmSync(p, { recursive: true, force: true }); } catch (e) { addLog(`清理目录失败: ${e.message}`); }
}

// 修复 multer/busboy 对上传文件名的 Latin-1 误解码：
// 浏览器以 UTF-8 发送中文文件名，部分环境下 busboy 会把它当成 Latin-1
// 逐字节解码成字符串（例如“文件”变成“Ã¦Â...”），导致 ZIP / 下载时乱码。
// 此函数检测并把这种字符串还原为正确的 UTF-8。
// 守卫：仅当字符串所有字符码点 <= 0xFF（Latin-1 特征）时才转换；
// 正常的 UTF-8 文件名（含中文，码点 > 0xFF）直接返回，避免二次破坏。
function decodeUploadName(name) {
  if (!name || typeof name !== 'string') return name;
  let allLatin1 = true;
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) > 0xFF) { allLatin1 = false; break; }
  }
  if (!allLatin1) return name;
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch (e) {
    return name;
  }
}

app.post('/api/decrypt/batch', batchUpload.array('file'), async (req, res) => {
  const ts = Date.now();
  const workDir = path.join('decrypted', 'batch_' + ts);
  let zipPath = null;
  try {
    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: '未提供文件' });
    }

    const reqMode = (req.body && req.body.mode) || 'local';
    // 网络导出模式：逐个读出明文推送，跳过本地落盘 / ZIP
    if (reqMode === 'network') {
      if (!runtimeCfg.exportUrl) {
        return res.status(400).json({ error: '未配置网络导出接收端，请先在「④ 网络导出」中启用并保存接收端地址' });
      }
      let okCount = 0, failCount = 0;
      for (const uf of req.files) {
        const origName = decodeUploadName(uf.originalname);
        try {
          await exportStream(runtimeCfg.exportUrl, runtimeCfg.exportToken, origName, origName, fs.createReadStream(uf.path));
          okCount++;
          addLog(`[网络导出] 批量: ${origName}`);
        } catch (e) {
          failCount++;
          addLog(`[网络导出] 批量失败 ${origName}: ${e.message}`);
        }
      }
      addLog(`批量网络导出完成: 成功 ${okCount}, 失败 ${failCount}`);
      return res.json({ ok: true, mode: 'export', message: `已网络导出 ${okCount} 个文件(失败 ${failCount})` });
    }

    fs.mkdirSync(workDir, { recursive: true });

    const zipFiles = [];
    for (const uf of req.files) {
      const origName = decodeUploadName(uf.originalname);
      const outPath = path.join(workDir, path.basename(origName));
      await decryptFile(uf.path, outPath, { useRename: true });
      zipFiles.push({ name: origName, data: fs.readFileSync(outPath) });
    }

    const zipBuf = createZip(zipFiles);
    zipPath = path.join('decrypted', `batch_${ts}.zip`);
    fs.writeFileSync(zipPath, zipBuf);

    const zipName = `decrypted_batch_${ts}.zip`;
    addLog(`批量解密完成: ${zipFiles.length} 个文件 -> ${zipName}`);

    res.download(zipPath, zipName, (err) => {
      if (err) addLog(`下载 ZIP 出错: ${err.message}`);
      safeUnlink(zipPath);
      safeRm(workDir);
    });
  } catch (error) {
    addLog(`批量解密失败: ${error.message}`);
    safeRm(workDir);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  } finally {
    if (req.files) for (const uf of req.files) safeUnlink(uf.path);
  }
});

// 获取日志
app.get('/api/logs', (req, res) => {
  res.json({ logs: logMessages });
});

// 清空日志
app.post('/api/clear-logs', (req, res) => {
  logMessages = [];
  res.json({ message: '日志已清空' });
});

// 监控页面
app.get('/monitor', (req, res) => {
  res.render('monitor');
});

// 启动服务器
const server = app.listen(PORT, () => {
  addLog(`服务器运行在端口 ${PORT}`);
});

// 目录监控功能
const watchedDirs = new Map();

function watchDirectory(sourceDir, targetDir) {
  monitorProcessed = 0; // 新一轮监控，计数清零
  // 确保源目录存在，如果不存在则创建
  if (!fs.existsSync(sourceDir)) {
    fs.mkdirSync(sourceDir, { recursive: true });
    addLog(`已创建源目录: ${sourceDir}`);
  }
  
  // 确保目标目录存在
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const watcher = chokidar.watch(sourceDir, {
    ignored: /(^|[\/\\])\../, // 忽略隐藏文件
    persistent: true
  });

  watcher
    .on('add', async (filePath) => {
      try {
        const relativePath = path.relative(sourceDir, filePath);

        // 检查是否已经输出过监控目录信息
        if (!watcherLogHeaders.has(sourceDir)) {
          if (runtimeCfg.exportUrl) {
            addLog(`监控目录：${sourceDir}, 模式：网络导出 -> ${runtimeCfg.exportUrl}`);
          } else {
            addLog(`监控目录：${sourceDir}, 输出目录：${targetDir}`);
          }
          watcherLogHeaders.set(sourceDir, true);
        }

        // 网络导出模式：读出明文直接推送，绝不写本机磁盘
        if (runtimeCfg.exportUrl) {
          try {
            await exportStream(runtimeCfg.exportUrl, runtimeCfg.exportToken, path.basename(relativePath), relativePath, fs.createReadStream(filePath));
            monitorProcessed++;
            addLog(`[网络导出] ${relativePath}`);
          } catch (e) {
            addLog(`[网络导出] 失败 ${relativePath}: ${e.message}`);
          }
          return;
        }

        const targetPath = path.join(targetDir, relativePath);
        
        // 确保目标文件的目录存在
        const targetDirName = path.dirname(targetPath);
        if (!fs.existsSync(targetDirName)) {
          fs.mkdirSync(targetDirName, { recursive: true });
        }
        
        await decryptFile(filePath, targetPath, { useRename: true });
        monitorProcessed++; // 累计已解密文件数
        
        // 获取文件大小并转换为MB
        const stats = fs.statSync(filePath);
        const fileSizeInMB = (stats.size / (1024 * 1024)).toFixed(2);
        
        // 输出相对路径和文件大小(MB)
        addLog(`解密文件：${relativePath}, ${fileSizeInMB} MB`);
      } catch (error) {
        addLog(`监控解密失败: ${error.message}`);
      }
    })
    .on('error', error => {
      addLog(`监控出错: ${error.message}`);
    });

  watchedDirs.set(sourceDir, { watcher, targetDir });
  currentWatchers.push({ sourceDir, targetDir, watcher });
  addLog(`开始监控目录: ${sourceDir} -> ${targetDir}`);
  if (!isKnownSafeDir(targetDir)) {
    addLog(`⚠️ 警告：输出目录 "${targetDir}" 不是已验证明文区(${KNOWN_SAFE_DIR})，可能被绿盾写时加密导致输出仍为密文。建议改为 ${KNOWN_SAFE_DIR}。`);
  }
}

// 如果提供了环境变量或保存的配置，则启动目录监控
const monitoredPath = process.env.MONITORED_PATH || runtimeCfg.sourceDir || 'D:/fileWatch';
const monitoredDecryptPath = process.env.MONITORED_DECRYPT_PATH || runtimeCfg.targetDir || KNOWN_SAFE_DIR;
watchDirectory(monitoredPath, monitoredDecryptPath);
if (runtimeCfg.exportUrl) {
  addLog(`网络导出模式已启用，接收端: ${runtimeCfg.exportUrl}`);
}

// 动态配置监控目录
app.post('/api/watch', (req, res) => {
  // 确保返回JSON格式的错误
  try {
    const { sourceDir, targetDir } = req.body;
    
    // 如果sourceDir或targetDir为空，则停止所有监控
    if (!sourceDir || !targetDir) {
      // 停止所有当前监控
      const closePromises = currentWatchers.map(watcherInfo => {
        return watcherInfo.watcher.close().then(() => {
          addLog(`停止监控目录: ${watcherInfo.sourceDir} -> ${watcherInfo.targetDir}`);
        }).catch(err => {
          addLog(`停止监控目录时出错: ${watcherInfo.sourceDir} -> ${watcherInfo.targetDir}, 错误: ${err.message}`);
        });
      });
      
      Promise.all(closePromises).then(() => {
        currentWatchers = [];
        res.json({ message: '已停止所有监控' });
      }).catch(err => {
        addLog(`停止监控时出现错误: ${err.message}`);
        res.status(500).json({ error: `停止监控时出现错误: ${err.message}` });
      });
      return;
    }
    
    // 停止所有当前监控
    const closePromises = currentWatchers.map(watcherInfo => {
      return watcherInfo.watcher.close().then(() => {
        addLog(`停止监控目录: ${watcherInfo.sourceDir} -> ${watcherInfo.targetDir}`);
      }).catch(err => {
        addLog(`停止监控目录时出错: ${watcherInfo.sourceDir} -> ${watcherInfo.targetDir}, 错误: ${err.message}`);
      });
    });
    
    Promise.all(closePromises).then(() => {
      currentWatchers = [];
      // 清除对应的日志头部标记
      watchedDirs.clear();
      watcherLogHeaders.clear();
      
      // 开始新的监控
      try {
        saveConfig({ sourceDir, targetDir }); // 持久化，重启不丢
        watchDirectory(sourceDir, targetDir);
        res.json({ message: `成功开始监控目录: ${sourceDir} -> ${targetDir}` });
      } catch (error) {
        addLog(`启动监控失败: ${error.message}`);
        res.status(500).json({ error: `启动监控失败: ${error.message}` });
      }
    }).catch(err => {
      addLog(`停止监控时出现错误: ${err.message}`);
      res.status(500).json({ error: `停止监控时出现错误: ${err.message}` });
    });
  } catch (error) {
    addLog(`配置监控目录过程中出现未捕获的错误: ${error.message}`);
    // 确保即使在catch块中也返回JSON
    if (!res.headersSent) {
      res.status(500).json({ error: `配置监控目录过程中出现错误: ${error.message}` });
    }
  }
});

// 获取当前监控配置
app.get('/api/watch', (req, res) => {
  const watchers = currentWatchers.map(item => ({
    sourceDir: item.sourceDir,
    targetDir: item.targetDir
  }));
  res.json({
    watchers,
    stats: { processed: monitorProcessed, running: currentWatchers.length > 0 },
    export: { enabled: !!runtimeCfg.exportUrl, url: runtimeCfg.exportUrl || '' }
  });
});

// 立即扫描并解密“现有”文件（不依赖文件变化事件，手动触发一次全量解密）
app.post('/api/scan', async (req, res) => {
  try {
    const active = currentWatchers[0];
    const body = req.body || {};
    const sourceDir = body.sourceDir && body.sourceDir.trim()
      || (active && active.sourceDir)
      || (loadSavedConfig() || {}).sourceDir || '';
    const targetDir = body.targetDir && body.targetDir.trim()
      || (active && active.targetDir)
      || (loadSavedConfig() || {}).targetDir || '';
    if (!sourceDir || !targetDir) {
      return res.status(400).json({ error: '当前没有可扫描的目录，请先在②中保存监控目录' });
    }
    if (!fs.existsSync(sourceDir)) {
      return res.status(400).json({ error: `源目录不存在: ${sourceDir}` });
    }
    const count = countFiles(sourceDir);
    if (runtimeCfg.exportUrl) {
      addLog(`手动扫描开始(网络导出): ${sourceDir} -> ${runtimeCfg.exportUrl}（${count} 个文件）`);
      await exportDirectory(sourceDir);
      addLog(`手动扫描完成(网络导出): 已导出 ${count} 个文件`);
      res.json({ message: `扫描完成，已网络导出 ${count} 个文件`, count });
    } else {
      addLog(`手动扫描开始: ${sourceDir} -> ${targetDir}（${count} 个文件）`);
      await decryptDirectory(sourceDir, targetDir, { useRename: true });
      addLog(`手动扫描完成: 已解密 ${count} 个文件`);
      res.json({ message: `扫描完成，已解密 ${count} 个文件`, count });
    }
  } catch (error) {
    addLog(`手动扫描失败: ${error.message}`);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// 网络导出配置：开启/关闭导出模式，保存接收端地址与令牌
app.post('/api/export-config', (req, res) => {
  try {
    const { exportUrl, exportToken, enabled } = req.body || {};
    if (enabled === false || !exportUrl || !String(exportUrl).trim()) {
      runtimeCfg.exportUrl = '';
      runtimeCfg.exportToken = '';
      persistConfig();
      addLog('已关闭网络导出模式');
      return res.json({ message: '已关闭网络导出模式' });
    }
    runtimeCfg.exportUrl = String(exportUrl).trim();
    runtimeCfg.exportToken = (exportToken || '').toString().trim();
    persistConfig();
    addLog(`已启用网络导出模式 -> ${runtimeCfg.exportUrl}`);
    res.json({ message: `已启用网络导出模式: ${runtimeCfg.exportUrl}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 导出函数供CLI使用
module.exports = { app, server, watchDirectory, addLog };