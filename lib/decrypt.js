const fs = require('fs');
const path = require('path');

// 明文临时区：绿盾透明加密是“写时加密”，所以把明文先写到一个“不受绿盾管控”的目录，
// 再通过同盘 rename（纯元数据操作，不经过写过滤，通常不触发二次加密）移动到目标目录。
// 默认放在 decrypted/ 下子目录：实测批量上传写 decrypted/ 能出明文，证明该区不受写时加密，
// 故明文临时区也应置于其中；可用环境变量 LD_UNENC_TMP 覆盖为其他“与目标同盘且不受管控”的路径。
function getUnencTmp() {
  if (process.env.LD_UNENC_TMP && process.env.LD_UNENC_TMP.trim()) {
    return process.env.LD_UNENC_TMP.trim();
  }
  return path.join(__dirname, '..', 'decrypted', '.unenc_tmp');
}

/**
 * 解密单个文件
 * @param {string} srcPath - 源文件路径
 * @param {string} destPath - 目标文件路径
 * @param {object} [options]
 * @param {boolean} [options.useRename=false] - 是否使用“临时区+rename”兜底，避免写入被绿盾再次加密
 */
function decryptFile(srcPath, destPath, options = {}) {
  const useRename = !!options.useRename;
  return new Promise((resolve, reject) => {
    try {
      // 确保目标目录存在
      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      if (!useRename) {
        const readStream = fs.createReadStream(srcPath, { highWaterMark: 16384 });
        const writeStream = fs.createWriteStream(destPath);
        readStream.on('error', (error) => {
          reject(new Error(`读取文件 ${srcPath} 时发生错误: ${error.message}`));
        });
        writeStream.on('error', (error) => {
          reject(new Error(`写入文件 ${destPath} 时发生错误: ${error.message}`));
        });
        writeStream.on('close', () => resolve());
        readStream.pipe(writeStream);
        return;
      }

      // ---- useRename 兜底：先写到明文临时区，再 rename 到目标 ----
      const tmpRoot = getUnencTmp();
      fs.mkdirSync(tmpRoot, { recursive: true });
      const tmpPath = path.join(
        tmpRoot,
        '.ld_' + Date.now() + '_' + Math.random().toString(36).slice(2) + path.extname(destPath)
      );

      const readStream = fs.createReadStream(srcPath, { highWaterMark: 16384 });
      const writeStream = fs.createWriteStream(tmpPath);

      readStream.on('error', (error) => {
        try { fs.unlinkSync(tmpPath); } catch (e) {}
        reject(new Error(`读取文件 ${srcPath} 时发生错误: ${error.message}`));
      });

      writeStream.on('error', (error) => {
        try { fs.unlinkSync(tmpPath); } catch (e) {}
        reject(new Error(`写入临时文件时发生错误: ${error.message}`));
      });

      writeStream.on('close', () => {
        try {
          fs.renameSync(tmpPath, destPath);
        } catch (e) {
          if (e.code === 'EXDEV') {
            // 跨盘：rename 退化为复制（会触发绿盾写时加密），但保证文件落地
            try {
              fs.copyFileSync(tmpPath, destPath);
              fs.unlinkSync(tmpPath);
              return resolve({ renamed: false, crossVolume: true });
            } catch (e2) {
              try { fs.unlinkSync(tmpPath); } catch (e3) {}
              return reject(e2);
            }
          }
          try { fs.unlinkSync(tmpPath); } catch (e2) {}
          return reject(e);
        }
        try { fs.unlinkSync(tmpPath); } catch (e2) {}
        resolve({ renamed: true });
      });

      readStream.pipe(writeStream);
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * 解密整个目录
 * @param {string} srcDir - 源目录路径
 * @param {string} destDir - 目标目录路径
 * @param {object} [options] - 透传给 decryptFile 的选项（如 useRename）
 */
function decryptDirectory(srcDir, destDir, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      // 确保目标目录存在
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      const items = fs.readdirSync(srcDir);

      const promises = items.map(item => {
        return new Promise((resolveItem, rejectItem) => {
          const itemPath = path.join(srcDir, item);
          const info = fs.statSync(itemPath);

          if (info.isDirectory() && item !== 'node_modules') {
            // 递归解密子目录
            decryptDirectory(
              itemPath,
              path.join(destDir, item),
              options
            ).then(resolveItem).catch(rejectItem);
          } else if (info.isFile()) {
            // 解密文件
            decryptFile(
              itemPath,
              path.join(destDir, item),
              options
            ).then(resolveItem).catch(rejectItem);
          } else {
            resolveItem(); // 对于其他类型，直接完成
          }
        });
      });

      Promise.all(promises).then(resolve).catch(reject);
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = { decryptFile, decryptDirectory };
