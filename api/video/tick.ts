import { Buffer } from 'node:buffer';

// This endpoint is polled by the Gallery Page to process the queue
export const config = {
  maxDuration: 60, // Give it time to talk to Seedance
};

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  const apiKey = process.env.ARK_API_KEY;
  const baseUrl = process.env.ARK_BASE_URL;
  const gasUrl = process.env.APPS_SCRIPT_BASE_URL;
  const defaultModelId = process.env.SEEDANCE_MODEL_ID || 'seedance-1-0-pro-fast-251015';

  if (!apiKey || !baseUrl || !gasUrl) return res.status(500).json({ error: 'Config missing' });

  try {
    // 1. Fetch current Gallery state from Sheet
    const sheetRes = await fetch(`${gasUrl}?action=gallery&t=${Date.now()}`);
    
    // Check if fetch failed (non-200)
    if (!sheetRes.ok) {
        throw new Error(`Failed to fetch Gallery: ${sheetRes.status}`);
    }

    const sheetData = await sheetRes.json();
    const items: any[] = sheetData.items || [];

    // Filter tasks
    const processingTasks = items.filter(i => i.videoStatus === 'processing');
    const queuedTasks = items.filter(i => i.videoStatus === 'queued');

    const MAX_CONCURRENT = 5;
    const report = { processed: 0, started: 0, errors: [] as string[] };

    // 2. CHECK PROCESSING TASKS (Maintenance)
    for (const task of processingTasks) {
       if (!task.videoTaskId) continue;
       
       // Check Seedance Status
       const statusUrl = `${baseUrl.replace(/\/$/, '')}/contents/generations/tasks/${task.videoTaskId}`;
       const sRes = await fetch(statusUrl, { headers: { 'Authorization': `Bearer ${apiKey}` } });
       
       if (sRes.ok) {
           const sData = await sRes.json();
           const resultObj = sData.Result || sData.data || sData;
           const status = (resultObj.status || 'processing').toLowerCase();
           
           if (status === 'succeeded' || status === 'success') {
               // SUCCESS: Get Video URL -> Upload to Drive -> Update Sheet
               let videoUrl = resultObj.content?.video_url || resultObj.output?.video_url || resultObj.video_url;
               if (videoUrl) {
                   // Proxy download and upload to GAS
                   const vidBlobRes = await fetch(videoUrl);
                   const vidBuf = await vidBlobRes.arrayBuffer();
                   const base64Video = Buffer.from(vidBuf).toString('base64');
                   
                   await fetch(gasUrl, {
                       method: 'POST',
                       headers: { "Content-Type": "text/plain" }, // Fix for GAS POST
                       body: JSON.stringify({
                           action: 'uploadGeneratedVideo',
                           image: `data:video/mp4;base64,${base64Video}`,
                           folderId: task.sessionFolderId, // Save to Session Folder!
                           relatedPhotoId: task.id, // Links this video to the photo row
                           skipGallery: false // We want to update the row
                       })
                   });
                   
                   report.processed++;
               }
           } else if (status === 'failed' || status === 'error') {
               // Mark Failed
               await fetch(gasUrl, {
                   method: 'POST',
                   headers: { "Content-Type": "text/plain" },
                   body: JSON.stringify({ action: 'updateVideoStatus', photoId: task.id, status: 'failed' })
               });
           }
       }
    }

    // 3. START QUEUED TASKS (Dispatcher)
    // Only if we have slots
    const availableSlots = MAX_CONCURRENT - processingTasks.length;
    if (availableSlots > 0 && queuedTasks.length > 0) {
        const tasksToStart = queuedTasks.slice(0, availableSlots);
        
        for (const task of tasksToStart) {
             const videoPrompt = task.videoPrompt || "Cinematic movement, high quality, slow motion";
             // Validate Resolution: Must be "720p" or "480p". Default to "480p" if invalid or empty.
             const videoResolution = (task.videoResolution === '720p' || task.videoResolution === '480p') ? task.videoResolution : '480p';
             
             // Get Model from task OR default
             const videoModel = task.videoModel || defaultModelId;

             // Start Seedance
             const payload = {
                model: videoModel,
                content: [
                    { type: "text", text: videoPrompt },
                    { type: "image_url", image_url: { url: `https://drive.google.com/uc?export=download&id=${task.id}` } }
                ],
                parameters: { 
                    duration: 5, 
                    resolution: videoResolution, // Pass resolution (480p or 720p)
                    audio: false 
                }
             };

             const startRes = await fetch(`${baseUrl.replace(/\/$/, '')}/contents/generations/tasks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify(payload)
             });
             
             if (startRes.ok) {
                 const startData = await startRes.json();
                 const taskId = startData.id || startData.Result?.id;
                 if (taskId) {
                     // Update Sheet to PROCESSING
                     await fetch(gasUrl, {
                         method: 'POST',
                         headers: { "Content-Type": "text/plain" },
                         body: JSON.stringify({ 
                             action: 'updateVideoStatus', 
                             photoId: task.id, 
                             status: 'processing',
                             taskId: taskId 
                         })
                     });
                     report.started++;
                 }
             } else {
                 console.error("Seedance Start Failed", await startRes.text());
             }
        }
    }

    return res.status(200).json({ ok: true, report });
  } catch (e: any) {
    console.error("Tick Error", e);
    return res.status(500).json({ error: e.message });
  }
}