import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface MediaProblem {
  title: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  evidence: string;
  suggestedSolution: string;
}

export interface MultimediaReport {
  fileName: string;
  mediaType: 'image' | 'audio' | 'video' | 'unknown';
  mimeType: string;
  fileSize: number;
  format: string;
  codec: string;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  bitrate: number | null;
  validationStatus: 'valid' | 'warnings' | 'corrupted' | 'unsupported';
  problems: MediaProblem[];
  metadata: Record<string, unknown>;
  browserPreviewSupported: boolean;
}

const WEB_COMPATIBLE_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1', 'theora']);
const WEB_COMPATIBLE_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_u8', 'pcm_f32le']);
const WEB_COMPATIBLE_IMAGES = new Set(['png', 'jpeg', 'jpg', 'gif', 'webp', 'svg', 'bmp', 'avif']);

export function detectMagicFormat(buf: Buffer): { detected: string; mediaType: 'image' | 'audio' | 'video' | 'unknown' } {
  if (buf.length < 4) return { detected: 'empty/truncated', mediaType: 'unknown' };

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { detected: 'png', mediaType: 'image' };
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { detected: 'jpeg', mediaType: 'image' };
  }
  // GIF: GIF87a / GIF89a
  if (buf.subarray(0, 6).toString('ascii').startsWith('GIF8')) {
    return { detected: 'gif', mediaType: 'image' };
  }
  // WebP: RIFF....WEBP
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { detected: 'webp', mediaType: 'image' };
  }
  // BMP: BM
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    return { detected: 'bmp', mediaType: 'image' };
  }
  // SVG text check
  const headText = buf.subarray(0, 256).toString('utf8').trim();
  if (headText.startsWith('<svg') || (headText.startsWith('<?xml') && headText.includes('<svg'))) {
    return { detected: 'svg', mediaType: 'image' };
  }
  // WAV: RIFF....WAVE
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WAVE') {
    return { detected: 'wav', mediaType: 'audio' };
  }
  // MP3: ID3 or MPEG sync FF FB / FF F3 / FF F2
  if (
    buf.subarray(0, 3).toString('ascii') === 'ID3' ||
    (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)
  ) {
    return { detected: 'mp3', mediaType: 'audio' };
  }
  // FLAC: fLaC
  if (buf.subarray(0, 4).toString('ascii') === 'fLaC') {
    return { detected: 'flac', mediaType: 'audio' };
  }
  // OGG: OggS
  if (buf.subarray(0, 4).toString('ascii') === 'OggS') {
    return { detected: 'ogg', mediaType: 'audio' };
  }
  // MP4/MOV/M4A: ....ftyp
  if (buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('ascii').toLowerCase();
    if (brand.startsWith('m4a')) return { detected: 'm4a', mediaType: 'audio' };
    return { detected: 'mp4', mediaType: 'video' };
  }
  // WebM / Matroska: 1A 45 DF A3
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return { detected: 'webm/mkv', mediaType: 'video' };
  }
  // AVI: RIFF....AVI
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'AVI ') {
    return { detected: 'avi', mediaType: 'video' };
  }

  return { detected: 'unrecognized', mediaType: 'unknown' };
}

function parsePngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

interface FfprobeOutput {
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    duration?: string;
    bit_rate?: string;
    sample_rate?: string;
    channels?: number;
    r_frame_rate?: string;
  }>;
  format?: {
    format_name?: string;
    format_long_name?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
    tags?: Record<string, string>;
  };
}

async function runFfprobe(filePath: string): Promise<{ ok: boolean; data?: FfprobeOutput; error?: string }> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-show_format', '-show_streams', '-print_format', 'json', filePath],
      { timeout: 10000, maxBuffer: 1024 * 1024 },
    );
    return { ok: true, data: JSON.parse(stdout) as FfprobeOutput };
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string })?.stderr ?? '';
    return { ok: false, error: stderr.trim() || (err instanceof Error ? err.message : 'ffprobe inspection failed') };
  }
}

async function runFfmpegDecodeCheck(filePath: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { stderr } = await execFileAsync(
      'ffmpeg',
      ['-v', 'error', '-t', '10', '-i', filePath, '-f', 'null', '-'],
      { timeout: 12000, maxBuffer: 512 * 1024 },
    );
    if (stderr && stderr.trim().length > 0) {
      return { ok: false, error: stderr.trim().slice(0, 400) };
    }
    return { ok: true };
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string })?.stderr ?? '';
    return { ok: false, error: (stderr || (err instanceof Error ? err.message : 'Frame decode failed')).trim().slice(0, 400) };
  }
}

export async function inspectMultimediaFile(input: {
  filePath: string;
  originalName: string;
  mimeType: string;
}): Promise<MultimediaReport> {
  const stats = fs.statSync(input.filePath);
  const fileSize = stats.size;
  const ext = path.extname(input.originalName).toLowerCase().replace('.', '');
  const problems: MediaProblem[] = [];

  const declaredType: 'image' | 'audio' | 'video' | 'unknown' =
    input.mimeType.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'].includes(ext)
      ? 'image'
      : input.mimeType.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'].includes(ext)
        ? 'audio'
        : input.mimeType.startsWith('video/') || ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'].includes(ext)
          ? 'video'
          : 'unknown';

  if (fileSize === 0) {
    return {
      fileName: input.originalName,
      mediaType: declaredType,
      mimeType: input.mimeType,
      fileSize: 0,
      format: ext || 'unknown',
      codec: 'none',
      durationSec: null,
      width: null,
      height: null,
      bitrate: null,
      validationStatus: 'corrupted',
      problems: [
        {
          title: 'Zero-byte media file',
          severity: 'critical',
          description: 'Uploaded file contains 0 bytes and has no valid header or stream data.',
          evidence: 'File size is 0 bytes.',
          suggestedSolution: 'Re-export or re-upload a complete, non-empty media asset.',
        },
      ],
      metadata: { emptyFile: true },
      browserPreviewSupported: false,
    };
  }

  const headBuf = Buffer.alloc(Math.min(fileSize, 4096));
  const fd = fs.openSync(input.filePath, 'r');
  try {
    fs.readSync(fd, headBuf, 0, headBuf.length, 0);
  } finally {
    fs.closeSync(fd);
  }

  const magic = detectMagicFormat(headBuf);
  const mediaType = magic.mediaType !== 'unknown' ? magic.mediaType : declaredType;

  // Header vs extension/MIME verification
  if (magic.detected === 'unrecognized') {
    problems.push({
      title: 'Invalid or unrecognized file header',
      severity: 'critical',
      description: `File "${input.originalName}" does not begin with a valid ${declaredType} magic-byte signature.`,
      evidence: `Leading hex bytes: ${headBuf.subarray(0, 12).toString('hex')}`,
      suggestedSolution: 'Verify the file is not corrupted, truncated, or renamed from an incompatible format.',
    });
  } else if (declaredType !== 'unknown' && magic.mediaType !== 'unknown' && declaredType !== magic.mediaType) {
    problems.push({
      title: 'MIME/extension mismatch with binary file header',
      severity: 'high',
      description: `File claims to be ${declaredType} (.${ext}) but header identifies ${magic.detected} (${magic.mediaType}).`,
      evidence: `Declared MIME: ${input.mimeType}; Detected header: ${magic.detected}`,
      suggestedSolution: 'Use the correct file extension and Content-Type header matching the actual container format.',
    });
  }

  // SVG special handling (ffprobe doesn't parse SVG)
  if (magic.detected === 'svg' || ext === 'svg') {
    const svgText = fs.readFileSync(input.filePath, 'utf8');
    if (/<script[\s>]|on\w+\s*=/i.test(svgText)) {
      problems.push({
        title: 'Potentially unsafe active script inside SVG',
        severity: 'critical',
        description: 'SVG contains <script> tags or inline event handlers that can trigger XSS.',
        evidence: 'Matched <script> or inline on* attribute in SVG XML.',
        suggestedSolution: 'Sanitize the SVG with DOMPurify/SVGO and strip all scripting elements.',
      });
    }
    const hasSvgRoot = /<svg[\s>]/i.test(svgText) && /<\/svg>/i.test(svgText);
    if (!hasSvgRoot) {
      problems.push({
        title: 'Malformed or truncated SVG markup',
        severity: 'high',
        description: 'SVG file is missing a valid opening or closing <svg> tag.',
        evidence: 'SVG root tags incomplete.',
        suggestedSolution: 'Repair the XML structure or re-export from your vector editor.',
      });
    }
    return {
      fileName: input.originalName,
      mediaType: 'image',
      mimeType: 'image/svg+xml',
      fileSize,
      format: 'svg',
      codec: 'vector/xml',
      durationSec: null,
      width: null,
      height: null,
      bitrate: null,
      validationStatus: problems.some((p) => p.severity === 'critical' || p.severity === 'high') ? 'corrupted' : 'valid',
      problems,
      metadata: { vector: true },
      browserPreviewSupported: hasSvgRoot && !problems.some((p) => p.severity === 'critical'),
    };
  }

  // Run real ffprobe for image/audio/video
  const probe = await runFfprobe(input.filePath);
  let format = magic.detected !== 'unrecognized' ? magic.detected : ext || 'unknown';
  let codec = 'unknown';
  let durationSec: number | null = null;
  let width: number | null = null;
  let height: number | null = null;
  let bitrate: number | null = null;
  let metadata: Record<string, unknown> = { magicHeader: magic.detected };

  if (!probe.ok || !probe.data) {
    problems.push({
      title: 'Corrupted media container or unreadable stream',
      severity: 'critical',
      description: 'FFprobe failed to parse container headers or media streams.',
      evidence: probe.error ?? 'FFprobe returned non-zero exit code.',
      suggestedSolution: 'Re-encode the file with FFmpeg or re-export from the source tool to rebuild container headers.',
    });
  } else {
    const streams = probe.data.streams ?? [];
    const fmt = probe.data.format ?? {};
    format = fmt.format_name || format;
    durationSec = fmt.duration ? Number(fmt.duration) : null;
    bitrate = fmt.bit_rate ? Number(fmt.bit_rate) : null;

    const videoStreams = streams.filter((s) => s.codec_type === 'video');
    const audioStreams = streams.filter((s) => s.codec_type === 'audio');

    metadata = {
      magicHeader: magic.detected,
      formatLongName: fmt.format_long_name,
      streamCount: streams.length,
      videoStreams: videoStreams.length,
      audioStreams: audioStreams.length,
      tags: fmt.tags ?? {},
    };

    if (mediaType === 'image') {
      const imgStream = videoStreams[0];
      if (!imgStream) {
        problems.push({
          title: 'Missing image stream data',
          severity: 'critical',
          description: 'No decodable image stream found inside file.',
          evidence: '0 image/video streams returned by ffprobe.',
          suggestedSolution: 'Re-save the image as standard PNG, JPEG, or WebP.',
        });
      } else {
        codec = imgStream.codec_name || format;
        width = imgStream.width ?? parsePngDimensions(headBuf)?.width ?? null;
        height = imgStream.height ?? parsePngDimensions(headBuf)?.height ?? null;

        if (!width || !height || width <= 0 || height <= 0) {
          problems.push({
            title: 'Invalid image dimensions',
            severity: 'high',
            description: 'Image reports zero or missing pixel dimensions.',
            evidence: `Reported dimensions: ${width}x${height}`,
            suggestedSolution: 'Inspect image header metadata and re-export with valid dimensions.',
          });
        } else if (width > 6000 || height > 6000) {
          problems.push({
            title: 'Oversized image dimensions for web delivery',
            severity: 'medium',
            description: `Image resolution (${width}x${height}) is excessively large for standard web viewports.`,
            evidence: `Dimensions: ${width}x${height}px (${Math.round(fileSize / 1024)} KB)`,
            suggestedSolution: 'Resize to <= 2560px and serve responsive WebP/AVIF variants.',
          });
        }
        if (!WEB_COMPATIBLE_IMAGES.has(magic.detected) && !WEB_COMPATIBLE_IMAGES.has(codec)) {
          problems.push({
            title: `Unsupported web image format (${codec})`,
            severity: 'high',
            description: 'Image codec is not broadly supported across modern browsers.',
            evidence: `Detected codec: ${codec}, format: ${format}`,
            suggestedSolution: 'Convert image to PNG, JPEG, or WebP for cross-browser compatibility.',
          });
        }
      }
    } else if (mediaType === 'audio') {
      const audStream = audioStreams[0];
      if (!audStream) {
        problems.push({
          title: 'Missing audio stream',
          severity: 'critical',
          description: 'Audio file contains no valid audio track.',
          evidence: `Streams found: ${streams.length} (0 audio streams).`,
          suggestedSolution: 'Verify audio export settings and ensure at least one audio track is muxed.',
        });
      } else {
        codec = audStream.codec_name || 'unknown';
        metadata.sampleRate = audStream.sample_rate;
        metadata.channels = audStream.channels;
        if (durationSec === null || Number.isNaN(durationSec) || durationSec <= 0) {
          problems.push({
            title: 'Missing or zero audio duration',
            severity: 'high',
            description: 'Audio container lacks valid duration metadata.',
            evidence: `Duration reported as ${durationSec}`,
            suggestedSolution: 'Remux the audio file with FFmpeg to write accurate duration headers.',
          });
        }
        if (!WEB_COMPATIBLE_AUDIO_CODECS.has(codec)) {
          problems.push({
            title: `Browser playback compatibility warning (${codec})`,
            severity: 'medium',
            description: `Codec "${codec}" may fail to play natively in HTML5 <audio> across browsers.`,
            evidence: `Detected audio codec: ${codec}`,
            suggestedSolution: 'Transcode audio to AAC (MP4/M4A), MP3, or Opus (WebM/Ogg) for universal playback.',
          });
        }
      }
    } else if (mediaType === 'video') {
      const vidStream = videoStreams[0];
      const audStream = audioStreams[0];
      if (!vidStream) {
        problems.push({
          title: 'Missing video stream',
          severity: 'critical',
          description: 'Video container has no decodable video track.',
          evidence: `Streams found: ${streams.length} (0 video streams).`,
          suggestedSolution: 'Re-encode or remux the video ensuring a valid H.264/VP9 video stream is included.',
        });
      } else {
        codec = vidStream.codec_name || 'unknown';
        width = vidStream.width ?? null;
        height = vidStream.height ?? null;
        metadata.frameRate = vidStream.r_frame_rate;
        metadata.audioCodec = audStream?.codec_name ?? 'none';

        if (!audStream) {
          problems.push({
            title: 'Missing audio stream in video container',
            severity: 'low',
            description: 'Video file contains a video track but no audio track (silent video).',
            evidence: 'audioStreams: 0',
            suggestedSolution: 'If audio is expected, verify audio track routing during encoding.',
          });
        }
        if (durationSec === null || Number.isNaN(durationSec) || durationSec <= 0) {
          problems.push({
            title: 'Invalid or missing video duration',
            severity: 'high',
            description: 'Container metadata does not provide a valid duration.',
            evidence: `Duration: ${durationSec}`,
            suggestedSolution: 'Remux with "ffmpeg -i input -c copy -movflags +faststart output.mp4".',
          });
        }
        if (!WEB_COMPATIBLE_VIDEO_CODECS.has(codec)) {
          problems.push({
            title: `Unsupported HTML5 video codec (${codec})`,
            severity: 'high',
            description: `Video codec "${codec}" is not universally playable in browser <video> elements.`,
            evidence: `Codec: ${codec}; Container: ${format}`,
            suggestedSolution: 'Transcode to H.264 (libx264) + AAC inside MP4 with +faststart, or VP9/AV1 in WebM.',
          });
        }
        if (format.includes('avi') || format.includes('matroska') && !ext.includes('webm')) {
          problems.push({
            title: `Container format compatibility issue (${format})`,
            severity: 'medium',
            description: 'Container format is not natively supported by all web browsers.',
            evidence: `Container: ${format}`,
            suggestedSolution: 'Repackage or transcode into MP4 (H.264/AAC) or WebM (VP9/Opus).',
          });
        }
      }
    }

    // Run real FFmpeg frame/stream decode check for audio & video & images
    const decode = await runFfmpegDecodeCheck(input.filePath);
    if (!decode.ok) {
      problems.push({
        title: 'Frame / stream decoding errors detected',
        severity: 'critical',
        description: 'FFmpeg encountered errors while decoding media frames/packets.',
        evidence: decode.error ?? 'Decoder reported corrupted packets.',
        suggestedSolution: 'Repair or re-encode the source media; corrupted frames can freeze or crash players.',
      });
    }
  }

  const hasCritical = problems.some((p) => p.severity === 'critical');
  const hasHigh = problems.some((p) => p.severity === 'high');
  const hasAny = problems.length > 0;

  let validationStatus: MultimediaReport['validationStatus'] = 'valid';
  if (hasCritical) {
    validationStatus = 'corrupted';
  } else if (problems.some((p) => /unsupported/i.test(p.title))) {
    validationStatus = 'unsupported';
  } else if (hasHigh || hasAny) {
    validationStatus = 'warnings';
  }

  const browserPreviewSupported =
    !hasCritical &&
    ((mediaType === 'image' && WEB_COMPATIBLE_IMAGES.has(magic.detected)) ||
      (mediaType === 'audio' && WEB_COMPATIBLE_AUDIO_CODECS.has(codec)) ||
      (mediaType === 'video' && WEB_COMPATIBLE_VIDEO_CODECS.has(codec) && (format.includes('mp4') || format.includes('webm'))));

  return {
    fileName: input.originalName,
    mediaType,
    mimeType: input.mimeType,
    fileSize,
    format,
    codec,
    durationSec: durationSec !== null && !Number.isNaN(durationSec) ? Number(durationSec.toFixed(2)) : null,
    width,
    height,
    bitrate,
    validationStatus,
    problems,
    metadata,
    browserPreviewSupported,
  };
}

/**
 * Scans an uploaded project's HTML/CSS/JS files for broken local image/video/audio asset references.
 */
export function scanProjectMediaReferences(
  files: Array<{ relativePath: string; content: string }>,
): Array<{ sourceFile: string; lineNumber: number; referencedAsset: string; assetType: string; status: 'missing' | 'present' }> {
  const existing = new Set(files.map((f) => f.relativePath));
  const refs: Array<{ sourceFile: string; lineNumber: number; referencedAsset: string; assetType: string; status: 'missing' | 'present' }> = [];

  const mediaExtRegex = /\.(png|jpe?g|gif|webp|svg|bmp|mp4|webm|mov|mkv|avi|mp3|wav|ogg|flac|m4a)$/i;
  const refRegex = /(?:src|poster|href)\s*=\s*["']([^"']+)["']|url\(["']?([^"')]+)["']?\)/gi;

  for (const file of files) {
    if (!/\.(html?|css|scss|jsx?|tsx?)$/i.test(file.relativePath)) continue;
    const dir = path.posix.dirname(file.relativePath);
    const lines = file.content.split(/\r?\n/);

    lines.forEach((line, idx) => {
      let m: RegExpExecArray | null;
      refRegex.lastIndex = 0;
      while ((m = refRegex.exec(line)) !== null) {
        const raw = (m[1] || m[2] || '').trim();
        if (!raw || /^https?:\/\/|^data:|^\/api\//i.test(raw)) continue;
        const clean = raw.split('?')[0].split('#')[0];
        if (!mediaExtRegex.test(clean)) continue;
        const resolved = path.posix.normalize(clean.startsWith('/') ? clean.slice(1) : path.posix.join(dir === '.' ? '' : dir, clean));
        const ext = path.posix.extname(clean).toLowerCase();
        const assetType = /\.(mp4|webm|mov|mkv|avi)$/.test(ext)
          ? 'video'
          : /\.(mp3|wav|ogg|flac|m4a)$/.test(ext)
            ? 'audio'
            : 'image';
        refs.push({
          sourceFile: file.relativePath,
          lineNumber: idx + 1,
          referencedAsset: raw,
          assetType,
          status: existing.has(resolved) ? 'present' : 'missing',
        });
      }
    });
  }

  return refs;
}
