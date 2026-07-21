import { MESSAGE_TYPES, TARGETS } from "../shared/constants.js";
import { transcribeAudio, translateText } from "../shared/openai.js";

const MIN_BLOB_BYTES = 1_000;
const MAX_QUEUE_LENGTH = 4;
const MIN_SPEECH_RATIO = 0.035;

let session = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== TARGETS.OFFSCREEN) return false;

  if (message.type === MESSAGE_TYPES.OFFSCREEN_START) {
    startSession(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: errorMessage(error) }),
      );
    return true;
  }

  if (message.type === MESSAGE_TYPES.OFFSCREEN_STOP) {
    stopSession(message.reason)
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: errorMessage(error) }),
      );
    return true;
  }

  return false;
});

async function startSession(payload) {
  if (!payload?.streamId || !payload?.sessionId || !payload?.settings) {
    throw new Error("音声セッションの開始情報が不足しています。");
  }

  await stopSession("新しいセッションへ切り替えます。");

  const mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: payload.streamId,
      },
    },
    video: false,
  });

  const audioContext = new AudioContext();
  const sourceNode = audioContext.createMediaStreamSource(mediaStream);
  const analyserNode = audioContext.createAnalyser();
  analyserNode.fftSize = 1024;
  analyserNode.smoothingTimeConstant = 0.45;

  sourceNode.connect(analyserNode);
  sourceNode.connect(audioContext.destination);
  await audioContext.resume();

  const abortController = new AbortController();
  session = {
    ...payload,
    mediaStream,
    audioContext,
    sourceNode,
    analyserNode,
    abortController,
    active: true,
    queue: [],
    processing: false,
    activeRecorders: new Set(),
    previousTranscript: "",
    sequence: 0,
    consecutiveErrors: 0,
    droppedSegments: 0,
  };

  for (const track of mediaStream.getAudioTracks()) {
    track.addEventListener(
      "ended",
      () => {
        if (!session?.active) return;
        void reportFatalError("対象タブの音声ストリームが終了しました。");
      },
      { once: true },
    );
  }

  void captureLoop(session);
}

async function stopSession(_reason = "") {
  const current = session;
  if (!current) return;

  current.active = false;
  current.abortController.abort("session-stopped");
  current.queue.length = 0;

  await Promise.allSettled(
    [...current.activeRecorders].map((recorderState) =>
      stopRecorder(recorderState, false),
    ),
  );

  current.mediaStream.getTracks().forEach((track) => track.stop());
  current.sourceNode.disconnect();
  current.analyserNode.disconnect();
  await current.audioContext.close().catch(() => undefined);

  if (session === current) session = null;
}

async function captureLoop(activeSession) {
  const segmentMilliseconds = activeSession.settings.segmentSeconds * 1_000;
  const overlapMilliseconds = Math.min(
    activeSession.settings.overlapMilliseconds,
    segmentMilliseconds - 500,
  );
  const leadMilliseconds = segmentMilliseconds - overlapMilliseconds;

  let currentRecorder = startRecorder(activeSession);

  try {
    while (activeSession.active && session === activeSession) {
      await delay(leadMilliseconds, activeSession.abortController.signal);
      if (!activeSession.active) break;

      const nextRecorder = startRecorder(activeSession);
      await delay(overlapMilliseconds, activeSession.abortController.signal);

      const segment = await stopRecorder(currentRecorder, true);
      enqueueSegment(activeSession, segment);
      currentRecorder = nextRecorder;
    }
  } catch (error) {
    if (error?.name !== "AbortError" && activeSession.active) {
      await reportFatalError(
        `音声の分割処理に失敗しました: ${errorMessage(error)}`,
      );
    }
  } finally {
    await stopRecorder(currentRecorder, false).catch(() => undefined);
  }
}

function startRecorder(activeSession) {
  const mimeType = selectMimeType();
  const chunks = [];
  const recorder = new MediaRecorder(activeSession.mediaStream, {
    ...(mimeType ? { mimeType } : {}),
    audioBitsPerSecond: 128_000,
  });

  const recorderState = {
    recorder,
    chunks,
    startedAt: performance.now(),
    speechSamples: 0,
    totalSamples: 0,
    sampleBuffer: new Float32Array(activeSession.analyserNode.fftSize),
    sampleTimer: null,
    stopped: false,
  };

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data?.size) chunks.push(event.data);
  });

  recorderState.sampleTimer = setInterval(() => {
    activeSession.analyserNode.getFloatTimeDomainData(
      recorderState.sampleBuffer,
    );
    const rms = rootMeanSquare(recorderState.sampleBuffer);
    recorderState.totalSamples += 1;
    if (rms >= activeSession.settings.silenceThreshold) {
      recorderState.speechSamples += 1;
    }
  }, 100);

  activeSession.activeRecorders.add(recorderState);
  recorder.start();
  return recorderState;
}

function stopRecorder(recorderState, collectBlob) {
  if (!recorderState || recorderState.stopped) {
    return Promise.resolve(null);
  }

  recorderState.stopped = true;
  clearInterval(recorderState.sampleTimer);
  session?.activeRecorders.delete(recorderState);

  return new Promise((resolve, reject) => {
    const { recorder } = recorderState;

    const finish = () => {
      if (!collectBlob) {
        resolve(null);
        return;
      }

      const blob = new Blob(recorderState.chunks, {
        type: recorder.mimeType || "audio/webm",
      });
      resolve({
        blob,
        durationMilliseconds: performance.now() - recorderState.startedAt,
        speechRatio:
          recorderState.totalSamples === 0
            ? 1
            : recorderState.speechSamples / recorderState.totalSamples,
      });
    };

    recorder.addEventListener("stop", finish, { once: true });
    recorder.addEventListener(
      "error",
      (event) => reject(event.error ?? new Error("MediaRecorder error")),
      { once: true },
    );

    if (recorder.state === "inactive") finish();
    else recorder.stop();
  });
}

function enqueueSegment(activeSession, segment) {
  if (!segment || segment.blob.size < MIN_BLOB_BYTES) return;
  if (
    activeSession.settings.silenceGate &&
    segment.speechRatio < MIN_SPEECH_RATIO
  ) {
    return;
  }

  if (activeSession.queue.length >= MAX_QUEUE_LENGTH) {
    activeSession.queue.shift();
    activeSession.droppedSegments += 1;
  }

  activeSession.queue.push(segment);
  void processQueue(activeSession);
}

async function processQueue(activeSession) {
  if (activeSession.processing || !activeSession.active) return;
  activeSession.processing = true;

  try {
    while (activeSession.active && activeSession.queue.length > 0) {
      const segment = activeSession.queue.shift();

      try {
        const transcript = await withRetry(
          () =>
            transcribeAudio({
              blob: segment.blob,
              settings: activeSession.settings,
              signal: activeSession.abortController.signal,
              previousTranscript: activeSession.previousTranscript,
            }),
          activeSession.abortController.signal,
        );

        if (!transcript || !activeSession.active) continue;

        const translated = await withRetry(
          () =>
            translateText({
              text: transcript,
              settings: activeSession.settings,
              signal: activeSession.abortController.signal,
            }),
          activeSession.abortController.signal,
        );

        activeSession.previousTranscript = transcript;
        activeSession.sequence += 1;
        activeSession.consecutiveErrors = 0;

        await chrome.runtime.sendMessage({
          target: TARGETS.SERVICE_WORKER,
          type: MESSAGE_TYPES.OFFSCREEN_CAPTION,
          payload: {
            sessionId: activeSession.sessionId,
            tabId: activeSession.tabId,
            sequence: activeSession.sequence,
            original: transcript,
            translated,
            createdAt: Date.now(),
            segmentDurationMilliseconds: Math.round(
              segment.durationMilliseconds,
            ),
            droppedSegments: activeSession.droppedSegments,
          },
        });
      } catch (error) {
        if (error?.name === "AbortError") return;
        activeSession.consecutiveErrors += 1;

        if (activeSession.consecutiveErrors >= 3 || error?.status === 401) {
          await reportFatalError(errorMessage(error));
          return;
        }
      }
    }
  } finally {
    activeSession.processing = false;
  }
}

async function withRetry(operation, signal, retries = 2) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal.aborted) throw abortError();

    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (error?.name === "AbortError") throw error;
      if (error?.status === 401 || error?.status === 400) throw error;
      if (attempt === retries) break;
      await delay(500 * 2 ** attempt, signal);
    }
  }

  throw lastError;
}

async function reportFatalError(message) {
  const current = session;
  if (!current) return;

  await chrome.runtime.sendMessage({
    target: TARGETS.SERVICE_WORKER,
    type: MESSAGE_TYPES.OFFSCREEN_ERROR,
    error: message,
  });
  await stopSession(message);
}

function selectMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function rootMeanSquare(buffer) {
  let sum = 0;
  for (const sample of buffer) sum += sample * sample;
  return Math.sqrt(sum / buffer.length);
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);

    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError() {
  return new DOMException("Aborted", "AbortError");
}

function errorMessage(error) {
  return error?.message ?? String(error);
}
