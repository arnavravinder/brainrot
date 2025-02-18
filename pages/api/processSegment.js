import { IncomingForm } from 'formidable';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import axios from 'axios';

// haii ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath);

// sowwy no next bodyparsing
 export const config = {
  api: {
    bodyParser: false,
  },
};

/**
 * getTranscript:
 * Uploads the file at filePath to AssemblyAI, requests a transcript,
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

  // Request a transcript
  const transcriptResponse = await axios({
    method: 'post',
    url: TRANSCRIPT_URL,
    headers: { 'authorization': apiKey },
    data: { audio_url: audioUrl }
  });
  const transcriptId = transcriptResponse.data.id;

  // Poll for transcript completion
  let transcriptText = '';
  while (true) {
    await new Promise(res => setTimeout(res, 5000)); // wait 5 seconds
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
    // Continue polling until done
  }
  return transcriptText;
}

/**
 * processSegmentWithFFmpeg:
 * Uses FFmpeg to scale the main video to vertical (1080x1920),
 * overlays the transcript text using drawtext, scales the gameplay clip,
 * and overlays it at the bottom.
 */
function processSegmentWithFFmpeg(inputPath, outputPath, transcript) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      // Main video segment (input index 0)
      .input(inputPath)
      // Gameplay clip (input index 1)
      .input(path.join(process.cwd(), 'public', 'ss.mp4'))
      .complexFilter([
        // Scale main video to vertical resolution 1080x1920.
        {
          filter: 'scale',
          options: '1080:1920',
          inputs: '[0:v]',
          outputs: 'main_scaled'
        },
        // Overlay transcript text using drawtext.
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
        // Scale gameplay clip to fixed height (e.g., 300px) while preserving aspect ratio.
        {
          filter: 'scale',
          options: 'trunc(iw*300/ih):300',
          inputs: '[1:v]',
          outputs: 'ss_scaled'
        },
        // Overlay the gameplay clip at the bottom with a 20-pixel margin.
        {
          filter: 'overlay',
          options: {
            x: 0,
            y: 'main_text_h - overlay_h - 20'
          },
          inputs: ['main_text', 'ss_scaled'],
          outputs: 'final'
        }
      ], 'final')
      // Copy audio without re-encoding.
      .outputOptions('-c:a copy')
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .save(outputPath);
  });
}

/**
 * API route handler:
 * - Parses an incoming POST request with a file upload.
 * - Calls AssemblyAI to get the transcript.
 * - Processes the segment with FFmpeg.
 * - Returns the processed video file.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }
  
  const form = new IncomingForm({ uploadDir: '/tmp', keepExtensions: true });
  form.parse(req, async (err, fields, files) => {
    if (err || !files.video) {
      res.status(400).json({ error: 'Failed to parse file upload or no file provided' });
      return;
    }
    
    const inputPath = files.video.filepath || files.video.path;
    // Use a unique filename for the output in /tmp.
    const outputPath = path.join('/tmp', `processed_${Date.now()}.mp4`);
    
    try {
      // Call the transcript API to get transcript text.
      const transcript = await getTranscript(inputPath);
      // Process the segment with FFmpeg using the transcript text.
      await processSegmentWithFFmpeg(inputPath, outputPath, transcript);
      
      // Read the processed file into a buffer.
      const processedBuffer = fs.readFileSync(outputPath);
      
      // Cleanup temporary files.
      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);
      
      // Return the processed video file.
      res.setHeader('Content-Type', 'video/mp4');
      res.status(200).send(processedBuffer);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}
