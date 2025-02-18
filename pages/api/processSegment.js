import { IncomingForm } from 'formidable';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import axios from 'axios';

ffmpeg.setFfmpegPath(ffmpegPath);

export const config = {
  api: { bodyParser: false },
};

/**
 * getTranscript:
 * Uploads the file at filePath to AssemblyAI, starts a transcription job,
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

  // Poll the transcription endpoint every 5 seconds until completed
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
  }
  return transcriptText;
}

/**
 * processSegmentWithFFmpeg:
 * Processes a single video segment by scaling it to vertical (1080x1920),
 * overlaying the transcript text, scaling the gameplay clip, and overlaying it at the bottom.
 */
function processSegmentWithFFmpeg(inputPath, outputPath, transcript) {
  return new Promise((resolve, reject) => {
    // Build the filtergraph as a single string.
    // Note: transcript text is escaped for single quotes.
    const safeTranscript = transcript.replace(/'/g, "\\'");
    const fontPath = path.join(process.cwd(), 'fonts', 'Roboto-Regular.ttf');
    const filterGraph = `[0:v]scale=1080:1920[main_scaled]; ` +
      `[main_scaled]drawtext=fontfile='${fontPath}':text='${safeTranscript}':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=50[main_text]; ` +
      `[1:v]scale=trunc(iw*300/ih):300[ss_scaled]; ` +
      `[main_text][ss_scaled]overlay=0:main_text_h-overlay_h-20[final]`;
      
    ffmpeg()
      .input(inputPath)
      .input(path.join(process.cwd(), 'public', 'ss.mp4'))
      .complexFilter(filterGraph, 'final')
      .outputOptions('-c:a copy')
      .on('end', () => {
        console.log(`Finished processing segment: ${outputPath}`);
        resolve();
      })
      .on('error', (err, stdout, stderr) => {
        console.error('FFmpeg error:', err.message);
        console.error('FFmpeg stderr:', stderr);
        reject(err);
      })
      .save(outputPath);
  });
}

/**
 * splitVideo:
 * Splits the input video into 1-minute segments using FFmpeg’s segment filter.
 * The segments are stored in segmentsDir.
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
      .on('end', () => {
        console.log('Video splitting complete.');
        resolve();
      })
      .on('error', err => {
        console.error('Error during video splitting:', err);
        reject(err);
      })
      .run();
  });
}

/**
 * API Route Handler:
 * 1. Parses the uploaded long video.
 * 2. Splits it into 1-minute segments.
 * 3. For each segment, retrieves the transcript and processes it with FFmpeg.
 * 4. Returns a JSON list of processed segment filenames.
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
        console.log(`Processing segment: ${file}`);
        const transcript = await getTranscript(segPath);
        const outputSegment = path.join(segmentsDir, `processed_${file}`);
        await processSegmentWithFFmpeg(segPath, outputSegment, transcript);
        processedSegments.push(path.basename(outputSegment));
      }
      
      res.status(200).json({ processedSegments });
      
      // Optionally clean up the uploaded file.
      fs.unlinkSync(inputPath);
    } catch (error) {
      console.error('Processing error:', error);
      res.status(500).json({ error: error.message });
    }
  });
}
