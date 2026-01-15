import { NextResponse } from "next/server";
import Parser from "rss-parser";

export const dynamic = "force-dynamic";

const parser = new Parser();

export async function GET(req: Request) {
    const { searchParams } = new URL(req.url);
    const rssUrl = searchParams.get("rssUrl");

    if (!rssUrl) {
        return NextResponse.json({ error: "RSS URL is required" }, { status: 400 });
    }

    try {
        const feed = await parser.parseURL(rssUrl);

        const episodes = feed.items.map(item => ({
            title: item.title,
            pubDate: item.pubDate,
            audioUrl: item.enclosure?.url,
            duration: item.itunes?.duration,
            guid: item.guid,
        })).filter(ep => ep.audioUrl); // Only with audio

        return NextResponse.json({
            episodes,
            coverUrl: feed.image?.url
        });
    } catch (error) {
        console.error("Feed Error:", error);
        return NextResponse.json({ error: "Failed to parse RSS feed" }, { status: 500 });
    }
}
