import { defineConfig, loadEnv } from 'vite'
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

export default defineConfig(({ command, mode }) => {
    const envDir = path.resolve(__dirname, '..')
    const env = loadEnv(mode, envDir, '')

    return {
        base: command === 'build' ? '/trade/' : '/',
        envDir,
        define: {
            'import.meta.env.TIME_ZONE': JSON.stringify(env.TIME_ZONE || 'America/New_York'),
            'import.meta.env.CHART_MAX_VISIBLE_DAYS': JSON.stringify(env.CHART_MAX_VISIBLE_DAYS || '20'),
            'import.meta.env.CHART_LOAD_DAYS_1M': JSON.stringify(env.CHART_LOAD_DAYS_1M || '1'),
            'import.meta.env.CHART_LOAD_DAYS_5M': JSON.stringify(env.CHART_LOAD_DAYS_5M || '4'),
            'import.meta.env.CHART_LOAD_DAYS_1H': JSON.stringify(env.CHART_LOAD_DAYS_1H || '7'),
            'import.meta.env.CHART_LOAD_DAYS_4H': JSON.stringify(env.CHART_LOAD_DAYS_4H || '14'),
        },

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
