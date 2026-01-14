"use client";

import { useState, useRef } from "react";
import { Podcast, Download, AlertCircle, Loader2, Play } from "lucide-react";

type ProcessingStatus = "idle" | "processing" | "completed" | "failed";

interface StatusResponse {
  status: ProcessingStatus;
  progress: number;
  message: string;
  downloadUrl?: string;
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
  const [loadingFeed, setLoadingFeed] = useState(true);
  const [status, setStatus] = useState<ProcessingStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [error, setError] = useState("");
  const [processingJobId, setProcessingJobId] = useState<string | null>(null);


  const pollInterval = useRef<NodeJS.Timeout | null>(null);

  // Fetch Feed on Mount
  if (loadingFeed && episodes.length === 0) {
    fetch(`/api/feed?rssUrl=${encodeURIComponent(rssUrl)}`)
      .then(res => res.json())
      .then(data => {
        if (data.episodes) setEpisodes(data.episodes);
        setLoadingFeed(false);
      })
      .catch(err => {
        console.error(err);
        setLoadingFeed(false);
      });
  }

  const startProcessing = async (episodeUrl: string) => {
    setStatus("processing");
    setProgress(0);
    setMessage("Initializing...");
    setError("");
    setDownloadUrl("");
    setProcessingJobId(episodeUrl); // Use URL as temp ID to disable button

    try {
      const res = await fetch("/api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rssUrl, episodeUrl }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to start processing");
      }

      const { jobId } = await res.json();
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
        setMessage(data.message);

        if (data.status === "completed") {
          setDownloadUrl(data.downloadUrl || "");
          setProcessingJobId(null); // Re-enable
          clearInterval(pollInterval.current!);
        } else if (data.status === "failed") {
          setError(data.error || "Unknown error");
          setProcessingJobId(null); // Re-enable
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

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-4 font-sans">
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="bg-slate-800/50 p-6 text-center border-b border-slate-800">
          <div className="mx-auto w-12 h-12 bg-indigo-500 rounded-full flex items-center justify-center mb-4 shadow-lg shadow-indigo-500/20">
            <Podcast className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-indigo-400 to-cyan-400">
            車すきすきすきラジオ切り抜きくん
          </h1>
          <p className="text-slate-400 text-sm mt-2">
            最新エピソードからショート動画を自動生成します。
          </p>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Status Display (Global) */}
          {status === "processing" && (
            <div className="space-y-3 bg-slate-900/50 p-4 rounded-xl border border-indigo-500/30 sticky top-0 z-10 backdrop-blur-sm">
              <div className="flex justify-between text-xs text-slate-400">
                <span className="flex items-center gap-2">
                  <Loader2 className="w-3 h-3 animate-spin text-indigo-400" />
                  {message}
                </span>
                <span>{Math.round(progress)}%</span>
              </div>
              <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-indigo-500 to-cyan-400 transition-all duration-500 ease-out"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {/* Success Download (Global) */}
          {status === "completed" && downloadUrl && (
            <div className="bg-emerald-900/20 border border-emerald-900/50 rounded-xl p-4 flex items-center justify-between animate-in fade-in sticky top-0 z-10 backdrop-blur-sm" >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-emerald-500/20 rounded-full flex items-center justify-center">
                  <Podcast className="w-4 h-4 text-emerald-400" />
                </div>
                <div>
                  <h3 className="text-emerald-400 text-sm font-semibold">Clip Ready!</h3>
                  <p className="text-xs text-emerald-400/70">Processed successfully.</p>
                </div>
              </div>
              <div className="flex gap-2">
                <a
                  href={downloadUrl}
                  download
                  className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-4 py-2 rounded-lg transition-colors flex items-center gap-2"
                >
                  <Download className="w-3 h-3" />
                  Download
                </a>
                <button
                  onClick={() => { setStatus("idle"); setDownloadUrl(""); }}
                  className="text-slate-400 hover:text-slate-200 p-2"
                >
                  ×
                </button>
              </div>
            </div>
          )}

          {/* Error Section */}
          {status === "failed" && (
            <div className="bg-red-900/20 border border-red-900/50 rounded-xl p-4 flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-semibold text-red-400">Failed</h3>
                <p className="text-xs text-red-300/80 mt-1">{error}</p>
                <button onClick={() => setStatus("idle")} className="text-xs underline mt-2 text-red-400">Dismiss</button>
              </div>
            </div>
          )}

          {/* Episode List */}
          <div className="overflow-hidden border border-slate-800 rounded-xl">
            <div className="bg-slate-900/50 px-4 py-3 border-b border-slate-800 flex justify-between items-center">
              <h3 className="text-sm font-semibold text-slate-300">Episodes</h3>
              {loadingFeed && <Loader2 className="w-3 h-3 animate-spin text-slate-500" />}
            </div>
            <div className="max-h-[400px] overflow-y-auto divide-y divide-slate-800/50">
              {episodes.map((ep, i) => (
                <div key={i} className="p-4 flex items-center justify-between hover:bg-slate-800/30 transition-colors group">
                  <div className="flex-1 min-w-0 pr-4">
                    <h4 className="text-sm font-medium text-slate-200 truncate" title={ep.title}>
                      {ep.title}
                    </h4>
                    <div className="flex gap-3 mt-1 text-xs text-slate-500">
                      <span>{new Date(ep.pubDate).toLocaleDateString()}</span>
                      <span>{ep.duration}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => startProcessing(ep.audioUrl)}
                    disabled={status === "processing" || processingJobId !== null}
                    className="shrink-0 bg-slate-800 hover:bg-indigo-600 text-slate-300 hover:text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {status === "processing" && processingJobId === ep.audioUrl ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Play className="w-3 h-3 fill-current" />
                    )}
                    Generate
                  </button>
                </div>
              ))}

              {!loadingFeed && episodes.length === 0 && (
                <div className="p-8 text-center text-slate-500 text-sm">
                  No episodes found.
                </div>
              )}
            </div>
          </div>


        </div>

        {/* Footer */}
        <div className="bg-slate-950 p-4 text-center border-t border-slate-900">
          <p className="text-slate-600 text-xs">AI-Powered Podcast Clipping</p>
        </div>
      </div>
    </main>
  );
}
