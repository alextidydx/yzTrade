import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

export default defineConfig(({ command }) => {
    return {
        base: command === 'build' ? '/trade/' : '/',

        plugins: [react()],

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
