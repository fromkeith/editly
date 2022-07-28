const execa = require('execa');
const assert = require('assert');

const { getFfmpegCommonArgs } = require('../ffmpeg');
const { readFileStreams } = require('../util');
const { rgbaToFabricImage, blurImage } = require('./fabric');

module.exports = async ({ width: canvasWidth, height: canvasHeight, channels, framerateStr, verbose, logTimes, ffmpegPath, ffprobePath, enableFfmpegLog, params }) => {
  const { path, cutFrom, cutTo, resizeMode = 'contain-blur', speedFactor, inputWidth, inputHeight, width: requestedWidthRel, height: requestedHeightRel, left: leftRel = 0, top: topRel = 0, originX = 'left', originY = 'top' } = params;

  const requestedWidth = requestedWidthRel ? Math.round(requestedWidthRel * canvasWidth) : canvasWidth;
  const requestedHeight = requestedHeightRel ? Math.round(requestedHeightRel * canvasHeight) : canvasHeight;

  const left = leftRel * canvasWidth;
  const top = topRel * canvasHeight;

  const ratioW = requestedWidth / inputWidth;
  const ratioH = requestedHeight / inputHeight;
  const inputAspectRatio = inputWidth / inputHeight;

  let targetWidth = requestedWidth;
  let targetHeight = requestedHeight;

  let scaleFilter;
  if (['contain', 'contain-blur'].includes(resizeMode)) {
    if (ratioW > ratioH) {
      targetHeight = requestedHeight;
      targetWidth = Math.round(requestedHeight * inputAspectRatio);
    } else {
      targetWidth = requestedWidth;
      targetHeight = Math.round(requestedWidth / inputAspectRatio);
    }

    scaleFilter = `scale=${targetWidth}:${targetHeight}`;
  } else if (resizeMode === 'cover') {
    let scaledWidth;
    let scaledHeight;

    if (ratioW > ratioH) {
      scaledWidth = requestedWidth;
      scaledHeight = Math.round(requestedWidth / inputAspectRatio);
    } else {
      scaledHeight = requestedHeight;
      scaledWidth = Math.round(requestedHeight * inputAspectRatio);
    }

    // TODO improve performance by crop first, then scale?
    scaleFilter = `scale=${scaledWidth}:${scaledHeight},crop=${targetWidth}:${targetHeight}`;
  } else { // 'stretch'
    scaleFilter = `scale=${targetWidth}:${targetHeight}`;
  }

  if (verbose) console.log(scaleFilter);

  let ptsFilter = '';
  if (speedFactor !== 1) {
    if (verbose) console.log('speedFactor', speedFactor);
    ptsFilter = `setpts=${speedFactor}*PTS`;
  }

  const frameByteSize = targetWidth * targetHeight * channels;

  // TODO assert that we have read the correct amount of frames

  
  // let inFrameCount = 0;

  // https://forum.unity.com/threads/settings-for-importing-a-video-with-an-alpha-channel.457657/
  const streams = await readFileStreams(ffprobePath, path);
  const firstVideoStream = streams.find((s) => s.codec_type === 'video');
  // https://superuser.com/a/1116905/658247

  let inputCodec;
  let hwAccel = [];
  let hwFilter;
  if (firstVideoStream.codec_name === 'vp8') inputCodec = 'libvpx';
  else if (firstVideoStream.codec_name === 'vp9') inputCodec = 'libvpx-vp9';
  else if (firstVideoStream.codec_name === 'hevc') {
    // TODO: scaleFilter
    hwAccel = ['-hwaccel', 'cuvid', '-resize', '1920x1080'];
    inputCodec = 'hevc_cuvid'
    hwFilter = ['-vf', 'hwdownload,format=nv12' + (ptsFilter ? `,${ptsFilter}` : '')];
  }

  console.log({
    path,
    codec: firstVideoStream.codec_name,
    ptsFilter,
    framerateStr,
    scaleFilter,
    hwFilter,
  });

  // http://zulko.github.io/blog/2013/09/27/read-and-write-video-frames-in-python-using-ffmpeg/
  // Testing: ffmpeg -i 'vid.mov' -t 1 -vcodec rawvideo -pix_fmt rgba -f image2pipe - | ffmpeg -f rawvideo -vcodec rawvideo -pix_fmt rgba -s 2166x1650 -i - -vf format=yuv420p -vcodec libx264 -y out.mp4
  // https://trac.ffmpeg.org/wiki/ChangingFrameRate
  /*
  -hwaccel cuvid -vcodec hevc_cuvid -ss 359 -i samples/test-foam.MP4 -t 58 -vf fps=30000/1001,scale=1920:1080 -map v:0 -vcodec rawvideo -pix_fmt rgba -f image2pipe -
  */
  const args = [
    ...getFfmpegCommonArgs({ enableFfmpegLog }),
    ...(hwAccel),
    ...(inputCodec ? ['-vcodec', inputCodec] : []),
    ...(cutFrom ? ['-ss', cutFrom] : []),
    '-i', path,
    ...(cutTo ? ['-t', (cutTo - cutFrom) * speedFactor] : []),
    ...(hwFilter ? (hwFilter) : (['-vf', `${ptsFilter ? ptsFilter + ',' : ''}fps=${framerateStr},${scaleFilter}`])),
    // '-map', 'v:0',
    // '-vcodec', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-f', 'rawvideo',
    '-',
  ];
  if (verbose) console.log(args.join(' '));

  const ps = execa(ffmpegPath, args, { encoding: null, buffer: false, stdin: 'ignore', stdout: 'pipe', stderr: process.stderr });

  const stream = ps.stdout;

  let timeout;
  let ended = false;

  stream.once('end', () => {
    clearTimeout(timeout);
    if (verbose) console.log(path, 'ffmpeg video stream ended');
    ended = true;
  });


  const readBuffers = [];
  // const writeBuffers = [];
  let streamPaused = false;
  let isDone = false;

  function returnReadBuffer(buf) {
    writeBuffers.push(buf);
    if (streamPaused) {
      streamPaused = false;
      stream.on('data', handleChunk);
      stream.on('end', onEnd);
      // stream.on('error', reject);
      stream.resume();
    }
  }
  let nextFrameReadyDefer = null;
  function giveReadBuffer(buf) {
    readBuffers.push(buf);
    if (nextFrameReadyDefer) {
      nextFrameReadyDefer();
      nextFrameReadyDefer = null;
    }
  }
  async function getReadFrame() {
    if (readBuffers.length > 0) {
      return readBuffers.shift();
    }
    return new Promise((resolve) => {
      nextFrameReadyDefer = resolve;
    }).then(() => {
      return readBuffers.shift();
    });
  }

  const writeBuffers = [
    Buffer.allocUnsafe(frameByteSize),
    Buffer.allocUnsafe(frameByteSize),
    Buffer.allocUnsafe(frameByteSize),
    Buffer.allocUnsafe(frameByteSize),
    Buffer.allocUnsafe(frameByteSize),
  ];

  function cleanup() {
    streamPaused = true;
    stream.pause();
    // eslint-disable-next-line no-use-before-define
    stream.removeListener('data', handleChunk);
    stream.removeListener('end', onEnd);
    // stream.removeListener('error', reject);
  }
  function onEnd() {
    isDone = true;
  }
  let length = 0;

  let activeBuffer;
  function handleChunk(chunk) {
    // console.log('chunk', chunk.length);
    // console.log('writeBuffers', writeBuffers.length);
    if (!activeBuffer) {
      activeBuffer = writeBuffers.pop();
    }
    const nCopied = length + chunk.length > frameByteSize ? frameByteSize - length : chunk.length;
    chunk.copy(activeBuffer, length, 0, nCopied);
    length += nCopied;

    if (length > frameByteSize) console.error('Video data overflow', length);

    if (length >= frameByteSize) {
      // console.log('Finished reading frame', inFrameCount, path);
      // making a copy... why? ah... cause of left over being put at front for next frame
      // const out = Buffer.from(buf);

      const restLength = chunk.length - nCopied;
      if (restLength > 0) {
        // if (verbose) console.log('Left over data', nCopied, chunk.length, restLength);
        chunk.slice(nCopied).copy(writeBuffers[writeBuffers.length - 1], 0);
        length = restLength;
      } else {
        length = 0;
      }

      // inFrameCount += 1;
      // always need 2 buffers avaialble incase of overflow
      if (writeBuffers.length === 1) {
        // clearTimeout(timeout);
        cleanup();
      }
      giveReadBuffer(activeBuffer);
      activeBuffer = null;
    }
  }
  stream.on('data', handleChunk);
  stream.on('end', onEnd);
  // stream.on('error', reject);
  stream.resume();


  async function readNextFrame(progress, canvas) {
    // console.log('--' + path);
    const rgba = await new Promise((resolve, reject) => {
      if (ended) {
        console.log(path, 'Tried to read next video frame after ffmpeg video stream ended');
        resolve();
        return;
      }
      // console.log('Reading new frame', path);
      if (isDone) {
        resolve();
        return;
      }
      getReadFrame().then(resolve, reject);
      // timeout = setTimeout(() => {
      //   console.warn('Timeout on read video frame');
      //   cleanup();
      //   resolve();
      // }, 60000);

    });

    if (!rgba) return;

    assert(rgba.length === frameByteSize);

    if (resizeMode !== 'contain-blur' && requestedWidth == targetWidth && requestedHeight == targetHeight) {
      if (logTimes) console.time('copyFrameBufferS')
      const copy = Buffer.from(rgba);
      if (logTimes) console.timeEnd('copyFrameBufferS')
      returnReadBuffer(rgba);
      return copy;
    }

    if (logTimes) console.time('rgbaToFabricImage');
    const img = await rgbaToFabricImage({ width: targetWidth, height: targetHeight, rgba });
    if (logTimes) console.timeEnd('rgbaToFabricImage');

    img.setOptions({
      originX,
      originY,
    });

    let centerOffsetX = 0;
    let centerOffsetY = 0;
    if (resizeMode === 'contain' || resizeMode === 'contain-blur') {
      const dirX = originX === 'left' ? 1 : -1;
      const dirY = originY === 'top' ? 1 : -1;
      centerOffsetX = (dirX * (requestedWidth - targetWidth)) / 2;
      centerOffsetY = (dirY * (requestedHeight - targetHeight)) / 2;
    }

    img.setOptions({
      left: left + centerOffsetX,
      top: top + centerOffsetY,
    });


    if (resizeMode === 'contain-blur') {
      const mutableImg = await new Promise((r) => img.cloneAsImage(r));
      const blurredImg = await blurImage({ mutableImg, width: requestedWidth, height: requestedHeight });
      blurredImg.setOptions({
        left,
        top,
        originX,
        originY,
      });
      canvas.add(blurredImg);
    } else if (left === 0 && top === 0 && centerOffsetX === 0 && centerOffsetY === 0) {
      if (logTimes) console.time('copyFrameBuffer')
      const copy = Buffer.from(rgba);
      if (logTimes) console.timeEnd('copyFrameBuffer')
      returnReadBuffer(rgba);
      return copy;
    }
    returnReadBuffer(rgba);


    canvas.add(img);
  }

  const close = () => {
    if (verbose) console.log('Close', path);
    ps.cancel();
  };

  return {
    readNextFrame,
    close,
  };
};
