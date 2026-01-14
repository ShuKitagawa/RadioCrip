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
import OpenAI from "openai";

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

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

export async function startJob(jobId: string, rssUrl: string, episodeUrl?: string) {
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
        try {
            console.log(`Job ${jobId}: Sending to Whisper...`);
            const transcript = await transcribeAudio(clipPath);
            console.log(`Job ${jobId}: Whisper received ${transcript.segments?.length || 0} segments`);

            const srtContent = generateSRT(transcript.segments || []);
            if (srtContent.trim()) {
                srtPath = path.join(jobDir, "subs.srt");
                fs.writeFileSync(srtPath, srtContent);
                console.log(`Job ${jobId}: SRT file created at ${srtPath}`);
            } else {
                console.warn(`Job ${jobId}: Transcription result empty, skipping subtitles.`);
            }
        } catch (err) {
            console.error(`Job ${jobId}: Transcription failed:`, err);
        }

        // 5. Render Video (Updated with subtitles)
        update("processing", 70, "Rendering Video...");

        // Sanitize title for filename
        const safeTitle = (targetEp.title || "episode")
            .replace(/[\\/:*?"<>|]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .substring(0, 50);

        // Dynamic timestamps
        const startStr = formatTimeForFilename(finalStartTime);
        const endStr = formatTimeForFilename(finalEndTime);
        const fileName = `${safeTitle}_切り抜き_${startStr}~${endStr}.mp4`;
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
            // 1. Double backslashes for path
            // 2. Colon after drive letter needs escaping
            // 3. The whole path wrapped in single quotes
            const escapedPath = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');

            // Fontname must match exactly what is on the system. 
            // Often "Noto Sans JP" works but let's ensure styling is robust.
            const style = "Fontname=Noto Sans JP,Fontsize=18,PrimaryColour=&H000000,OutlineColour=&HFFFFFF,Outline=1,BorderStyle=1,Alignment=2,MarginV=30";

            filters.push(`[base]subtitles='${escapedPath}':force_style='${style}'[final]`);
        } else {
            console.warn("No subtitles file found or generated, skipping subtitles filter.");
            filters.push('[base]null[final]');
        }

        command
            .complexFilter(filters, 'final')
            .outputOptions([
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

async function transcribeAudio(filePath: string) {
    return await openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: "whisper-1",
        response_format: "verbose_json",
        language: "ja",
    });
}

function generateSRT(segments: any[]): string {
    return segments.map((seg, i) => {
        const start = formatSRTTime(seg.start);
        const end = formatSRTTime(seg.end);
        return `${i + 1}\n${start} --> ${end}\n${seg.text.trim()}\n`;
    }).join("\n");
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
