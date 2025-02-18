import { IncomingForm } from 'formidable';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import axios from 'axios';

// Set the FFmpeg binary path from ffmpeg-static
ffmpeg.setFfmpegPath(ffmpegPath);

// Disable Next.js body parsing (we handle file uploads manually)
export const config = {
  api: { bodyParser: false },
};

/**
 * getTranscript:
 * Uploads a video file to AssemblyAI, starts a transcription job,
 * and polls until the transcript is complete.
 * Returns the transcript text.
 */
async function getTranscript(filePath) {
  const UPLOAD_URL = 'https://api.assemblyai.com/v2/upload';
  const TRANSCRIPT_URL = 'https://api.assemblyai.com/v2/transcript';
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing AssemblyAI API key in ASSEMBLYAI_API_KEY environment variable.');
  }

  // Upload the file
  const fileStream = fs.createReadStream(filePath);
  const uploadResponse = await axios({
    method: 'post',
    url: UPLOAD_URL,
    headers: {
      'authorization': apiKey,
      'Transfer-Encoding': 'chunked'
    },
    data: fileStream,
  });
  const audioUrl = uploadResponse.data.upload_url;

  // Request transcription for the uploaded file
  const transcriptResponse = await axios({
    method: 'post',
    url: TRANSCRIPT_URL,
    headers: { 'authorization': apiKey },
    data: { audio_url: audioUrl }
  });
  const transcriptId = transcriptResponse.data.id;

  // Poll the transcription endpoint every 5 seconds
  let transcriptText = '';
  while (true) {
    await new Promise((res) => setTimeout(res, 5000));
    const pollingResponse = await axios({
      method: 'get',
      url: `${TRANSCRIPT_URL}/${transcriptId}`,
      headers: { 'authorization': apiKey }
    });
    if (pollingResponse.data.status === 'completed') {
      transcriptText = pollingResponse.data.text;
      break;
    } else if (pollingResponse.data.status === 'error') {
      throw new Error('Transcript API error: ' + pollingResponse.data.error);
    }
    // Continue polling...
  }
  return transcriptText;
}

/**
 * processSegmentWithFFmpeg:
 * Processes a single video segment by:
 *  - Scaling it to vertical resolution (1080x1920)
 *  - Overlaying the provided transcript text using drawtext
 *  - Scaling the gameplay clip (ss.mp4) to 300px in height
 *  - Overlaying the gameplay clip at the bottom (with 20px margin)
 */
function processSegmentWithFFmpeg(inputPath, outputPath, transcript) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      // Input 0: main video segment
      .input(inputPath)
      // Input 1: gameplay clip from public folder
      .input(path.join(process.cwd(), 'public', 'ss.mp4'))
      .complexFilter([
        // Scale main video to 1080x1920 (vertical)
        {
          filter: 'scale',
          options: '1080:1920',
          inputs: '[0:v]',
          outputs: 'main_scaled'
        },
        // Overlay transcript text on the main video
        {
          filter: 'drawtext',
          options: {
            fontfile: path.join(process.cwd(), 'fonts', 'Roboto-Regular.ttf'),
            text: transcript,
            fontsize: 48,
            fontcolor: 'white',
            x: '(w-text_w)/2',
            y: '50'
          },
          inputs: 'main_scaled',
          outputs: 'main_text'
        },
        // Scale the gameplay clip to a fixed height of 300px while preserving aspect ratio
        {
          filter: 'scale',
          options: 'trunc(iw*300/ih):300',
          inputs: '[1:v]',
          outputs: 'ss_scaled'
        },
        // Overlay the gameplay clip onto the main video (positioned at the bottom with a 20px margin)
        {
          filter: 'overlay',
          options: { x: 0, y: 'main_text_h - overlay_h - 20' },
          inputs: ['main_text', 'ss_scaled'],
          outputs: 'final'
        }
      ], 'final')
      // Copy audio stream without re-encoding
      .outputOptions('-c:a copy')
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .save(outputPath);
  });
}

/**
 * splitVideo:
 * Splits the long video into 1-minute segments using FFmpeg’s segment filter.
 * The segments are saved in the specified directory.
 */
function splitVideo(inputPath, segmentsDir) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        '-c copy',
        '-map 0',
        '-segment_time 60',
        '-f segment',
        '-reset_timestamps 1'
      ])
      .output(path.join(segmentsDir, 'segment_%03d.mp4'))
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run();
  });
}

/**
 * API Route Handler:
 * 1. Parses the uploaded long video.
 * 2. Splits it into 1-minute segments.
 * 3. For each segment, retrieves the transcript via AssemblyAI,
 *    processes the segment with FFmpeg, and saves the output.
 * 4. Returns a JSON list of processed segment filenames.
 *
 * Note: For a 56-minute video, processing all segments sequentially
 * may exceed serverless execution limits. This is a production-ready
 * example, but in production consider processing segments asynchronously.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const form = new IncomingForm({ uploadDir: '/tmp', keepExtensions: true });
  form.parse(req, async (err, fields, files) => {
    if (err || !files.video) {
      res.status(400).json({ error: 'Failed to parse upload or no video provided.' });
      return;
    }
    
    const inputPath = files.video.filepath || files.video.path;
    // Create a temporary directory for segments
    const segmentsDir = path.join('/tmp', `segments_${Date.now()}`);
    fs.mkdirSync(segmentsDir);
    
    try {
      // 1. Split the long video into 1-minute segments.
      await splitVideo(inputPath, segmentsDir);
      
      // 2. Process each segment sequentially.
      const segmentFiles = fs.readdirSync(segmentsDir).filter(f => f.endsWith('.mp4'));
      const processedSegments = [];
      
      for (const file of segmentFiles) {
        const segPath = path.join(segmentsDir, file);
        const transcript = await getTranscript(segPath);
        const outputSegment = path.join(segmentsDir, `processed_${file}`);
        await processSegmentWithFFmpeg(segPath, outputSegment, transcript);
        processedSegments.push(path.basename(outputSegment));
      }
      
      // Return a JSON list of processed segment filenames.
      res.status(200).json({ processedSegments });
      
      // Optionally, clean up the original uploaded file.
      fs.unlinkSync(inputPath);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}
