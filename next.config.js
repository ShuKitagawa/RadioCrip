/** @type {import('next').NextConfig} */
const nextConfig = {
    experimental: {
        serverComponentsExternalPackages: ['fluent-ffmpeg', 'ffmpeg-static'],
    },
    webpack: (config) => {
        config.externals.push({
            'fluent-ffmpeg': 'commonjs fluent-ffmpeg',
            'ffmpeg-static': 'commonjs ffmpeg-static',
        });
        return config;
    },
}

module.exports = nextConfig
