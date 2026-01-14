# 車すきすきすきラジオ切り抜きくん

「車すきすきすきラジオ」のRSSフィードから最新エピソードや過去のエピソードを取得し、ハイライト部分（開始1分から1分間）を自動で切り抜いて、TikTokやYouTube Shorts向けの縦型動画（9:16）を生成するアプリケーションです。

## 機能

- **エピソード選択**: RSSフィードからエピソード一覧を取得し、好きな回を選択可能。
- **自動切り抜き**: 開始1:00から60秒間を自動でカット。
- **動画生成**: カバーアートを背景に使用し、音声と合わせたMP4ファイルを出力。
- **ダウンロード**: 生成された動画をブラウザから直接ダウンロード。

## 必要要件

- Node.js (v18推奨)
- FFmpeg (※ `ffmpeg-static` パッケージにより自動でセットアップされますが、システムによってはインストールが必要な場合があります)

## インストール手順

```bash
npm install
```

## 使い方

1. 開発サーバーを起動します。

```bash
npm run dev
```

2. ブラウザで `http://localhost:3000` にアクセスします。
3. エピソード一覧から「Generate」ボタンをクリックします。
4. 処理が完了するとダウンロードボタンが表示されます。

## 技術スタック

- **Frontend**: Next.js, React, Tailwind CSS
- **Backend**: Next.js API Routes
- **Media Processing**: fluent-ffmpeg, ffmpeg-static
- **RSS**: rss-parser

## ライセンス

This project is private.
