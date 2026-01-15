# 車すきすきすきラジオ切り抜きくん

「車すきすきすきラジオ」のRSSフィードから最新エピソードや過去のエピソードを取得し、ハイライト部分（開始1分から1分間）を自動で切り抜いて、TikTokやYouTube Shorts向けの縦型動画（9:16）を生成するアプリケーションです。

## 機能

- **エピソード選択**: RSSフィードからエピソード一覧を取得し、好きな回を選択可能。
- **高性能AI文字起こし**: OpenAI Whisper (Large-v3モデル)をローカルで使用し、高精度な日本語字幕を自動生成。
- **スマート・ハイライト抽出**: エピソード内の盛り上がり箇所を自動分析。トップ10の候補からランダムに1箇所を選ぶことで、生成のたびに異なるシーンを抽出。
- **動画カスタマイズ**:
    - 縦型動画（1080x1920）に最適化。
    - タイトルの自動配置（かわいい丸文字フォント）。
    - 日本語特有の自然な字幕折り返し。
    - 笑い声の自動検出と「ww」変換。
    - エンディングの2秒間フェードアウト（映像・音声）。
- **Adobe Premiere Pro 連携**: FCP XML形式でのプロジェクト書き出しに対応。動画素材、音声、字幕ファイルを解凍して読み込むだけで、Premiere上での微調整が可能。
- **ローカル完結**: すべての処理がPC内で完結するため、API利用料もかからず、プライバシーも守られます。

## 必要要件

- Node.js (v18推奨)
- **GPU推奨**: Whisperの実行にNVIDIA GPU (CUDA) を使用します（GTX 1660 SUPER以上を推奨）。
- FFmpeg: `ffmpeg-static` を使用。

## インストール手順

リポジトリをクローンした後、以下のコマンドで依存関係をインストールします。

```bash
# 依存パッケージのインストール
npm install

# (必要に応じて) ZIP処理ライブラリの追加
npm install adm-zip
npm install --save-dev @types/adm-zip
```

## 使い方

1. **初期セットアップ**:
   Whisperモデル（約3GB）は初回実行時に自動的に `models/` ディレクトリにダウンロードされます。十分なディスク容量とインターネット接続を確保してください。

2. **開発サーバーの起動**:
   ```bash
   npm run dev
   ```

3. **ブラウザでアクセス**:
   `http://localhost:3000` を開きます。

4. **切り抜き生成**:
   - **書き出しモードを選択**:
     - **Video**: そのまま投稿可能な字幕入り動画。
     - **Premiere**: Premiere編集用のZIPセット。
   - エピソードの「Generate」をクリック。
   - 処理完了後、ダウンロードボタンから保存。

### Premiere Proへの読み込み方（Premiereモード時）
1. ダウンロードしたZIPを解凍します。
2. Premiere Proのプロジェクトパネルに `project.xml` をドラッグ＆ドロップします。
3. 自動で作成されたシーケンスを開くと、動画と音声が配置されています。
4. `.srt` ファイルを読み込み、タイムラインに配置してデザインを調整してください。

## 技術スタック

- **Frontend**: Next.js (App Router), React, Tailwind CSS, Lucide React
- **Backend**: Next.js API Routes
- **Machine Learning**: @kutalia/whisper-node-addon (Whisper Large-v3)
- **Media Processing**: fluent-ffmpeg, adm-zip
- **RSS**: rss-parser

## ライセンス

This project is private.
