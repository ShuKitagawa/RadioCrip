"use client";

import { useState, useRef } from "react";
import { Podcast, Download, AlertCircle, Loader2, Play, Search, Video, Settings2, Clock, Timer, X, Music } from "lucide-react";

type ProcessingStatus = "idle" | "processing" | "completed" | "failed";

interface StatusResponse {
  status: ProcessingStatus;
  progress: number;
  message: string;
  downloadUrl?: string;
  downloadUrlZip?: string;
  premiereStatus?: "none" | "processing" | "completed" | "failed";
  premiereProgress?: number;
  error?: string;
}
interface Episode {
  title: string;
  pubDate: string;
  audioUrl: string;
  duration: string;
  guid: string;
}

export default function Home() {
  const [rssUrl] = useState("https://anchor.fm/s/4cbf73a8/podcast/rss");
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [loadingFeed, setLoadingFeed] = useState(true);
  const [status, setStatus] = useState<ProcessingStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [downloadUrlZip, setDownloadUrlZip] = useState("");
  const [premiereStatus, setPremiereStatus] = useState<"none" | "processing" | "completed" | "failed">("none");
  const [premiereProgress, setPremiereProgress] = useState(0);
  const [error, setError] = useState("");
  const [processingJobId, setProcessingJobId] = useState<string | null>(null);
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [enableSubtitles, setEnableSubtitles] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [isManualMode, setIsManualMode] = useState(false);
  const [selectedEpisode, setSelectedEpisode] = useState<Episode | null>(null);
  const [manualMin, setManualMin] = useState(0);
  const [manualSec, setManualSec] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);


  const pollInterval = useRef<NodeJS.Timeout | null>(null);

  // Fetch Feed on Mount
  if (loadingFeed && episodes.length === 0) {
    fetch(`/api/feed?rssUrl=${encodeURIComponent(rssUrl)}`)
      .then(res => res.json())
      .then(data => {
        if (data.episodes) setEpisodes(data.episodes);
        if (data.coverUrl) setCoverUrl(data.coverUrl);
        setLoadingFeed(false);
      })
      .catch(err => {
        console.error(err);
        setLoadingFeed(false);
      });
  }

  const startProcessing = async (episodeUrl: string, startTime?: number) => {
    setStatus("processing");
    setProgress(0);
    setMessage("初期化中...");
    setError("");
    setDownloadUrl("");
    setProcessingJobId(episodeUrl); // Use URL as temp ID to disable button

    try {
      const res = await fetch("/api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rssUrl, episodeUrl, enableSubtitles, startTime }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to start processing");
      }

      const { jobId } = await res.json();
      setCurrentJobId(jobId);
      startPolling(jobId);
    } catch (e: any) {
      handleError(e.message);
      setProcessingJobId(null);
    }
  };

  const startPolling = (jobId: string) => {
    if (pollInterval.current) clearInterval(pollInterval.current);

    pollInterval.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/status?id=${jobId}`);
        const data: StatusResponse = await res.json();

        if (res.status === 404) {
          handleError("Job not found");
          return;
        }

        setStatus(data.status);
        setProgress(data.progress);
        setPremiereStatus(data.premiereStatus || "none");
        setPremiereProgress(data.premiereProgress || 0);
        setDownloadUrlZip(data.downloadUrlZip || "");

        // Translate messages if they are from internal processor
        let msg = data.message;
        if (msg.includes("Transcribing")) msg = "文字起こし中 (Whisper Large-v3)...";
        else if (msg.includes("Converting")) msg = "音声変換中...";
        else if (msg.includes("Rendering")) msg = "動画レンダリング中 (FFmpeg)...";
        else if (msg.includes("Packaging")) msg = "ZIPパッケージ作成中...";

        setMessage(msg);

        if (data.status === "completed") {
          setDownloadUrl(data.downloadUrl || "");
          setProcessingJobId(null); // Re-enable
          // Keep polling if Premiere is processing
          if (data.premiereStatus !== "processing") {
            clearInterval(pollInterval.current!);
          }
        } else if (data.status === "failed") {
          setError(data.error || "不明なエラーが発生しました");
          setProcessingJobId(null); // Re-enable
          clearInterval(pollInterval.current!);
        }

        // Handle Premiere-only completion if job overall is already completed
        if (data.status === "completed" && data.premiereStatus === "completed") {
          clearInterval(pollInterval.current!);
        }
      } catch (e) {
        console.error("Polling error", e);
      }
    }, 2000);
  };

  const handleError = (msg: string) => {
    setStatus("failed");
    setError(msg);
    if (pollInterval.current) clearInterval(pollInterval.current);
  };

  const generatePremiere = async () => {
    if (!currentJobId) return;
    setPremiereStatus("processing");
    try {
      const res = await fetch("/api/premiere", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: currentJobId }),
      });
      if (!res.ok) throw new Error("Premiere export failed to start");

      // Resume/start polling specifically for Premiere status
      startPolling(currentJobId);
    } catch (e: any) {
      console.error(e);
      setPremiereStatus("failed");
    }
  };

  const filteredEpisodes = episodes.filter(ep =>
    ep.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <main className="relative min-h-screen bg-[#050505] text-zinc-100 p-4 lg:p-10 font-sans overflow-x-hidden">
      {/* Dynamic Background */}
      <div
        className="fixed inset-0 z-0 opacity-10 pointer-events-none transition-opacity duration-1000"
        style={{
          backgroundImage: `url(${coverUrl || '/images/background.jpg'})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          filter: coverUrl ? 'blur(100px) saturate(0)' : 'none'
        }}
      />
      <div
        className="fixed inset-0 z-0 opacity-[0.15] pointer-events-none flex items-center justify-center p-32"
      >
        <img
          src="/images/background.jpg"
          className="max-w-4xl w-full object-contain"
          style={{
            filter: 'invert(1)',
            mixBlendMode: 'screen'
          }}
          alt=""
        />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto space-y-8">
        {/* Header - Full Width */}
        <div className="flex flex-col md:flex-row items-center justify-between gap-6 bg-zinc-900 p-10 rounded-[2.5rem] border border-zinc-800 shadow-2xl relative overflow-hidden">
          {/* Subtle accent line */}
          <div className="absolute top-0 left-0 right-0 h-1 bg-zinc-800" />

          <div className="flex items-center gap-6">
            <div className="w-20 h-20 bg-zinc-800 rounded-3xl flex items-center justify-center shadow-2xl border border-zinc-700/50 group hover:scale-105 transition-transform">
              <Podcast className="w-10 h-10 text-white group-hover:animate-pulse" />
            </div>
            <div>
              <h1 className="text-4xl font-bold tracking-tighter text-white leading-tight">
                車すきすきすきラジオ<br className="sm:hidden" />
                <span className="text-zinc-400 ml-2">切り抜きエディター</span>
              </h1>
              <p className="text-zinc-500 text-sm mt-3 flex items-center gap-2 font-medium tracking-wide">
                <span className="w-2 h-2 bg-zinc-400 rounded-full animate-pulse" />
                AI 高性能ハイライト抽出 & 字幕生成エンジン
              </p>
            </div>
          </div>
          <div className="flex gap-4">
            {/* Mode Toggle */}
            <div className="bg-zinc-800 p-1 rounded-2xl flex items-center border border-zinc-700/50">
              <button
                onClick={() => setIsManualMode(false)}
                className={`px-6 py-3 rounded-xl text-xs font-bold uppercase tracking-wider transition-all ${!isManualMode ? 'bg-zinc-100 text-zinc-900 shadow-lg' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                Auto
              </button>
              <button
                onClick={() => setIsManualMode(true)}
                className={`px-6 py-3 rounded-xl text-xs font-bold uppercase tracking-wider transition-all ${isManualMode ? 'bg-zinc-100 text-zinc-900 shadow-lg' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                Manual
              </button>
            </div>
          </div>
        </div>

        {/* Main Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">

          {/* Left Column: Episodes & Controls (8 cols) */}
          <div className="lg:col-span-8 space-y-8">

            {/* Quick Controls & Search Bar */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Subtitle Toggle */}
              <div className="flex items-center justify-between p-6 bg-zinc-900 rounded-[2rem] border border-zinc-800 shadow-xl">
                <div className="flex items-center gap-5">
                  <div className="p-4 bg-zinc-800 rounded-2xl border border-zinc-700/50">
                    <AlertCircle className="w-6 h-6 text-zinc-400" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-white uppercase tracking-widest">AI 字幕生成</h3>
                    <p className="text-[10px] text-zinc-500 font-medium mt-0.5 uppercase">Whisper Large-v3</p>
                  </div>
                </div>
                <button
                  onClick={() => setEnableSubtitles(!enableSubtitles)}
                  className={`relative inline-flex h-8 w-14 items-center rounded-full transition-colors focus:outline-none ${enableSubtitles ? 'bg-white' : 'bg-zinc-800'}`}
                >
                  <span className={`inline-block h-6 w-6 transform rounded-full transition-transform ${enableSubtitles ? 'translate-x-[1.75rem] bg-zinc-900' : 'translate-x-1 bg-zinc-500'}`} />
                </button>
              </div>

              {/* Search Bar */}
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-6 flex items-center pointer-events-none">
                  <Search className="w-6 h-6 text-zinc-500 group-focus-within:text-white transition-colors" />
                </div>
                <input
                  type="text"
                  placeholder="エピソードを検索..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="block w-full pl-16 pr-6 py-6 bg-zinc-900 border border-zinc-800 rounded-[2rem] text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-zinc-700/50 transition-all shadow-xl text-sm font-medium"
                />
              </div>
            </div>

            {/* Episode List Table-style */}
            <div className="bg-zinc-900 rounded-[2.5rem] border border-zinc-800 shadow-2xl overflow-hidden">
              <div className="px-10 py-6 border-b border-zinc-800 flex justify-between items-center bg-zinc-800/40">
                <h3 className="text-xl font-bold text-white tracking-tighter flex items-center gap-4">
                  エピソード一覧
                  {loadingFeed && <Loader2 className="w-5 h-5 animate-spin text-zinc-500" />}
                </h3>
                <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-[0.2em] bg-zinc-950 px-4 py-1.5 rounded-full border border-zinc-800">{filteredEpisodes.length} EPISODES</span>
              </div>

              <div className="max-h-[700px] overflow-y-auto custom-scrollbar">
                {filteredEpisodes.map((ep, i) => (
                  <div key={i} className="px-10 py-8 flex items-center justify-between hover:bg-zinc-800/30 transition-all border-b border-zinc-800/30 last:border-0 group">
                    <div className="flex-1 min-w-0 pr-12">
                      <h4 className="text-lg font-semibold text-zinc-100 group-hover:text-white transition-colors truncate mb-2" title={ep.title}>
                        {ep.title}
                      </h4>
                      <div className="flex items-center gap-6 text-[10px] font-medium text-zinc-500 uppercase tracking-widest">
                        <span className="bg-zinc-950/50 px-3 py-1 rounded-md border border-zinc-800">{new Date(ep.pubDate).toLocaleDateString('ja-JP')}</span>
                        <span className="flex items-center gap-2"><Play className="w-3 h-3 fill-zinc-600" /> {ep.duration}</span>
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        if (isManualMode) {
                          setSelectedEpisode(ep);
                          setManualMin(0);
                          setManualSec(0);
                        } else {
                          startProcessing(ep.audioUrl);
                        }
                      }}
                      disabled={status === "processing" || (processingJobId !== null && processingJobId !== ep.audioUrl)}
                      className={`shrink-0 flex items-center gap-4 px-8 py-4 rounded-2xl text-[10px] font-bold uppercase tracking-[0.2em] transition-all shadow-2xl h-fit border ${status === "processing" && processingJobId === ep.audioUrl
                        ? 'bg-zinc-100 text-zinc-900 border-white'
                        : 'bg-zinc-900 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 border-zinc-800 hover:border-zinc-700'
                        } disabled:opacity-20 disabled:scale-95`}
                    >
                      {status === "processing" && processingJobId === ep.audioUrl ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          処理中...
                        </>
                      ) : (
                        <>
                          <Play className="w-4 h-4 fill-current" />
                          {isManualMode ? "範囲指定" : "切り抜き生成"}
                        </>
                      )}
                    </button>
                  </div>
                ))}

                {!loadingFeed && filteredEpisodes.length === 0 && (
                  <div className="p-24 text-center space-y-6">
                    <div className="w-20 h-20 bg-zinc-900/50 rounded-full flex items-center justify-center mx-auto mb-6 border border-zinc-800">
                      <Search className="w-10 h-10 text-zinc-700" />
                    </div>
                    <h4 className="text-zinc-500 font-bold">"{searchQuery}" に一致するエピソードはありません</h4>
                    <button onClick={() => setSearchQuery("")} className="text-zinc-100 text-[10px] font-bold uppercase tracking-widest hover:underline bg-zinc-800 px-6 py-2 rounded-full transition-all">検索をクリア</button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right Column: Preview & Status (4 cols) */}
          <div className="lg:col-span-4 space-y-8">

            {/* Active Status Card */}
            {(status === "processing" || status === "failed" || status === "idle") && (
              <div className={`p-10 rounded-[2.5rem] border transition-all shadow-2xl ${status === "failed" ? 'bg-red-950/40 border-red-900 shadow-red-900/10' : 'bg-zinc-900 border-zinc-800'
                }`}>
                {status === "processing" ? (
                  <div className="space-y-8 text-center sm:text-left">
                    <div className="flex flex-col sm:flex-row justify-between items-center sm:items-end gap-4">
                      <div className="space-y-2">
                        <h4 className="text-[10px] font-semibold text-zinc-400 uppercase tracking-[0.3em] animate-pulse">処理状況</h4>
                        <p className="text-sm text-white font-semibold tracking-tight">{message}</p>
                      </div>
                      <span className="text-5xl font-semibold text-white tracking-tighter">{Math.round(progress)}%</span>
                    </div>
                    <div className="h-3 bg-zinc-950 rounded-full overflow-hidden border border-zinc-800 shadow-inner p-1">
                      <div
                        className="h-full bg-white rounded-full transition-all duration-700 ease-out shadow-[0_0_20px_rgba(255,255,255,0.4)]"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>
                ) : status === "failed" ? (
                  <div className="flex flex-col items-center text-center gap-6">
                    <div className="w-16 h-16 bg-red-950 rounded-3xl flex items-center justify-center border border-red-900">
                      <AlertCircle className="w-8 h-8 text-red-500" />
                    </div>
                    <div>
                      <h4 className="text-red-500 font-semibold tracking-widest uppercase text-xs">生成に失敗しました</h4>
                      <p className="text-[10px] text-zinc-400 font-medium uppercase tracking-tighter mt-4 leading-relaxed">{error}</p>
                    </div>
                    <button onClick={() => setStatus("idle")} className="text-[10px] font-bold bg-zinc-800 px-8 py-3 rounded-full hover:bg-zinc-700 transition-all border border-zinc-700 text-white">閉じる</button>
                  </div>
                ) : (
                  <div className="flex flex-col items-center text-center py-16 gap-6">
                    <div className="w-20 h-20 bg-zinc-950 border border-zinc-800 rounded-3xl flex items-center justify-center shadow-inner group">
                      <Video className="w-10 h-10 text-zinc-700 group-hover:text-zinc-500 transition-colors" />
                    </div>
                    <div className="space-y-2">
                      <h4 className="text-zinc-500 font-black uppercase tracking-[0.2em] text-[10px]">待機中</h4>
                      <p className="text-xs text-zinc-400 max-w-[180px] font-black leading-relaxed">エピソードを選択して、クリップを作成してください</p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Large Preview & Download Region */}
            {status === "completed" && downloadUrl && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-[3rem] shadow-2xl overflow-hidden animate-in zoom-in-95 duration-500">
                <div className="p-10 space-y-10">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-5">
                      <div className="w-12 h-12 bg-white rounded-3xl flex items-center justify-center shadow-2xl rotate-12 transition-transform hover:rotate-0">
                        <Download className="w-6 h-6 text-zinc-900" />
                      </div>
                      <div>
                        <h3 className="text-white font-bold text-xl tracking-tighter">準備完了！</h3>
                        <p className="text-[10px] text-zinc-500 font-medium uppercase tracking-[0.2em]">レンダリング完了</p>
                      </div>
                    </div>
                    <button
                      onClick={() => { setStatus("idle"); setDownloadUrl(""); }}
                      className="text-zinc-500 hover:text-white bg-zinc-950 hover:bg-zinc-800 p-3 rounded-2xl transition-all border border-zinc-800"
                    >
                      ×
                    </button>
                  </div>

                  {/* Video Preview */}
                  <div className="relative group">
                    <div className="absolute -inset-10 bg-zinc-100/5 blur-3xl opacity-50" />
                    <div className="relative rounded-[2.5rem] overflow-hidden border-8 border-zinc-950 bg-black aspect-[9/16] w-full mx-auto shadow-2xl flex items-center justify-center transition-transform hover:scale-[1.02]">
                      <video
                        src={downloadUrl}
                        controls
                        className="w-full h-full object-contain"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4">
                    <a
                      href={downloadUrl}
                      download
                      className="flex items-center justify-center gap-3 px-6 py-4 bg-zinc-100 hover:bg-white text-zinc-950 font-bold rounded-2xl transition-all shadow-xl hover:scale-105 active:scale-95 group uppercase tracking-widest text-[10px]"
                    >
                      <Video className="w-5 h-5" />
                      動画を保存 (MP4)
                    </a>

                    {premiereStatus === "none" && (
                      <button
                        onClick={generatePremiere}
                        className="flex items-center justify-center gap-3 px-6 py-4 bg-zinc-800 hover:bg-zinc-700 text-white font-bold rounded-2xl transition-all shadow-xl hover:scale-105 active:scale-95 group uppercase tracking-widest text-[10px] border border-zinc-700"
                      >
                        <Settings2 className="w-5 h-5" />
                        Premiere 連携 (ZIP) を生成
                      </button>
                    )}

                    {premiereStatus === "processing" && (
                      <div className="flex flex-col items-center justify-center gap-2 px-6 py-4 bg-zinc-900 text-zinc-400 font-bold rounded-2xl border border-zinc-800">
                        <div className="flex items-center gap-3">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span className="uppercase tracking-widest text-[10px]">ZIP生成中 {premiereProgress}%</span>
                        </div>
                        <div className="w-full h-1 bg-zinc-800 rounded-full overflow-hidden">
                          <div className="h-full bg-white transition-all duration-500" style={{ width: `${premiereProgress}%` }} />
                        </div>
                      </div>
                    )}

                    {premiereStatus === "completed" && downloadUrlZip && (
                      <a
                        href={downloadUrlZip}
                        download
                        className="flex items-center justify-center gap-3 px-6 py-4 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-2xl transition-all shadow-xl hover:scale-105 active:scale-95 group uppercase tracking-widest text-[10px]"
                      >
                        <Download className="w-5 h-5" />
                        ZIPをダウンロード
                      </a>
                    )}

                    {premiereStatus === "failed" && (
                      <button
                        onClick={generatePremiere}
                        className="flex items-center justify-center gap-3 px-6 py-4 bg-red-900/20 text-red-500 font-bold rounded-2xl border border-red-900/50 uppercase tracking-widest text-[10px]"
                      >
                        <AlertCircle className="w-5 h-5" />
                        失敗しました (再試行)
                      </button>
                    )}
                  </div>
                  <p className="text-zinc-600 text-center text-[9px] font-black uppercase tracking-[0.4em] pt-2">Optimized for Desktop Workflow</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <footer className="mt-32 text-center pb-16 space-y-6 opacity-20">
        <div className="flex justify-center gap-6 mb-8">
          <div className="h-[1px] w-20 bg-zinc-800" />
          <div className="h-1 w-1 bg-zinc-800 rounded-full" />
          <div className="h-1 w-1 bg-zinc-800 rounded-full" />
          <div className="h-[1px] w-20 bg-zinc-800" />
        </div>
        <div className="space-y-1">
          <p className="text-zinc-400 text-[10px] font-semibold uppercase tracking-[1em] ml-[1em]">車すきすきすきラジオ</p>
          <p className="text-zinc-500 text-[8px] font-medium uppercase tracking-[0.2em]">Professional Clipping Engine v2.5 Stable</p>
        </div>
      </footer>

      <style jsx global>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #18181b;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #27272a;
        }
        @keyframes bounce {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-5px); }
        }
        .group:hover .group-hover\\:bounce {
          animation: bounce 0.5s ease-infinite;
        }
      `}</style>

      {/* Manual Selection Modal */}
      {selectedEpisode && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-zinc-900 border border-zinc-800 rounded-[2.5rem] w-full max-w-2xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-300">
            <div className="p-8 space-y-8">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-xl font-bold text-white tracking-tight mb-2">クリップ範囲を指定</h3>
                  <p className="text-zinc-400 text-sm">{selectedEpisode.title}</p>
                </div>
                <button
                  onClick={() => setSelectedEpisode(null)}
                  className="p-2 bg-zinc-800 rounded-full text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              {/* Audio Preview */}
              <div className="bg-zinc-950 p-6 rounded-3xl border border-zinc-800">
                <audio
                  ref={audioRef}
                  src={selectedEpisode.audioUrl}
                  controls
                  className="w-full mb-4"
                />
                <div className="grid grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <label className="text-[10px] uppercase font-bold text-zinc-500 tracking-widest">開始時間 (分)</label>
                    <input
                      type="number"
                      min="0"
                      value={manualMin}
                      onChange={(e) => setManualMin(parseInt(e.target.value) || 0)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-4 text-2xl font-bold text-white focus:outline-none focus:border-zinc-600 transition-colors text-center"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] uppercase font-bold text-zinc-500 tracking-widest">開始時間 (秒)</label>
                    <input
                      type="number"
                      min="0"
                      max="59"
                      value={manualSec}
                      onChange={(e) => setManualSec(parseInt(e.target.value) || 0)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-4 text-2xl font-bold text-white focus:outline-none focus:border-zinc-600 transition-colors text-center"
                    />
                  </div>
                </div>
              </div>

              <div className="bg-zinc-800/50 p-6 rounded-3xl border border-dashed border-zinc-700/50 flex items-center gap-4">
                <div className="w-12 h-12 bg-zinc-800 rounded-2xl flex items-center justify-center border border-zinc-700">
                  <Clock className="w-6 h-6 text-zinc-400" />
                </div>
                <div>
                  <p className="text-sm font-bold text-zinc-300">プレビュー機能</p>
                  <p className="text-xs text-zinc-500 mt-1">設定した開始時間から音声を再生して確認できます</p>
                </div>
                <button
                  onClick={() => {
                    if (audioRef.current) {
                      const time = (manualMin * 60) + manualSec;
                      audioRef.current.currentTime = time;
                      audioRef.current.play();
                    }
                  }}
                  className="ml-auto px-6 py-3 bg-zinc-100 hover:bg-white text-zinc-900 rounded-xl font-bold text-xs uppercase tracking-widest transition-colors flex items-center gap-2"
                >
                  <Play className="w-4 h-4 fill-current" />
                  再生
                </button>
              </div>

              <button
                onClick={() => {
                  const startTime = (manualMin * 60) + manualSec;
                  startProcessing(selectedEpisode.audioUrl, startTime);
                  setSelectedEpisode(null);
                }}
                className="w-full py-6 bg-white hover:bg-zinc-200 text-zinc-950 rounded-3xl font-black text-lg uppercase tracking-widest transition-all shadow-xl hover:scale-[1.02] active:scale-[0.98] flex items-center justify-center gap-4"
              >
                <Video className="w-6 h-6" />
                この範囲でクリップを作成 (1分)
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
