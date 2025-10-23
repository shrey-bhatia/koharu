import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Only use static export for production builds (Tauri bundling)
  // During development, we need the dev server
  ...(process.env.NODE_ENV === 'production' && {
    output: 'export' as const,
  }),
  distDir: 'dist',
  reactStrictMode: false,
  devIndicators: false,
}

export default nextConfig
