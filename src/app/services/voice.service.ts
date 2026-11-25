/**
 * ReadyAssist Voice Agent — Grok Realtime Speech-to-Speech service.
 *
 * Sends 24 kHz PCM16 audio to the backend WebSocket, which proxies it to
 * xAI's Realtime API. Incoming audio is base64 PCM16 and is played through
 * a Web Audio playback queue.
 */

import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

export interface VoiceState {
  isConnected: boolean;
  isRecording: boolean;
  isListening: boolean;
  isSpeaking: boolean;
  audioBlocked: boolean;
  transcription: string;
  error: string | null;
}

export interface VoiceMessage {
  type: 'session_info' | 'ready' | 'transcription' | 'response_delta' |
        'response_done' | 'audio' | 'speech_started' | 'tool_call' | 'error' | 'pong' |
        'session_closed' | 'budget_warning';
  reason?: string;
  text?: string;
  data?: string;
  name?: string;
  success?: boolean;
  session_id?: string;
  state?: string;
  error?: string;
  estimated_cost_usd?: number;
}

export interface VoiceSessionContext {
  customer_name?: string;
  customer_mobile?: string;
  customer_id?: string;
  vehicle?: Record<string, unknown> | null;
}

const SAMPLE_RATE = 24000;

// Client-controlled turns: only upload actual speech, then commit.
// 4096 samples at 24 kHz ≈ 171 ms per frame. 3 pre-roll frames ≈ 0.5 s and
// 5 silent frames ≈ 0.85 s before commit.
const VOICE_RMS_THRESHOLD = 0.015;
const SILENCE_FRAMES_TO_COMMIT = 5;
const PREROLL_FRAMES = 3;

@Injectable({
  providedIn: 'root'
})
export class VoiceService {
  private websocket: WebSocket | null = null;

  // Capture (microphone → PCM16)
  private captureStream: MediaStream | null = null;
  private captureContext: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private silentGain: GainNode | null = null;

  // Playback (PCM16 → speakers)
  private playbackContext: AudioContext | null = null;
  private activeSources: AudioBufferSourceNode[] = [];
  private nextPlayTime = 0;
  private speakingTimer: any = null;
  private audioUnlockArmed = false;

  // Voice activity detection for client-controlled turns.
  private speechActive = false;
  private silenceFrames = 0;
  private preRollFrames: Int16Array[] = [];
  private lastSessionContext: VoiceSessionContext | null = null;

  private voiceStateSubject = new BehaviorSubject<VoiceState>({
    isConnected: false,
    isRecording: false,
    isListening: false,
    isSpeaking: false,
    audioBlocked: false,
    transcription: '',
    error: null
  });
  public voiceState$ = this.voiceStateSubject.asObservable();

  private messagesSubject = new BehaviorSubject<VoiceMessage | null>(null);
  public messages$ = this.messagesSubject.asObservable();

  private get wsUrl(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host || 'localhost:4200';
    return `${protocol}//${host}/api/ws/realtime`;
  }

  constructor() {
    // Close the xAI session when the tab is closed or navigated away.
    window.addEventListener('beforeunload', () => this.disconnect());
  }

  /** Connect to the Grok Realtime WebSocket. */
  connect(sessionId?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.websocket?.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      if (this.websocket?.readyState === WebSocket.CONNECTING) {
        // Wait briefly for the pending connection rather than opening a second socket.
        const check = window.setInterval(() => {
          if (!this.websocket) {
            window.clearInterval(check);
            reject(new Error('Connection failed'));
          } else if (this.websocket.readyState === WebSocket.OPEN) {
            window.clearInterval(check);
            resolve();
          } else if (this.websocket.readyState === WebSocket.CLOSED) {
            window.clearInterval(check);
            reject(new Error('Connection failed'));
          }
        }, 50);
        return;
      }

      const url = sessionId ? `${this.wsUrl}?session_id=${encodeURIComponent(sessionId)}` : this.wsUrl;
      this.websocket = new WebSocket(url);
      let settled = false;

      this.websocket.onopen = () => {
        settled = true;
        this.updateState({ isConnected: true, error: null });
        resolve();
      };

      this.websocket.onmessage = (event) => this.handleWebSocketMessage(event);

      this.websocket.onerror = (error) => {
        console.error('Grok Realtime WebSocket error:', error);
        this.updateState({ error: 'Voice connection error', isConnected: false });
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      this.websocket.onclose = () => {
        settled = true;
        this.cleanupCapture();
        this.updateState({ isConnected: false, isRecording: false, isListening: false });
      };
    });
  }

  /** Send customer/vehicle details so the backend session is personalised. */
  sendSessionContext(context: VoiceSessionContext): void {
    this.lastSessionContext = context;
    this.sendJson({ type: 'session_context', ...context });
  }

  /** Start streaming microphone audio to Grok. */
  async startRecording(): Promise<void> {
    await this.connect();
    if (this.captureStream) {
      this.updateState({ isRecording: true, isListening: true, error: null });
      return;
    }

    try {
      this.captureStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true
        }
      });

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.captureContext = new AudioCtx({ sampleRate: SAMPLE_RATE });
      // Auto-start has no click gesture to unlock audio, so resume without waiting
      // and retry on the first user interaction if the browser keeps it suspended.
      void this.captureContext.resume();
      void this.ensurePlaybackContext();

      const actualRate = this.captureContext.sampleRate;
      this.sourceNode = this.captureContext.createMediaStreamSource(this.captureStream);
      this.processor = this.captureContext.createScriptProcessor(4096, 1, 1);
      this.silentGain = this.captureContext.createGain();
      this.silentGain.gain.value = 0;

      this.processor.onaudioprocess = (event) => {
        if (this.websocket?.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        const pcm = this.resample(input, actualRate, SAMPLE_RATE);
        const int16 = new Int16Array(pcm.length);
        let sumSquares = 0;
        for (let i = 0; i < pcm.length; i++) {
          const sample = Math.max(-1, Math.min(1, pcm[i]));
          int16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
          sumSquares += sample * sample;
        }
        const rms = Math.sqrt(sumSquares / pcm.length);

        // Never upload while Grok is talking: avoids speaker echo and audio cost.
        if (this.getState().isSpeaking) {
          if (this.speechActive) {
            this.sendJson({ type: 'commit' });
            this.speechActive = false;
            this.silenceFrames = 0;
            this.preRollFrames = [];
          }
          return;
        }

        if (!this.speechActive) {
          // Keep a short pre-roll so soft first syllables aren't clipped.
          this.preRollFrames.push(int16);
          if (this.preRollFrames.length > PREROLL_FRAMES) this.preRollFrames.shift();
          if (rms <= VOICE_RMS_THRESHOLD) return;
          this.speechActive = true;
          this.silenceFrames = 0;
          for (const frame of this.preRollFrames) this.sendAudioFrame(frame);
          this.preRollFrames = [];
          return;
        }

        this.sendAudioFrame(int16);
        if (rms < VOICE_RMS_THRESHOLD) {
          this.silenceFrames += 1;
          if (this.silenceFrames >= SILENCE_FRAMES_TO_COMMIT) {
            this.sendJson({ type: 'commit' });
            this.speechActive = false;
            this.silenceFrames = 0;
          }
        } else {
          this.silenceFrames = 0;
        }
      };

      this.sourceNode.connect(this.processor);
      this.processor.connect(this.silentGain);
      this.silentGain.connect(this.captureContext.destination);

      this.updateState({ isRecording: true, isListening: true, error: null });
      window.setTimeout(() => {
        const blocked = this.captureContext?.state === 'suspended' ||
          this.playbackContext?.state === 'suspended';
        this.updateState({ audioBlocked: blocked });
      }, 600);
    } catch (error) {
      console.error('Failed to start Grok voice capture:', error);
      this.cleanupCapture();
      this.updateState({ error: 'Microphone access denied or unavailable', isRecording: false });
      throw error;
    }
  }

  /** Stop microphone streaming. Client-side VAD commits each spoken turn. */
  stopRecording(): void {
    this.cleanupCapture();
    this.updateState({ isRecording: false, isListening: false });
  }

  /** Send a typed message through the same Realtime session. */
  sendTextMessage(text: string): void {
    this.sendJson({ type: 'text_message', text });
  }

  disconnect(): void {
    this.stopRecording();
    this.stopPlayback();
    if (this.websocket) {
      this.websocket.close();
      this.websocket = null;
    }
    this.updateState({
      isConnected: false,
      isRecording: false,
      isListening: false,
      isSpeaking: false,
      audioBlocked: false,
      transcription: '',
      error: null
    });
  }

  getState(): VoiceState {
    return this.voiceStateSubject.value;
  }

  private sendJson(payload: unknown): void {
    if (this.websocket?.readyState === WebSocket.OPEN) {
      this.websocket.send(JSON.stringify(payload));
    } else {
      console.warn('Voice WebSocket is not connected; message dropped');
    }
  }

  private sendAudioFrame(int16: Int16Array): void {
    this.sendJson({
      type: 'audio',
      data: this.arrayBufferToBase64(int16.buffer as ArrayBuffer)
    });
  }

  private handleWebSocketMessage(event: MessageEvent): void {
    let message: VoiceMessage;
    try {
      message = typeof event.data === 'string' ? JSON.parse(event.data) : JSON.parse(event.data as string);
    } catch (error) {
      console.error('Invalid Realtime message from server:', error);
      return;
    }
    this.messagesSubject.next(message);

    switch (message.type) {
      case 'session_info':
        break;
      case 'ready':
        this.updateState({ isConnected: true });
        if (this.lastSessionContext) {
          this.sendJson({ type: 'session_context', ...this.lastSessionContext });
        }
        break;
      case 'session_closed': {
        const reason = message.reason;
        const hint =
          reason === 'idle'
            ? 'Session closed after inactivity. Tap the mic to continue.'
            : reason === 'max_duration'
              ? 'Session reached the 15-minute limit. Tap the mic to start a new one.'
              : reason === 'budget'
                ? 'Daily voice budget reached. Tap the mic to reconnect later.'
                : reason === 'duplicate_session'
                  ? 'Another voice session is already active for this customer.'
                  : 'Voice session closed. Tap the mic to reconnect.';
        this.updateState({
          isConnected: false,
          isRecording: false,
          isListening: false,
          error: hint
        });
        break;
      }
      case 'budget_warning':
        this.updateState({
          error: `Voice cost warning: about $${(message.estimated_cost_usd ?? 0).toFixed(2)} used this session.`
        });
        break;
      case 'transcription':
        this.updateState({ transcription: message.text || '' });
        break;
      case 'response_delta':
        break;
      case 'audio':
        if (message.data) {
          this.playPcm16(message.data);
        }
        break;
      case 'speech_started':
        this.stopPlayback();
        this.updateState({ isSpeaking: false });
        break;
      case 'response_done':
        break;
      case 'error':
        this.updateState({ error: message.error || 'ReadyAssist Voice AI error' });
        break;
      default:
        break;
    }
  }

  private async ensurePlaybackContext(): Promise<AudioContext> {
    if (!this.playbackContext) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.playbackContext = new AudioCtx({ sampleRate: SAMPLE_RATE });
    }
    if (this.playbackContext.state === 'suspended') {
      // Don't await: with auto-start there may be no user gesture yet, and some
      // browsers leave resume() pending until the first interaction.
      void this.playbackContext.resume();
      this.armAudioUnlock();
    }
    return this.playbackContext;
  }

  /** Unlock capture/playback audio on the first interaction after auto-start. */
  private armAudioUnlock(): void {
    if (this.audioUnlockArmed || typeof document === 'undefined') return;
    this.audioUnlockArmed = true;
    const unlock = () => {
      Promise.all([
        this.captureContext?.resume(),
        this.playbackContext?.resume(),
      ]).then(() => this.updateState({ audioBlocked: false }))
        .catch(() => undefined);
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
      this.audioUnlockArmed = false;
    };
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('keydown', unlock);
  }

  private async playPcm16(base64: string): Promise<void> {
    try {
      const ctx = await this.ensurePlaybackContext();
      const bytes = this.base64ToUint8Array(base64);
      const int16 = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
      }

      const buffer = ctx.createBuffer(1, float32.length, SAMPLE_RATE);
      buffer.copyToChannel(float32, 0);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      const startAt = Math.max(ctx.currentTime, this.nextPlayTime);
      source.start(startAt);
      this.nextPlayTime = startAt + buffer.duration;
      this.activeSources.push(source);
      source.onended = () => {
        this.activeSources = this.activeSources.filter(item => item !== source);
      };

      this.updateState({ isSpeaking: true });
      if (this.speakingTimer) window.clearTimeout(this.speakingTimer);
      this.speakingTimer = window.setTimeout(() => {
        if (this.activeSources.length === 0) {
          this.updateState({ isSpeaking: false });
        }
      }, Math.max(0, (this.nextPlayTime - ctx.currentTime) * 1000) + 100);
    } catch (error) {
      console.error('Grok audio playback failed:', error);
      this.updateState({ error: 'Audio playback failed' });
    }
  }

  private stopPlayback(): void {
    for (const source of this.activeSources) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    this.activeSources = [];
    this.nextPlayTime = 0;
    if (this.speakingTimer) {
      window.clearTimeout(this.speakingTimer);
      this.speakingTimer = null;
    }
  }

  private cleanupCapture(): void {
    this.speechActive = false;
    this.silenceFrames = 0;
    this.preRollFrames = [];
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.silentGain) {
      this.silentGain.disconnect();
      this.silentGain = null;
    }
    if (this.captureStream) {
      this.captureStream.getTracks().forEach(track => track.stop());
      this.captureStream = null;
    }
    if (this.captureContext) {
      this.captureContext.close().catch(() => undefined);
      this.captureContext = null;
    }
  }

  private resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
    if (Math.abs(fromRate - toRate) < 1) return input;
    const ratio = fromRate / toRate;
    const outputLength = Math.floor(input.length / ratio);
    const output = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      const position = i * ratio;
      const index = Math.floor(position);
      const fraction = position - index;
      const next = input[index + 1] ?? input[index];
      output[i] = input[index] * (1 - fraction) + next * fraction;
    }
    return output;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
    }
    return btoa(binary);
  }

  private base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  private updateState(partialState: Partial<VoiceState>): void {
    this.voiceStateSubject.next({ ...this.voiceStateSubject.value, ...partialState });
  }
}
