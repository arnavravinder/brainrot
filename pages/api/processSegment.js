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
 * Uploads a file to AssemblyAI, requests transcription, and polls until completed.
 */
async function getTranscript(filePath) {
  const UPLOAD_URL = 'https://api.assemblyai.com/v2/upload';
  const TRANSCRIPT_URL = 'https://api.assemblyai.com/v2/transcript';
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) throw new Error('Missing AssemblyAI API key in environment variables.');

  console.log(`Uploading file for transcription: ${filePath}`);
  const fileStream = fs.createReadStream(filePath);
  const uploadResponse = await axios({
    method: 'post',
    url: UPLOAD_URL,
    headers: { 'authorization': apiKey, 'Transfer-Encoding': 'chunked' },
    data: fileStream,
  });
  const audioUrl = uploadResponse.data.upload_url;
  console.log('File uploaded. Audio URL:', audioUrl);

  const transcriptResponse = await axios({
    method: 'post',
    url: TRANSCRIPT_URL,
    headers: { 'authorization': apiKey },
    data: { audio_url: audioUrl }
  });
  const transcriptId = transcriptResponse.data.id;
  console.log('Transcript requested. Transcript ID:', transcriptId);

  let transcriptText = '';
  while (true) {
    console.log(`Polling transcript status for ID ${transcriptId}...`);
    await new Promise((res) => setTimeout(res, 5000));
    const pollingResponse = await axios({
      method: 'get',
      url: `${TRANSCRIPT_URL}/${transcriptId}`,
      headers: { 'authorization': apiKey }
    });
    const status = pollingResponse.data.status;
    console.log(`Transcript status: ${status}`);
    if (status === 'completed') {
      transcriptText = pollingResponse.data.text;
      console.log('Transcript completed:', transcriptText);
      break;
    } else if (status === 'error') {
      throw new Error('Transcript API error: ' + pollingResponse.data.error);
    }
  }
  return transcriptText;
}

/**
 * processSegmentWithFFmpeg:
 * Processes a segment: scales to vertical, overlays transcript and gameplay clip.
 */
function processSegmentWithFFmpeg(inputPath, outputPath, transcript) {
  return new Promise((resolve, reject) => {
    const safeTranscript = transcript.replace(/'/g, "\\'");
    const fontPath = path.join(process.cwd(), 'fonts', 'Roboto-Regular.ttf');
    const filterGraph = `[0:v]scale=1080:1920[main_scaled]; ` +
      `[main_scaled]drawtext=fontfile='${fontPath}':text='${safeTranscript}':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=50[main_text]; ` +
      `[1:v]scale=trunc(iw*300/ih):300[ss_scaled]; ` +
      `[main_text][ss_scaled]overlay=0:main_text_h-overlay_h-20[final]`;

    console.log(`Processing segment with FFmpeg.
Input: ${inputPath}
Output: ${outputPath}
Filtergraph: ${filterGraph}`);

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
 * Splits the long video into 1-minute segments.
 */
function splitVideo(inputPath, segmentsDir) {
  return new Promise((resolve, reject) => {
    console.log(`Splitting video: ${inputPath} into 1-minute segments at ${segmentsDir}`);
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
 * Splits the uploaded video, processes each segment with transcript and overlays,
 * and returns a JSON list of processed segment filenames.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  console.log('Received POST request for processing full video.');
  const form = new IncomingForm({ uploadDir: '/tmp', keepExtensions: true });
  form.parse(req, async (err, fields, files) => {
    if (err || !files.video) {
      console.error('File upload parsing error or missing video.');
      res.status(400).json({ error: 'Failed to parse upload or no video provided.' });
      return;
    }
    
    const inputPath = files.video.filepath || files.video.path;
    console.log(`Uploaded video saved at: ${inputPath}`);
    const segmentsDir = path.join('/tmp', `segments_${Date.now()}`);
    fs.mkdirSync(segmentsDir);
    
    try {
      await splitVideo(inputPath, segmentsDir);
      
      const segmentFiles = fs.readdirSync(segmentsDir).filter(f => f.endsWith('.mp4'));
      console.log(`Found ${segmentFiles.length} segment files.`);
      const processedSegments = [];
      
      for (const file of segmentFiles) {
        const segPath = path.join(segmentsDir, file);
        console.log(`Processing segment file: ${file}`);
        const transcript = await getTranscript(segPath);
        console.log(`Transcript for ${file}: ${transcript}`);
        const outputSegment = path.join(segmentsDir, `processed_${file}`);
        await processSegmentWithFFmpeg(segPath, outputSegment, transcript);
        processedSegments.push(path.basename(outputSegment));
      }
      
      console.log('All segments processed:', processedSegments);
      res.status(200).json({ processedSegments });
      fs.unlinkSync(inputPath);
    } catch (error) {
      console.error('Processing error:', error);
      res.status(500).json({ error: error.message });
    }
  });
}
