import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {fileURLToPath} from 'url';
import {defineConfig} from 'vite';

// 用 import.meta.url 推导根目录：esbuild 打包成 CJS 时会做 polyfill，
// 原生 ESM 加载器下也可用，因此不依赖 __dirname（该类写法已被 Vite 标记为废弃）。
const __rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    // Vite 8（rolldown 内核）的依赖预打包会把 recharts 单独分包，并给它内嵌
    // 一份独立的 React 副本 —— 应用组件和 recharts 各持一份 React 实例，
    // 概览页图表一渲染就抛 "Invalid hook call" 白屏。显式把 react 全家与
    // recharts 纳入同一预打包图，强制共享单份 React。
    optimizeDeps: {
      include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', 'recharts'],
    },
    resolve: {
      alias: {
        '@': __rootDir,
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {
        // 关键修复：服务端运行时数据都在项目目录内且被频繁写入（descbatch.db、
        // sourcing/db.sqlite、competitor/shopee.db 的 WAL、browser/profile 的
        // Edge 配置、uploads 转存图片）。Vite watch 到这些变更会触发整页
        // full-reload —— 表现为「点一下操作按钮页面闪一下再跳回来」，看似
        // 不是 SPA。忽略掉这些路径后 HMR 只响应 src/ 源码变更。
        ignored: [
          '**/server/descbatch/**',
          '**/server/sourcing/db.sqlite*',
          '**/server/sourcing/uploads/**',
          '**/server/competitor/*.db*',
          '**/server/competitor/data/**',
          '**/server/browser/**',
          '**/server/auth-secret.txt',
          '**/server/**/collect-token.txt',
        ],
      },
    },
  };
});
