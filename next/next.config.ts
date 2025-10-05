import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'export',
  distDir: 'dist',
  reactStrictMode: false,
  devIndicators: false,
  eslint: {
    ignoreDuringBuilds: true,
  },
}

export default nextConfig
