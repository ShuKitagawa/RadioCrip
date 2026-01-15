
export type JobStatus = "idle" | "processing" | "completed" | "failed";

export interface Job {
    id: string;
    rssUrl: string;
    status: JobStatus;
    progress: number;
    message: string;
    startTime: number;
    downloadUrl?: string; // Relative URL to public file
    downloadUrlZip?: string; // Relative URL to Premiere ZIP
    premiereStatus?: "none" | "processing" | "completed" | "failed";
    premiereProgress?: number;
    filePath?: string;    // Absolute path to result on disk
    error?: string;
}

// Global store to persist across API calls (in stateful server environments)
// Note: In strict serverless (AWS Lambda), this would need Redis/database.

const globalForJobs = global as unknown as { jobs: Map<string, Job> };

export const jobs = globalForJobs.jobs || new Map<string, Job>();

if (process.env.NODE_ENV !== "production") {
    globalForJobs.jobs = jobs;
}
