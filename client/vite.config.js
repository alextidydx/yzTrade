import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import fs from 'node:fs'
import path from 'node:path'

const cleanIndexAssets = () => ({
    name: 'clean-index-assets',
    buildStart() {
        const assetsDir = path.resolve(__dirname, '../public/assets')

        if (!fs.existsSync(assetsDir)) return

        fs.readdirSync(assetsDir)
            .filter(file => /^index-.*\.(js|css)$/.test(file))
            .forEach(file => fs.rmSync(path.join(assetsDir, file), { force: true }))
    },
})

export default defineConfig(({ command }) => {
    return {
        base: command === 'build' ? '/trade/' : '/',

        plugins: [cleanIndexAssets(), react()],

        build: {
            outDir: '../public'
        },

        server: {
            port: 5173,
            proxy: {
                '/api': {
                    target: 'http://127.0.0.1:5003',
                    changeOrigin: true,
                    secure: false,
                }
            }
        }
    }
})
