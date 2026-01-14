import { NextResponse } from "next/server";
import { jobs } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    if (!id) {
        return NextResponse.json({ error: "Missing Job ID" }, { status: 400 });
    }

    const job = jobs.get(id);

    if (!job) {
        return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    return NextResponse.json({
        status: job.status,
        progress: job.progress,
        message: job.message,
        downloadUrl: job.downloadUrl,
        error: job.error
    });
}
