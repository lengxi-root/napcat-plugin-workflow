import { resolve } from 'path';
import { defineConfig } from 'vite';
import nodeResolve from '@rollup/plugin-node-resolve';
import { builtinModules } from 'module';
import { existsSync, cpSync, rmSync } from 'fs';

const nodeModules = [...builtinModules, builtinModules.map((m) => `node:${m}`)].flat();

// 复制 webui 目录插件
function copyWebuiPlugin () {
  return {
    name: 'copy-webui',
    closeBundle () {
      const srcDir = resolve(__dirname, 'src/webui');
      const destDir = resolve(__dirname, 'webui');
      if (existsSync(srcDir)) {
        if (existsSync(destDir)) rmSync(destDir, { recursive: true });
        cpSync(srcDir, destDir, { recursive: true });
        console.log('已复制 webui 到根目录');
      }
    },
  };
}

export default defineConfig({
  resolve: {
    conditions: ['node', 'default'],
  },
  build: {
    sourcemap: false,
    target: 'esnext',
    minify: false,
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'index.mjs',
    },
    rollupOptions: {
      external: [...nodeModules],
      output: {
        inlineDynamicImports: true,
      },
    },
    outDir: '.',
    emptyOutDir: false,
  },
  plugins: [nodeResolve(), copyWebuiPlugin()],
});
