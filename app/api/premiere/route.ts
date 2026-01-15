import { NextResponse } from "next/server";
import { startPremiereExport } from "@/lib/processor";
import { jobs } from "@/lib/store";

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { jobId } = body;

        if (!jobId) {
            return NextResponse.json({ error: "Job ID is required" }, { status: 400 });
        }

        const job = jobs.get(jobId);
        if (!job) {
            return NextResponse.json({ error: "Job not found" }, { status: 404 });
        }

        // Trigger the background task for Premiere packaging
        startPremiereExport(jobId).catch(err => {
            console.error(`Premiere export failed for job ${jobId}:`, err);
        });

        return NextResponse.json({ message: "Premiere export started" });
    } catch (error) {
        console.error("Premiere API Error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
