import { env, pipeline } from "@huggingface/transformers";
import { MESSAGE_TYPES, TARGETS } from "../shared/constants.js";
import {
  createLocalProcessingPlan,
  LOCAL_TRANSLATION_MODEL,
  whisperModelId,
} from "../shared/local-routing.js";
import { cleanSubtitle, trimTextOverlap } from "../shared/text.js";

const TARGET_SAMPLE_RATE = 16_000;
const MAX_QUEUE_LENGTH = 2;
const MIN_SEGMENT_SAMPLES = TARGET_SAMPLE_RATE;
const MIN_SPEECH_RATIO = 0.025;

let session = null;
let transformersConfigured = false;
const transcriberCache = new Map();
const localTranslatorCache = new Map();
const builtInTranslatorCache = new Map();

configureTransformers();

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

function configureTransformers() {
  if (transformersConfigured) return;
  transformersConfigured = true;

  env.allowRemoteModels = true;
  env.allowLocalModels = false;
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/onnx/");
  env.backends.onnx.wasm.numThreads = Math.max(
    1,
    Math.min(4, navigator.hardwareConcurrency ?? 2),
  );
}

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

  const audioContext = new AudioContext({ latencyHint: "interactive" });
  const sourceNode = audioContext.createMediaStreamSource(mediaStream);
  const analyserNode = audioContext.createAnalyser();
  analyserNode.fftSize = 1024;
  analyserNode.smoothingTimeConstant = 0.45;

  const processorNode = audioContext.createScriptProcessor(4096, 2, 1);
  const silentGainNode = audioContext.createGain();
  silentGainNode.gain.value = 0;

  sourceNode.connect(analyserNode);
  sourceNode.connect(audioContext.destination);
  sourceNode.connect(processorNode);
  processorNode.connect(silentGainNode);
  silentGainNode.connect(audioContext.destination);

  await audioContext.resume();

  const abortController = new AbortController();
  const activeSession = {
    ...payload,
    mediaStream,
    audioContext,
    sourceNode,
    analyserNode,
    processorNode,
    silentGainNode,
    abortController,
    active: true,
    queue: [],
    processing: false,
    pcmChunks: [],
    pcmSampleCount: 0,
    overlapTail: new Float32Array(0),
    previousTranscript: "",
    sequence: 0,
    droppedSegments: 0,
    modelDevice: "",
    plan: createLocalProcessingPlan(payload.settings),
  };

  processorNode.onaudioprocess = (event) => collectPcm(activeSession, event);
  session = activeSession;

  for (const track of mediaStream.getAudioTracks()) {
    track.addEventListener(
      "ended",
      () => {
        if (!activeSession.active) return;
        void reportFatalError("対象タブの音声ストリームが終了しました。");
      },
      { once: true },
    );
  }

  void initializeAndCapture(activeSession);
}

async function initializeAndCapture(activeSession) {
  try {
    await reportProgress(
      activeSession,
      "ローカル音声認識モデルを準備しています…",
    );
    const transcriber = await getTranscriber(activeSession);

    if (activeSession.plan.translationPair) {
      await reportProgress(
        activeSession,
        "ローカル翻訳モデルを準備しています…",
      );
      await getTranslator(activeSession, activeSession.plan.translationPair);
    }

    if (!activeSession.active || session !== activeSession) return;

    activeSession.transcriber = transcriber;
    await reportProgress(
      activeSession,
      `${deviceLabel(activeSession.modelDevice)}でローカル字幕を処理しています`,
      true,
    );
    void captureLoop(activeSession);
  } catch (error) {
    if (activeSession.active) {
      await reportFatalError(
        `ローカルモデルを開始できませんでした: ${errorMessage(error)}`,
      );
    }
  }
}

async function stopSession(_reason = "") {
  const current = session;
  if (!current) return;

  current.active = false;
  current.abortController.abort("session-stopped");
  current.queue.length = 0;
  current.processorNode.onaudioprocess = null;
  current.mediaStream.getTracks().forEach((track) => track.stop());

  for (const node of [
    current.sourceNode,
    current.analyserNode,
    current.processorNode,
    current.silentGainNode,
  ]) {
    node.disconnect();
  }

  await current.audioContext.close().catch(() => undefined);
  if (session === current) session = null;
}

function collectPcm(activeSession, event) {
  if (!activeSession.active || session !== activeSession) return;

  const input = event.inputBuffer;
  const channelCount = input.numberOfChannels;
  const frameCount = input.length;
  const mono = new Float32Array(frameCount);

  for (let channel = 0; channel < channelCount; channel += 1) {
    const samples = input.getChannelData(channel);
    for (let index = 0; index < frameCount; index += 1) {
      mono[index] += samples[index] / channelCount;
    }
  }

  activeSession.pcmChunks.push(mono);
  activeSession.pcmSampleCount += mono.length;
}

async function captureLoop(activeSession) {
  const segmentMilliseconds = activeSession.settings.segmentSeconds * 1_000;
  const overlapMilliseconds = Math.min(
    activeSession.settings.overlapMilliseconds,
    segmentMilliseconds - 1_000,
  );
  const leadMilliseconds = segmentMilliseconds - overlapMilliseconds;

  try {
    while (activeSession.active && session === activeSession) {
      await delay(leadMilliseconds, activeSession.abortController.signal);
      if (!activeSession.active) break;

      const rawSegment = drainPcm(activeSession, overlapMilliseconds);
      if (!rawSegment || rawSegment.length === 0) continue;

      const samples = resampleLinear(
        rawSegment,
        activeSession.audioContext.sampleRate,
        TARGET_SAMPLE_RATE,
      );
      if (samples.length < MIN_SEGMENT_SAMPLES) continue;

      const speechRatio = estimateSpeechRatio(
        samples,
        activeSession.settings.silenceThreshold,
      );
      if (
        activeSession.settings.silenceGate &&
        speechRatio < MIN_SPEECH_RATIO
      ) {
        continue;
      }

      enqueueSegment(activeSession, {
        samples,
        durationMilliseconds: Math.round(
          (samples.length / TARGET_SAMPLE_RATE) * 1_000,
        ),
      });
    }
  } catch (error) {
    if (error?.name !== "AbortError" && activeSession.active) {
      await reportFatalError(
        `音声の分割処理に失敗しました: ${errorMessage(error)}`,
      );
    }
  }
}

function drainPcm(activeSession, overlapMilliseconds) {
  if (activeSession.pcmSampleCount === 0) return null;

  const fresh = concatenateFloat32(
    activeSession.pcmChunks,
    activeSession.pcmSampleCount,
  );
  activeSession.pcmChunks = [];
  activeSession.pcmSampleCount = 0;

  const segment = concatenateFloat32(
    [activeSession.overlapTail, fresh],
    activeSession.overlapTail.length + fresh.length,
  );
  const overlapSamples = Math.round(
    (activeSession.audioContext.sampleRate * overlapMilliseconds) / 1_000,
  );
  activeSession.overlapTail = segment.slice(
    Math.max(0, segment.length - overlapSamples),
  );
  return segment;
}

function enqueueSegment(activeSession, segment) {
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
      const result = await activeSession.transcriber(segment.samples, {
        task: activeSession.plan.asrTask,
        ...(activeSession.plan.asrLanguage
          ? { language: activeSession.plan.asrLanguage }
          : {}),
        return_timestamps: false,
      });

      if (!activeSession.active) return;

      const recognized = applyVocabulary(
        cleanSubtitle(extractTranscription(result)),
        activeSession.settings.customVocabulary,
      );
      const transcript = trimTextOverlap(
        activeSession.previousTranscript,
        recognized,
      );
      if (!transcript) continue;

      let translated = transcript;
      if (activeSession.plan.translationPair) {
        translated = await translateLocally(
          activeSession,
          transcript,
          activeSession.plan.translationPair,
        );
      }
      if (!activeSession.active) return;

      activeSession.previousTranscript = recognized;
      activeSession.sequence += 1;

      await chrome.runtime.sendMessage({
        target: TARGETS.SERVICE_WORKER,
        type: MESSAGE_TYPES.OFFSCREEN_CAPTION,
        payload: {
          sessionId: activeSession.sessionId,
          tabId: activeSession.tabId,
          sequence: activeSession.sequence,
          original: transcript,
          translated: applyVocabulary(
            cleanSubtitle(translated),
            activeSession.settings.customVocabulary,
          ),
          createdAt: Date.now(),
          segmentDurationMilliseconds: segment.durationMilliseconds,
          droppedSegments: activeSession.droppedSegments,
          local: true,
          device: activeSession.modelDevice,
        },
      });
    }
  } catch (error) {
    if (error?.name !== "AbortError" && activeSession.active) {
      await reportFatalError(
        `ローカル字幕処理に失敗しました: ${errorMessage(error)}`,
      );
    }
  } finally {
    activeSession.processing = false;
  }
}

async function getTranscriber(activeSession) {
  const modelId = whisperModelId(activeSession.settings.modelSize);
  const attempts = inferenceAttempts(activeSession.settings.performanceMode);
  let lastError;

  for (const attempt of attempts) {
    const cacheKey = `${modelId}:${attempt.device}:${attempt.dtype ?? "default"}`;
    try {
      let modelPromise = transcriberCache.get(cacheKey);
      if (!modelPromise) {
        modelPromise = pipeline("automatic-speech-recognition", modelId, {
          device: attempt.device,
          ...(attempt.dtype ? { dtype: attempt.dtype } : {}),
          progress_callback: createModelProgressCallback(
            activeSession,
            "音声認識",
          ),
        });
        transcriberCache.set(cacheKey, modelPromise);
      }

      const model = await modelPromise;
      activeSession.modelDevice = attempt.device;
      return model;
    } catch (error) {
      transcriberCache.delete(cacheKey);
      lastError = error;
      await reportProgress(
        activeSession,
        `${deviceLabel(attempt.device)}で開始できなかったため別方式を試します…`,
      );
    }
  }

  throw lastError ?? new Error("利用できるローカル推論方式がありません。");
}

function inferenceAttempts(mode) {
  if (mode === "webgpu") {
    return [
      { device: "webgpu", dtype: "fp16" },
      { device: "webgpu", dtype: "fp32" },
    ];
  }
  if (mode === "wasm") {
    return [
      { device: "wasm", dtype: "int8" },
      { device: "wasm", dtype: "fp32" },
    ];
  }

  return navigator.gpu
    ? [
        { device: "webgpu", dtype: "fp16" },
        { device: "webgpu", dtype: "fp32" },
        { device: "wasm", dtype: "int8" },
        { device: "wasm", dtype: "fp32" },
      ]
    : [
        { device: "wasm", dtype: "int8" },
        { device: "wasm", dtype: "fp32" },
      ];
}

async function getTranslator(activeSession, pair) {
  const builtIn = await getBuiltInTranslator(activeSession, pair);
  if (builtIn) return { type: "built-in", value: builtIn };

  const key = `${pair.sourceLanguage}:${pair.targetLanguage}:${activeSession.modelDevice}`;
  let modelPromise = localTranslatorCache.get(key);
  if (!modelPromise) {
    const device =
      activeSession.modelDevice || (navigator.gpu ? "webgpu" : "wasm");
    modelPromise = pipeline("translation", LOCAL_TRANSLATION_MODEL, {
      device,
      dtype: device === "webgpu" ? "fp16" : "int8",
      progress_callback: createModelProgressCallback(activeSession, "翻訳"),
    }).catch(async () =>
      pipeline("translation", LOCAL_TRANSLATION_MODEL, {
        device,
        dtype: "fp32",
        progress_callback: createModelProgressCallback(activeSession, "翻訳"),
      }),
    );
    localTranslatorCache.set(key, modelPromise);
  }

  return { type: "transformers", value: await modelPromise };
}

async function getBuiltInTranslator(activeSession, pair) {
  if (!("Translator" in self)) return null;

  const key = `${pair.sourceLanguage}:${pair.targetLanguage}`;
  if (builtInTranslatorCache.has(key)) return builtInTranslatorCache.get(key);

  try {
    const options = {
      sourceLanguage: pair.sourceLanguage,
      targetLanguage: pair.targetLanguage,
    };
    const availability = await self.Translator.availability(options);
    if (availability === "unavailable") return null;

    const promise = self.Translator.create({
      ...options,
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          const percent = Math.round((event.loaded ?? 0) * 100);
          void reportProgress(
            activeSession,
            `ブラウザ内蔵翻訳モデルを取得中… ${percent}%`,
          );
        });
      },
    });
    builtInTranslatorCache.set(key, promise);
    return await promise;
  } catch {
    builtInTranslatorCache.delete(key);
    return null;
  }
}

async function translateLocally(activeSession, text, pair) {
  const translator = await getTranslator(activeSession, pair);
  if (translator.type === "built-in") {
    return translator.value.translate(text);
  }

  const result = await translator.value(text, { max_new_tokens: 256 });
  return extractTranslation(result);
}

function createModelProgressCallback(activeSession, label) {
  let lastPercent = -1;
  return (progress) => {
    if (!activeSession.active) return;

    const numeric = Number(progress?.progress);
    const percent = Number.isFinite(numeric) ? Math.round(numeric) : null;
    if (percent !== null && percent === lastPercent) return;
    if (percent !== null) lastPercent = percent;

    const file =
      typeof progress?.file === "string" ? shortFileName(progress.file) : "";
    const detail =
      percent === null ? (progress?.status ?? "準備中") : `${percent}%`;
    void reportProgress(
      activeSession,
      `${label}モデルを端末へ準備中… ${detail}${file ? ` / ${file}` : ""}`,
    );
  };
}

async function reportProgress(activeSession, message, ready = false) {
  if (!activeSession?.active) return;
  await chrome.runtime
    .sendMessage({
      target: TARGETS.SERVICE_WORKER,
      type: MESSAGE_TYPES.OFFSCREEN_PROGRESS,
      payload: {
        sessionId: activeSession.sessionId,
        tabId: activeSession.tabId,
        message,
        ready,
      },
    })
    .catch(() => undefined);
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

function extractTranscription(result) {
  if (typeof result === "string") return result;
  if (typeof result?.text === "string") return result.text;
  return "";
}

function extractTranslation(result) {
  const first = Array.isArray(result) ? result[0] : result;
  return (
    first?.translation_text ??
    first?.generated_text ??
    first?.text ??
    String(first ?? "")
  );
}

function applyVocabulary(text, vocabulary) {
  let output = String(text ?? "");
  const entries = String(vocabulary ?? "")
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const separator = entry.includes("=>")
      ? "=>"
      : entry.includes("=")
        ? "="
        : null;
    if (!separator) continue;

    const [from, ...rest] = entry.split(separator);
    const to = rest.join(separator).trim();
    if (!from.trim() || !to) continue;

    output = output.replace(new RegExp(escapeRegExp(from.trim()), "giu"), to);
  }

  return output;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function concatenateFloat32(chunks, totalLength) {
  const output = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function resampleLinear(input, sourceRate, targetRate) {
  if (sourceRate === targetRate) return input;

  const outputLength = Math.max(
    1,
    Math.round((input.length * targetRate) / sourceRate),
  );
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / targetRate;

  for (let index = 0; index < outputLength; index += 1) {
    const sourcePosition = index * ratio;
    const leftIndex = Math.floor(sourcePosition);
    const rightIndex = Math.min(input.length - 1, leftIndex + 1);
    const fraction = sourcePosition - leftIndex;
    output[index] =
      input[leftIndex] * (1 - fraction) + input[rightIndex] * fraction;
  }

  return output;
}

function estimateSpeechRatio(samples, threshold) {
  const windowSize = 1_600;
  let speechWindows = 0;
  let totalWindows = 0;

  for (let offset = 0; offset < samples.length; offset += windowSize) {
    const end = Math.min(samples.length, offset + windowSize);
    let sum = 0;
    for (let index = offset; index < end; index += 1) {
      sum += samples[index] * samples[index];
    }
    const rms = Math.sqrt(sum / Math.max(1, end - offset));
    totalWindows += 1;
    if (rms >= threshold) speechWindows += 1;
  }

  return totalWindows === 0 ? 0 : speechWindows / totalWindows;
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);

    const onAbort = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };

    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function deviceLabel(device) {
  return device === "webgpu" ? "GPU" : "CPU/WASM";
}

function shortFileName(file) {
  return file.split("/").at(-1)?.slice(0, 48) ?? "";
}

function errorMessage(error) {
  return error?.message ?? String(error);
}
