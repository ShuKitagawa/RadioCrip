import { jobs } from "./store";
import Parser from "rss-parser";
import axios from "axios";
import fs from "fs";
import path from "path";
import os from "os";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
// @ts-ignore
import { path as ffprobePath } from "ffprobe-static";
// @ts-ignore
import * as whisper from "@kutalia/whisper-node-addon";
import AdmZip from "adm-zip";
import { loadDefaultJapaneseParser } from "budoux";

const bp = loadDefaultJapaneseParser();

// OpenAI client and polyfills removed for local Whisper migration

// Set ffmpeg and ffprobe paths
if (ffmpegPath) {
    ffmpeg.setFfmpegPath(ffmpegPath);
}

if (ffprobePath) {
    let finalProbePath = ffprobePath;

    // Check if the path actually exists
    if (!fs.existsSync(finalProbePath)) {
        console.warn(`ffprobe not found at ${finalProbePath}, trying node_modules workaround...`);
        // Fallback for Next.js dev environment
        const platform = process.platform;
        const arch = process.arch;
        const localPath = path.join(
            process.cwd(),
            "node_modules",
            "ffprobe-static",
            "bin",
            platform,
            arch,
            platform === "win32" ? "ffprobe.exe" : "ffprobe"
        );

        if (fs.existsSync(localPath)) {
            finalProbePath = localPath;
            console.log(`Found ffprobe at ${finalProbePath}`);
        } else {
            console.error("Could not find ffprobe in node_modules either.");
        }
    }

    ffmpeg.setFfprobePath(finalProbePath);
}

const parser = new Parser();
const DOWNLOAD_DIR = path.join(process.cwd(), "public", "downloads");

// Ensure download directory exists
if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

export async function startJob(jobId: string, rssUrl: string, episodeUrl?: string, enableSubtitles: boolean = true, exportMode: 'video' | 'premiere' = 'video') {
    const jobDir = path.join(os.tmpdir(), `podclip-${jobId}`);
    if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir);

    const update = (status: string, progress: number, msg: string) => {
        const j = jobs.get(jobId);
        if (j) {
            j.status = status as any;
            j.progress = progress;
            j.message = msg;
        }
    };

    try {
        // 1. RSS Parsing
        update("processing", 5, "Parsing RSS Feed...");
        const feed = await parser.parseURL(rssUrl);

        let targetEp = feed.items[0];
        if (episodeUrl) {
            targetEp = feed.items.find(item => item.enclosure?.url === episodeUrl) || targetEp;
        }

        if (!targetEp || !targetEp.enclosure?.url) {
            throw new Error("No audio found in the selected episode.");
        }

        const audioUrl = targetEp.enclosure.url;
        const coverUrl = feed.image?.url || targetEp.itunes?.image;

        console.log(`Job ${jobId}: Found episode "${targetEp.title}"`);

        // 2. Download Audio (Stream)
        update("processing", 15, "Downloading Audio...");
        const audioPath = path.join(jobDir, "source.mp3");
        await downloadFile(audioUrl, audioPath);

        let coverPath = null;
        if (coverUrl) {
            update("processing", 25, "Downloading Cover Art...");
            coverPath = path.join(jobDir, "cover.jpg");
            try {
                await downloadFile(coverUrl, coverPath);
            } catch (e) {
                console.warn("Failed to download cover, using placeholder.");
                coverPath = null;
            }
        }

        // 3. Extract Clip (Smart Clipping w/ Silence Detection)
        update("processing", 35, "Analyzing for Best Highlight...");

        // Find best 60s clip base
        const baseClipDuration = 60;
        let finalStartTime = await findBestClip(audioPath, baseClipDuration);
        let finalEndTime = finalStartTime + baseClipDuration;

        console.log(`Job ${jobId}: Initial best start time at ${finalStartTime}s`);

        // Refine Start: Look back 5s for silence
        update("processing", 40, "Refining Start Point...");
        const adjustedStart = await findNearestSilence(audioPath, finalStartTime, 5, "backward");
        if (adjustedStart !== -1) {
            console.log(`Job ${jobId}: Adjusted start from ${finalStartTime}s to ${adjustedStart}s`);
            finalStartTime = adjustedStart;
        }

        // Fixed Duration: Ensure exactly 60 seconds from the (potentially adjusted) start
        const fixedDuration = 60;
        finalEndTime = finalStartTime + fixedDuration;

        // Safety check: if for some reason duration would be invalid (shouldn't happen with logic above)
        if (finalEndTime - finalStartTime < 10) {
            console.warn(`Job ${jobId}: Calculated clip too short, resetting to default window.`);
            finalStartTime = await findBestClip(audioPath, baseClipDuration);
            finalEndTime = finalStartTime + fixedDuration;
        }

        const finalDuration = finalEndTime - finalStartTime;
        console.log(`Job ${jobId}: Final Clip Range: ${finalStartTime}s - ${finalEndTime}s (${finalDuration}s)`);

        const clipPath = path.join(jobDir, "clip.mp3");
        await new Promise<void>((resolve, reject) => {
            ffmpeg(audioPath)
                .setStartTime(finalStartTime)
                .setDuration(finalDuration)
                .output(clipPath)
                .on("end", () => resolve())
                .on("error", (err) => reject(err))
                .run();
        });

        // 4. Transcription (NEW)
        update("processing", 50, "Transcribing Audio...");
        let srtPath = null;

        if (enableSubtitles) {
            try {
                console.log(`Job ${jobId}: Preparing local transcription...`);

                // 4a. Convert to 16kHz Mono WAV (Required for Whisper)
                const wavPath = path.join(jobDir, "clip.wav");
                update("processing", 55, "Generating WAV for Whisper...");
                await convertToWav(clipPath, wavPath);

                // 4b. Ensure model exists
                const modelName = "ggml-large-v3.bin";
                const modelPath = path.join(process.cwd(), "models", modelName);
                if (!fs.existsSync(modelPath)) {
                    update("processing", 60, "Downloading Whisper Model Large-v3 (3GB)...");
                    await downloadWhisperModel(modelName, modelPath);
                }

                // 4c. Transcribe Locally
                update("processing", 65, "Transcribing Locally (0%)...");
                console.log(`Job ${jobId}: Starting local transcription with Large-v3 model`);
                const result = await whisper.transcribe({
                    fname_inp: wavPath,
                    model: modelPath,
                    language: "ja",
                    use_gpu: true,
                    translate: false,
                    max_len: 35, // Increased from 20 for longer, more readable segments
                    progress_callback: (progress: number) => {
                        const percent = Math.round(progress);
                        update("processing", 65 + (percent * 0.25), `Transcribing Locally (${percent}%)...`);
                    }
                });

                console.log(`Job ${jobId}: Raw transcription result:`, JSON.stringify(result).substring(0, 1000));

                const rawSegments = result.transcription || [];
                console.log(`Job ${jobId}: Extracted ${rawSegments.length} segments.`);

                const srtContent = generateSRT(rawSegments);
                console.log(`Job ${jobId}: Generated SRT length: ${srtContent.length} chars`);
                if (srtContent.trim()) {
                    srtPath = path.join(jobDir, "subs.srt");
                    fs.writeFileSync(srtPath, srtContent, 'utf8');
                    console.log(`Job ${jobId}: SRT file created at ${srtPath}`);
                } else {
                    console.warn(`Job ${jobId}: Transcription result empty, skipping subtitles.`);
                }
            } catch (err) {
                console.error(`Job ${jobId}: Local transcription failed:`, err);
            }
        } else {
            console.log(`Job ${jobId}: Subtitles disabled, skipping transcription.`);
        }

        // 5. Render Video (Subtitled only for initial preview)
        update("processing", 70, "Rendering Video Preview...");

        const safeTitle = (targetEp.title || "episode")
            .replace(/[^\w\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uffef\u4e00-\u9faf]/g, "_")
            .substring(0, 50);

        const formatSec = (s: number) => {
            const min = Math.floor(s / 60);
            const sec = Math.floor(s % 60);
            return `${min.toString().padStart(2, '0')}分${sec.toString().padStart(2, '0')}秒`;
        };

        const timeStr = `${formatSec(finalStartTime)}～${formatSec(finalStartTime + finalDuration)}`;

        // Paths for dual output
        const burnedFileName = `【切り抜き1分】${safeTitle}_${timeStr}.mp4`;
        const burnedOutputPath = path.join(DOWNLOAD_DIR, burnedFileName);

        // Initial render: Standard MP4 with subtitles
        await renderVideo(clipPath, coverPath, burnedOutputPath, srtPath, targetEp.title, true);

        // Complete Stage 1
        const j = jobs.get(jobId);
        if (j) {
            j.status = "completed";
            j.progress = 100;
            j.message = "Done!";
            j.downloadUrl = `/downloads/${encodeURIComponent(burnedFileName)}`;
            j.premiereStatus = "none";
            j.filePath = burnedOutputPath;

            // Save metadata for on-demand Premiere export
            const metadata = {
                clipPath, coverPath, srtPath,
                title: targetEp.title,
                safeTitle, timeStr,
                duration: finalDuration,
                jobDir
            };
            fs.writeFileSync(path.join(jobDir, 'premiere_metadata.json'), JSON.stringify(metadata), 'utf8');
        }

    } catch (err: any) {
        console.error(`Job ${jobId} failed:`, err);
        const j = jobs.get(jobId);
        if (j) {
            j.status = "failed";
            j.message = "Failed";
            j.error = err.message || "Unknown error";
        }
    }
}

async function downloadFile(url: string, dest: string) {
    const writer = fs.createWriteStream(dest);
    const response = await axios({
        url,
        method: "GET",
        responseType: "stream",
    });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on("finish", () => resolve(true));
        writer.on("error", reject);
    });
}

function formatTimeForFilename(seconds: number): string {
    const mm = Math.floor(seconds / 60).toString().padStart(2, '0');
    const ss = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${mm}-${ss}`;
}

async function getAudioDuration(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            resolve(metadata.format.duration || 0);
        });
    });
}

async function findBestClip(filePath: string, clipDuration: number): Promise<number> {
    const duration = await getAudioDuration(filePath);
    if (duration <= clipDuration) return 0;

    // Search range: 10% to 90% to avoid intros/outros
    const startRange = duration * 0.1;
    const endRange = duration * 0.9;
    const searchDuration = endRange - startRange;

    // Check 30 candidate points for better coverage
    const candidates = 30;
    const step = (searchDuration - clipDuration) / (candidates - 1);

    if (step <= 0) return startRange;

    let bestCandidates: { time: number; vol: number }[] = [];
    let maxVolume = -Infinity;

    console.log(`Analyzing audio duration: ${duration.toFixed(1)}s. Range: ${startRange.toFixed(1)}-${endRange.toFixed(1)}s (30 samples)`);

    const allCandidates: { time: number, vol: number }[] = [];

    // We process candidates with a slight random offset to ensure variety
    for (let i = 0; i < candidates; i++) {
        // Add random jitter (-1s to +1s) to the sampling point
        const jitter = (Math.random() - 0.5) * 2;
        const startTime = Math.max(startRange, Math.min(endRange, startRange + (i * step) + jitter));
        try {
            const vol = await analyzeVolume(filePath, startTime, clipDuration);
            allCandidates.push({ time: startTime, vol });
        } catch (e: any) {
            console.warn(`Volume analysis failed at ${startTime.toFixed(1)}s: ${e.message}`);
        }
    }

    if (allCandidates.length === 0) return startRange;

    // Sort by volume descending (loudest first)
    allCandidates.sort((a, b) => b.vol - a.vol);

    // Pick randomly from the top 10 (or fewer if not enough candidates)
    // This ensures variety instead of always picking the same "loudest" spot.
    const poolSize = Math.min(10, allCandidates.length);
    const randomIndex = Math.floor(Math.random() * poolSize);
    const selected = allCandidates[randomIndex];

    console.log(`Pool size: ${poolSize}. Selected random index ${randomIndex}: ${selected.time.toFixed(1)}s (Volume: ${selected.vol}dB)`);

    return selected.time;
}

async function analyzeVolume(filePath: string, start: number, duration: number): Promise<number> {
    return new Promise((resolve, reject) => {
        let log = "";
        const nullOutput = process.platform === 'win32' ? 'NUL' : '/dev/null';

        ffmpeg(filePath)
            .setStartTime(start)
            .setDuration(duration)
            .audioFilters('volumedetect')
            .format('null')
            .output(nullOutput)
            .on('stderr', (stderrLine) => {
                log += stderrLine;
            })
            .on('end', () => {
                // Parse mean_volume: -20.5 dB
                const match = log.match(/mean_volume:\s+(-?[\d.]+)\s+dB/);
                if (match) {
                    resolve(parseFloat(match[1]));
                } else {
                    resolve(-Infinity); // Failed to detect
                }
            })
            .on('error', (err) => reject(err))
            .run();
    });
}

async function renderVideo(
    audioPath: string,
    coverPath: string | null,
    outputPath: string,
    srtPath: string | null = null,
    title: string | null = null,
    burned: boolean = true
) {
    return new Promise<void>((resolve, reject) => {
        let command = ffmpeg();

        // Inputs
        if (coverPath) {
            command.input(coverPath).loop(60);
        } else {
            command.input("color=c=slate:s=1080x1920").inputOption("-f lavfi");
        }

        command.input(audioPath);
        command.audioFilters('afade=t=out:st=55:d=3');

        const filters = [];

        if (coverPath) {
            filters.push('[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:10[bg]');
            filters.push('[0:v]scale=900:-1[fg]');
            filters.push('[bg][fg]overlay=(W-w)/2:(H-h)/2[base_pre]');
        } else {
            filters.push('[0:v]null[base_pre]');
        }

        // Title Overlay (Top)
        if (title) {
            let processedTitle = title.replace(/】/g, "】\n").trim();
            const titleLines = processedTitle.split("\n");
            const finalTitleLines = titleLines.flatMap(line => {
                const chunks = [];
                for (let i = 0; i < line.length; i += 12) {
                    chunks.push(line.slice(i, i + 12));
                }
                return chunks;
            });
            const displayTitle = finalTitleLines.join("\n");
            const escapedTitle = displayTitle.replace(/:/g, '\\:').replace(/'/g, "'\\\\''");
            const fontPath = path.resolve(process.cwd(), 'fonts', 'ZenMaruGothic-Bold.ttf').replace(/\\/g, '/').replace(/:/g, '\\:');
            filters.push(`[base_pre]drawtext=text='${escapedTitle}':fontfile='${fontPath}':fontsize=80:fontcolor=white:borderw=4:bordercolor=black:x=(w-text_w)/2:y=150:line_spacing=15:text_align=center[title]`);
        } else {
            filters.push('[base_pre]null[title]');
        }

        // Subtitles Filter (Conditional)
        let videoInput = 'title';
        if (burned && srtPath && fs.existsSync(srtPath)) {
            const escapedPath = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
            const style = "PlayResX=1080,PlayResY=1920,Fontname=MS Gothic,Fontsize=60,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=3,BorderStyle=1,Alignment=2,MarginV=180,MarginL=150,MarginR=150";
            filters.push(`[${videoInput}]subtitles=filename='${escapedPath}':force_style='${style}'[subs]`);
            videoInput = 'subs';
        }

        // Final Fade-out to black (53s to 55s - 2 second fade)
        filters.push(`[${videoInput}]fade=t=out:st=53:d=2[blacked]`);

        // End Card Text (55s to 60s) - Multiple lines stacked
        const fontPath = path.resolve(process.cwd(), 'fonts', 'ZenMaruGothic-Bold.ttf').replace(/\\/g, '/').replace(/:/g, '\\:');

        // Line 1: "続きは"
        filters.push(`[blacked]drawtext=text='続きは':fontfile='${fontPath}':fontsize=70:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2-120:enable='between(t,55,60)'[line1]`);
        // Line 2: "Spotifyで"
        filters.push(`[line1]drawtext=text='Spotifyで':fontfile='${fontPath}':fontsize=70:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2-40:enable='between(t,55,60)'[line2]`);
        // Line 3: "「車すきすきすきすきラジオ」"
        const line3Text = '「車すきすきすきすきラジオ」'.replace(/'/g, "'\\\\''");
        filters.push(`[line2]drawtext=text='${line3Text}':fontfile='${fontPath}':fontsize=70:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2+40:enable='between(t,55,60)'[line3]`);
        // Line 4: "で検索！"
        filters.push(`[line3]drawtext=text='で検索！':fontfile='${fontPath}':fontsize=70:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2+120:enable='between(t,55,60)'[final]`);

        command
            .complexFilter(filters)
            .on('start', (commandLine) => {
                console.log('Spawned Ffmpeg command: ' + commandLine);
            })
            .output(outputPath)
            .outputOptions([
                '-map [final]',
                '-map 1:a',
                '-c:a aac',
                '-c:v libx264',
                '-pix_fmt yuv420p',
                '-shortest',
                '-r 30'
            ])
            .on("end", () => resolve())
            .on("error", (err) => {
                console.error("FFmpeg error:", err);
                reject(err)
            })
            .run();
    });
}

async function convertToWav(inputPath: string, outputPath: string) {
    return new Promise<void>((resolve, reject) => {
        ffmpeg(inputPath)
            .outputOptions([
                '-ar 16000',
                '-ac 1',
                '-c:a pcm_s16le'
            ])
            .output(outputPath)
            .on('end', () => resolve())
            .on('error', (err) => reject(err))
            .run();
    });
}

async function downloadWhisperModel(modelName: string, dest: string) {
    const modelsDir = path.dirname(dest);
    if (!fs.existsSync(modelsDir)) {
        fs.mkdirSync(modelsDir, { recursive: true });
    }

    const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${modelName}`;
    console.log(`Downloading Whisper model from ${url}...`);
    return await downloadFile(url, dest);
}

function generateSRT(segments: any[]): string {
    // kutalia addon returns an array of segments: [["00:00:00.000", "00:00:05.180", "Text..."], ...]

    let blockIndex = 1;
    let srt = "";

    const maxCharsPerLine = 12; // Reduced for even larger 60px font

    for (const seg of segments) {
        if (Array.isArray(seg) && seg.length >= 3) {
            const start = seg[0].replace('.', ',');
            const end = seg[1].replace('.', ',');
            let text = seg[2].trim();

            if (text) {
                // Convert common laughter markers to "ww" for spoken feel
                text = text.replace(/[（(]笑[）)]/g, "ww")
                    .replace(/笑い声/g, "ww")
                    .replace(/笑う/g, "ww");

                const chunks = bp.parse(text);
                const processedLines = [];
                let currentLine = "";

                for (const chunk of chunks) {
                    if ((currentLine + chunk).length > maxCharsPerLine) {
                        if (currentLine) {
                            processedLines.push(currentLine);
                            currentLine = "";
                        }

                        // If the chunk itself is longer than the limit, split it
                        if (chunk.length > maxCharsPerLine) {
                            let remaining = chunk;
                            while (remaining.length > maxCharsPerLine) {
                                processedLines.push(remaining.slice(0, maxCharsPerLine));
                                remaining = remaining.slice(maxCharsPerLine);
                            }
                            currentLine = remaining;
                        } else {
                            currentLine = chunk;
                        }
                    } else {
                        currentLine += chunk;
                    }
                }
                if (currentLine) processedLines.push(currentLine);

                srt += `${blockIndex}\n${start} --> ${end}\n${processedLines.join("\n")}\n\n`;
                blockIndex++;
            }
        }
    }

    return srt;
}

function formatSRTTime(seconds: number): string {
    const hh = Math.floor(seconds / 3600).toString().padStart(2, '0');
    const mm = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
    const ss = Math.floor(seconds % 60).toString().padStart(2, '0');
    const ms = Math.floor((seconds % 1) * 1000).toString().padStart(3, '0');
    return `${hh}:${mm}:${ss},${ms}`;
}

/**
 * Searches for silence around a timestamp to find a natural break.

 * @param filePath Path to audio file
 * @param pivotTime The time around which to search
 * @param windowSeconds How many seconds to search
 * @param direction "forward" (for end time) or "backward" (for start time)
 * @returns The timestamp of silence, or -1 if none found
 */
async function findNearestSilence(
    filePath: string,
    pivotTime: number,
    windowSeconds: number,
    direction: "forward" | "backward"
): Promise<number> {
    const searchStart = direction === "backward" ? Math.max(0, pivotTime - windowSeconds) : pivotTime;
    const duration = windowSeconds;
    const nullOutput = process.platform === 'win32' ? 'NUL' : '/dev/null';

    return new Promise((resolve, reject) => {
        let log = "";
        ffmpeg(filePath)
            .setStartTime(searchStart)
            .setDuration(duration)
            .audioFilters('silencedetect=noise=-30dB:d=0.5') // Detect silence < -30dB, longer than 0.5s
            .format('null')
            .output(nullOutput)
            .on('stderr', (stderrLine) => {
                log += stderrLine;
            })
            .on('end', () => {
                // Parse silence_end: 12.5 (for backward search, we want the END of a silence block)
                // Parse silence_start: 12.5 (for forward search, we want the START of a silence block)

                const regex = direction === "backward"
                    ? /silence_end: (\d+(\.\d+)?)/g
                    : /silence_start: (\d+(\.\d+)?)/g;

                let bestMatch = -1;
                let minDiff = Infinity;

                let match;
                while ((match = regex.exec(log)) !== null) {
                    const relativeTime = parseFloat(match[1]);
                    // Silence detected is relative to the *search start* because of how we run ffmpeg
                    // We need to convert it back to absolute time
                    const time = searchStart + relativeTime;

                    // We want the one closest to pivotTime
                    const diff = Math.abs(time - pivotTime);
                    if (diff < minDiff) {
                        minDiff = diff;
                        bestMatch = time;
                    }
                }

                resolve(bestMatch);
            })
            .on('error', (err) => {
                // If it fails (e.g. invalid time), just return -1
                console.warn("Silence detection error (ignoring):", err.message);
                resolve(-1);
            })
            .run();
    });
}
function generateFCPXML(videoFile: string, duration: number, title: string) {
    const totalFrames = Math.floor(duration * 30);
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
<sequence>
    <name>${title}</name>
    <duration>${totalFrames}</duration>
    <rate>
        <ntsc>FALSE</ntsc>
        <timebase>30</timebase>
    </rate>
    <media>
        <video>
            <format>
                <samplecharacteristics>
                    <width>1080</width>
                    <height>1920</height>
                </samplecharacteristics>
            </format>
            <track>
                <clipitem>
                    <name>${videoFile}</name>
                    <duration>${totalFrames}</duration>
                    <rate>
                        <ntsc>FALSE</ntsc>
                        <timebase>30</timebase>
                    </rate>
                    <start>0</start>
                    <end>${totalFrames}</end>
                    <file>
                        <name>${videoFile}</name>
                        <pathurl>${videoFile}</pathurl>
                    </file>
                </clipitem>
            </track>
        </video>
        <audio>
            <track>
                <clipitem>
                    <name>${videoFile}</name>
                    <duration>${totalFrames}</duration>
                    <rate>
                        <ntsc>FALSE</ntsc>
                        <timebase>30</timebase>
                    </rate>
                    <start>0</start>
                    <end>${totalFrames}</end>
                    <file>
                        <name>${videoFile}</name>
                        <pathurl>${videoFile}</pathurl>
                    </file>
                </clipitem>
            </track>
        </audio>
    </media>
</sequence>
</xmeml>`;
}
export async function startPremiereExport(jobId: string) {
    const job = jobs.get(jobId);
    if (!job) throw new Error("Job not found");

    job.premiereStatus = "processing";
    job.premiereProgress = 0;

    // Construct the job directory path using jobId (must match startJob naming)
    const jobDir = path.join(os.tmpdir(), `podclip-${jobId}`);
    const metadataPath = path.join(jobDir, 'premiere_metadata.json');

    if (!fs.existsSync(metadataPath)) {
        job.premiereStatus = "failed";
        throw new Error("Premiere metadata not found. Please re-run the job.");
    }

    const m = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

    try {
        const cleanFileName = `【切り抜き1分】${m.safeTitle}_${m.timeStr}_CLEAN.mp4`;
        const cleanOutputPath = path.join(m.jobDir, cleanFileName);

        // Render clean video (no burned subtitles)
        job.premiereProgress = 20;
        await renderVideo(m.clipPath, m.coverPath, cleanOutputPath, null, m.title, false);

        // XML
        job.premiereProgress = 80;
        const xmlName = "project.xml";
        const xmlPath = path.join(m.jobDir, xmlName);
        const xmlContent = generateFCPXML(cleanFileName, m.duration, m.title || "Clip");
        fs.writeFileSync(xmlPath, xmlContent, 'utf8');

        // Package
        job.premiereProgress = 90;
        const zip = new AdmZip();
        zip.addLocalFile(cleanOutputPath);
        if (m.srtPath && fs.existsSync(m.srtPath)) zip.addLocalFile(m.srtPath);
        zip.addLocalFile(xmlPath);

        const zipName = `【切り抜き1分】${m.safeTitle}_${m.timeStr}_Premiere.zip`;
        const zipPath = path.join(DOWNLOAD_DIR, zipName);
        zip.writeZip(zipPath);

        job.downloadUrlZip = `/downloads/${encodeURIComponent(zipName)}`;
        job.premiereStatus = "completed";
        job.premiereProgress = 100;

    } catch (err: any) {
        console.error("Premiere Export Failed:", err);
        job.premiereStatus = "failed";
    }
}
