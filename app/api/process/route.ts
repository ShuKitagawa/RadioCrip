import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { jobs } from "@/lib/store";
import { startJob } from "@/lib/processor"; // We will implement this next

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { rssUrl, episodeUrl, enableSubtitles } = body;

        if (!rssUrl) {
            return NextResponse.json({ error: "RSS URL is required" }, { status: 400 });
        }

        const jobId = uuidv4();

        // Initialize Job
        jobs.set(jobId, {
            id: jobId,
            rssUrl,
            status: "processing",
            progress: 0,
            message: "Job started",
            startTime: Date.now(),
        });

        // Start processing asynchronously
        // Note: We do NOT await this, so the response returns immediately
        startJob(jobId, rssUrl, episodeUrl, enableSubtitles).catch(err => {
            console.error(`Unhandled error in job ${jobId}:`, err);
            const job = jobs.get(jobId);
            if (job) {
                job.status = "failed";
                job.error = "Internal System Error";
                job.message = "Failed unexpectedly";
            }
        });

        return NextResponse.json({ jobId });
    } catch (error) {
        console.error("API Error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
