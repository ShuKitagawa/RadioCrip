/** @type {import('next').NextConfig} */
const nextConfig = {
    experimental: {
        serverComponentsExternalPackages: [
            'fluent-ffmpeg',
            'ffmpeg-static',
            '@kutalia/whisper-node-addon'
        ],
    },
    webpack: (config) => {
        config.externals.push({
            'fluent-ffmpeg': 'commonjs fluent-ffmpeg',
            'ffmpeg-static': 'commonjs ffmpeg-static',
            '@kutalia/whisper-node-addon': 'commonjs @kutalia/whisper-node-addon',
        });
        return config;
    },
}

module.exports = nextConfig
