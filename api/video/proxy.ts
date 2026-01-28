import { Readable } from 'stream';

export const config = {
  maxDuration: 60, // Allow longer streaming if needed
  api: {
    responseLimit: false, // Critical for video piping
  },
};

export default async function handler(req: any, res: any) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range'); // Allow Range header

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { url } = req.query;

    if (!url) {
      return res.status(400).json({ error: 'Missing url param' });
    }

    // 1. Validate URL (Security)
    // Only allow http/https
    if (!/^https?:\/\//.test(url)) {
         return res.status(400).json({ error: 'Invalid protocol' });
    }

    const targetUrl = decodeURIComponent(url);
    console.log(`[Video Proxy] Streaming: ${targetUrl}`);

    // 2. Fetch with Headers forwarding (Support Range requests for seeking/looping)
    const headers: HeadersInit = {};
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const videoResponse = await fetch(targetUrl, {
      headers: headers
    });

    if (!videoResponse.ok) {
       // If range request fails, try without range
       if (videoResponse.status === 416) {
           console.warn("Range not satisfiable, retrying without range");
           // Fallback logic could go here, but usually just return error
       }
       throw new Error(`Upstream Error: ${videoResponse.status}`);
    }

    // 3. Set Response Headers
    const contentType = videoResponse.headers.get('content-type') || 'video/mp4';
    const contentLength = videoResponse.headers.get('content-length');
    const contentRange = videoResponse.headers.get('content-range');
    const acceptRanges = videoResponse.headers.get('accept-ranges');

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for performance
    
    if (contentLength) res.setHeader('Content-Length', contentLength);
    if (contentRange) res.setHeader('Content-Range', contentRange);
    if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);

    // Forward status code (200 or 206 Partial Content)
    res.status(videoResponse.status);
    
    // 4. Stream Body
    if (!videoResponse.body) throw new Error("No response body");

    // @ts-ignore - Readable.fromWeb matches Fetch API ReadableStream
    const nodeStream = Readable.fromWeb(videoResponse.body);
    nodeStream.pipe(res);

  } catch (error: any) {
    console.error("[Video Proxy] Error:", error);
    // Only send JSON error if headers haven't been sent yet
    if (!res.headersSent) {
        return res.status(500).json({ error: error.message || "Proxy Stream Error" });
    }
    res.end();
  }
}