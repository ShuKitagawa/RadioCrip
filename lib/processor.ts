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

export async function startJob(jobId: string, rssUrl: string, episodeUrl?: string, enableSubtitles: boolean = true) {
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

        // 5. Render Video (Updated with subtitles)
        update("processing", 70, "Rendering Video...");

        // Safe sanitized title: Allow alphanumeric and CJK, replace everything else with underscore
        const safeTitle = (targetEp.title || "episode")
            .replace(/[^\w\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uffef\u4e00-\u9faf]/g, "_")
            .substring(0, 50);

        const fileName = `${safeTitle}_${jobId.substring(0, 8)}.mp4`;
        const outputPath = path.join(DOWNLOAD_DIR, fileName);

        await renderVideo(clipPath, coverPath, outputPath, srtPath);

        // Cleanup
        // fs.rmSync(jobDir, { recursive: true, force: true }); // Keep for debug if needed, or delete

        // Complete
        const j = jobs.get(jobId);
        if (j) {
            j.status = "completed";
            j.progress = 100;
            j.message = "Done!";
            j.downloadUrl = `/downloads/${encodeURIComponent(fileName)}`;
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

    // We process candidates sequentially to avoid spawning too many ffmpeg processes
    for (let i = 0; i < candidates; i++) {
        const startTime = startRange + (i * step);
        try {
            const vol = await analyzeVolume(filePath, startTime, clipDuration);

            // Collect candidates with the highest volume. 
            // We use a small epsilon (0.1dB) to treat similar volumes as "ties"
            if (vol > maxVolume + 0.1) {
                maxVolume = vol;
                bestCandidates = [{ time: startTime, vol }];
            } else if (Math.abs(vol - maxVolume) <= 0.1) {
                bestCandidates.push({ time: startTime, vol });
            }
        } catch (e: any) {
            console.warn(`Volume analysis failed at ${startTime.toFixed(1)}s: ${e.message}`);
        }
    }

    if (bestCandidates.length === 0) return startRange;

    // Tie-handling: Pick the candidate closest to the center of the episode to avoid beginning bias
    const midPoint = duration / 2;
    bestCandidates.sort((a, b) => Math.abs(a.time - midPoint) - Math.abs(b.time - midPoint));

    const selected = bestCandidates[0];
    console.log(`Found ${bestCandidates.length} high-volume areas. Selected ${selected.time.toFixed(1)}s (Volume: ${selected.vol}dB)`);

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

async function renderVideo(audioPath: string, coverPath: string | null, outputPath: string, srtPath: string | null = null) {
    return new Promise<void>((resolve, reject) => {
        let command = ffmpeg();

        // Inputs
        if (coverPath) {
            command.input(coverPath).loop(60);
        } else {
            command.input("color=c=slate:s=1080x1920").inputOption("-f lavfi");
        }

        command.input(audioPath);

        const filters = [];

        if (coverPath) {
            filters.push('[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:10[bg]');
            filters.push('[0:v]scale=900:-1[fg]');
            filters.push('[bg][fg]overlay=(W-w)/2:(H-h)/2[base]');
        } else {
            filters.push('[0:v]null[base]');
        }

        // Subtitles Filter (Styled)
        if (srtPath && fs.existsSync(srtPath)) {
            // FFmpeg subtitles filter on Windows requires very specific escaping:
            // 1. Double backslashes for path or forward slashes
            // 2. Colon after drive letter needs escaping (C\:/...)
            // 3. The path must be single-quoted
            const escapedPath = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');

            // INCREASED: Fontsize=36, MarginV=100 for better visibility in 1080x1920
            // BorderStyle=1 is outline
            // Explicit color format &H<alpha><blue><green><red>
            // Fontsize increased to 52.
            // Note: Line spacing is difficult to control with force_style, 
            // but increasing font size naturally improves presence.
            const style = "PlayResX=1080,PlayResY=1920,Fontname=MS Gothic,Fontsize=52,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=3,BorderStyle=1,Alignment=2,MarginV=150,MarginL=150,MarginR=150";

            console.log(`Job: Applying subtitles with escaped path: ${escapedPath}`);
            filters.push(`[base]subtitles=filename='${escapedPath}':force_style='${style}'[final]`);
        } else {
            console.warn("No subtitles file found or srtPath is null, skipping subtitles filter.");
            filters.push('[base]null[final]');
        }

        command
            .complexFilter(filters) // No second argument to avoid automatic mapping
            .on('start', (commandLine) => {
                console.log('Spawned Ffmpeg with command: ' + commandLine);
            })
            .outputOptions([
                '-map [final]', // Manually map the result of our complex filter
                '-map 1:a',
                '-c:a aac',
                '-c:v libx264',
                '-pix_fmt yuv420p',
                '-shortest',
                '-r 30'
            ])
            .output(outputPath)
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

    const maxCharsPerLine = 14; // Slightly reduced for larger 52px font

    for (const seg of segments) {
        if (Array.isArray(seg) && seg.length >= 3) {
            const start = seg[0].replace('.', ',');
            const end = seg[1].replace('.', ',');
            let text = seg[2].trim();

            if (text) {
                // Smart splitting for Japanese:
                // 1. Try splitting at punctuation (。, 、)
                // 2. If a segment is still too long, split every N characters
                text = text.replace(/([、。])/g, "$1\n").trim();

                const lines = text.split("\n");
                const processedLines = lines.flatMap((line: string) => {
                    const chunks = [];
                    for (let i = 0; i < line.length; i += maxCharsPerLine) {
                        chunks.push(line.slice(i, i + maxCharsPerLine));
                    }
                    return chunks;
                });

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
