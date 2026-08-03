#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { decryptFile, decryptDirectory } = require('../lib/decrypt');

function showHelp() {
  console.log(`
用法: unlock <源路径> [目标路径]

参数:
  源路径    要解密的文件或目录路径
  目标路径  解密后文件保存的路径（可选）
            如果未指定，则会在当前目录创建 uncode_<源路径> 目录

示例:
  unlock ./encrypted-file.txt
  unlock ./encrypted-dir/ ./decrypted-dir/
  `);
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    showHelp();
    process.exit(0);
  }
  
  const srcPath = args[0];
  let destPath = args[1];
  
  if (!fs.existsSync(srcPath)) {
    console.error(`错误: 源路径 "${srcPath}" 不存在`);
    process.exit(1);
  }
  
  // 如果没有指定目标路径，则生成默认路径
  if (!destPath) {
    const basename = path.basename(srcPath);
    destPath = path.join(process.cwd(), `uncode_${basename}`);
  }
  
  try {
    const stat = fs.statSync(srcPath);
    
    if (stat.isFile()) {
      console.log(`正在解密文件: ${srcPath}`);
      await decryptFile(srcPath, destPath);
      console.log(`文件解密完成: ${destPath}`);
    } else if (stat.isDirectory()) {
      console.log(`正在解密目录: ${srcPath}`);
      await decryptDirectory(srcPath, destPath);
      console.log(`目录解密完成: ${destPath}`);
    }
  } catch (error) {
    console.error(`解密过程中出现错误: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };