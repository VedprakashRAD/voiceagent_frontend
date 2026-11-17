/**
 * ReadyAssist Voice Agent — Voice Service
 *
 * Handles real-time voice communication with the backend via WebSocket.
 * Supports microphone input, audio playback, and real-time transcription.
 */

import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

export interface VoiceState {
  isConnected: boolean;
  isRecording: boolean;
  isListening: boolean;
  isSpeaking: boolean;
  transcription: string;
  error: string | null;
}

export interface VoiceMessage {
  type: 'transcription' | 'response' | 'session_info' | 'error';
  text?: string;
  session_id?: string;
  session_state?: string;
  error?: string;
}

@Injectable({
  providedIn: 'root'
})
export class VoiceService {
  private readonly wsUrl = 'ws://localhost:8000/api/ws/voice';

  private websocket: WebSocket | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioContext: AudioContext | null = null;
  private audioStream: MediaStream | null = null;

  // State observables
  private voiceStateSubject = new BehaviorSubject<VoiceState>({
    isConnected: false,
    isRecording: false,
    isListening: false,
    isSpeaking: false,
    transcription: '',
    error: null
  });

  public voiceState$ = this.voiceStateSubject.asObservable();

  // Message stream
  private messagesSubject = new BehaviorSubject<VoiceMessage | null>(null);
  public messages$ = this.messagesSubject.asObservable();

  constructor() {}

  /**
   * Connect to the voice WebSocket
   */
  connect(sessionId?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.websocket?.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      const url = sessionId ? `${this.wsUrl}?session_id=${sessionId}` : this.wsUrl;
      this.websocket = new WebSocket(url);

      this.websocket.onopen = () => {
        console.log('Voice WebSocket connected');
        this.updateState({ isConnected: true, error: null });
        resolve();
      };

      this.websocket.onmessage = (event) => {
        this.handleWebSocketMessage(event);
      };

      this.websocket.onerror = (error) => {
        console.error('Voice WebSocket error:', error);
        this.updateState({ error: 'Connection error', isConnected: false });
        reject(error);
      };

      this.websocket.onclose = () => {
        console.log('Voice WebSocket closed');
        this.updateState({ isConnected: false, isRecording: false });
      };
    });
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleWebSocketMessage(event: MessageEvent): void {
    if (event.data instanceof Blob) {
      // Audio data from server
      this.playAudio(event.data);
    } else {
      // JSON message
      try {
        const message: VoiceMessage = JSON.parse(event.data);
        this.messagesSubject.next(message);

        switch (message.type) {
          case 'transcription':
            this.updateState({ 
              transcription: message.text || '',
              isListening: false 
            });
            break;

          case 'response':
            // Text response received (audio will follow)
            this.updateState({ isSpeaking: true });
            break;

          case 'session_info':
            console.log('Session info:', message);
            break;

          case 'error':
            this.updateState({ error: message.error || 'Unknown error' });
            break;
        }
      } catch (e) {
        console.error('Failed to parse message:', e);
      }
    }
  }

  /**
   * Start recording audio from microphone
   */
  async startRecording(): Promise<void> {
    if (this.mediaRecorder?.state === 'recording') {
      console.warn('Already recording');
      return;
    }

    try {
      // Request microphone access
      this.audioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true
        }
      });

      // Create MediaRecorder
      this.mediaRecorder = new MediaRecorder(this.audioStream, {
        mimeType: 'audio/webm;codecs=opus'
      });

      // Send audio chunks to server
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && this.websocket?.readyState === WebSocket.OPEN) {
          // Convert to ArrayBuffer and send
          event.data.arrayBuffer().then(buffer => {
            this.websocket?.send(buffer);
          });
        }
      };

      this.mediaRecorder.onstart = () => {
        this.updateState({ isRecording: true, isListening: true, error: null });
      };

      this.mediaRecorder.onstop = () => {
        this.updateState({ isRecording: false, isListening: false });
        
        // Notify server that recording stopped
        if (this.websocket?.readyState === WebSocket.OPEN) {
          this.websocket.send(JSON.stringify({ type: 'stop_recording' }));
        }
      };

      // Start recording with 100ms chunks for low latency
      this.mediaRecorder.start(100);

      console.log('Recording started');
    } catch (error) {
      console.error('Failed to start recording:', error);
      this.updateState({ 
        error: 'Microphone access denied or unavailable',
        isRecording: false 
      });
      throw error;
    }
  }

  /**
   * Stop recording audio
   */
  stopRecording(): void {
    if (this.mediaRecorder?.state === 'recording') {
      this.mediaRecorder.stop();
      console.log('Recording stopped');
    }

    // Stop audio tracks
    if (this.audioStream) {
      this.audioStream.getTracks().forEach(track => track.stop());
      this.audioStream = null;
    }
  }

  /**
   * Play audio response from server
   */
  private async playAudio(audioBlob: Blob): Promise<void> {
    try {
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);

      audio.onplay = () => {
        this.updateState({ isSpeaking: true });
      };

      audio.onended = () => {
        this.updateState({ isSpeaking: false });
        URL.revokeObjectURL(audioUrl);
      };

      audio.onerror = (error) => {
        console.error('Audio playback error:', error);
        this.updateState({ isSpeaking: false, error: 'Audio playback failed' });
        URL.revokeObjectURL(audioUrl);
      };

      await audio.play();
    } catch (error) {
      console.error('Failed to play audio:', error);
      this.updateState({ isSpeaking: false, error: 'Audio playback failed' });
    }
  }

  /**
   * Send text message (without voice)
   */
  sendTextMessage(text: string): void {
    if (this.websocket?.readyState === WebSocket.OPEN) {
      this.websocket.send(JSON.stringify({
        type: 'text_message',
        text: text
      }));
    } else {
      console.error('WebSocket not connected');
    }
  }

  /**
   * Disconnect from voice WebSocket
   */
  disconnect(): void {
    this.stopRecording();

    if (this.websocket) {
      this.websocket.close();
      this.websocket = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.updateState({
      isConnected: false,
      isRecording: false,
      isListening: false,
      isSpeaking: false,
      transcription: '',
      error: null
    });
  }

  /**
   * Update voice state
   */
  private updateState(partialState: Partial<VoiceState>): void {
    const currentState = this.voiceStateSubject.value;
    this.voiceStateSubject.next({ ...currentState, ...partialState });
  }

  /**
   * Get current voice state
   */
  getState(): VoiceState {
    return this.voiceStateSubject.value;
  }

  /**
   * Check if microphone is available
   */
  async checkMicrophoneAvailability(): Promise<boolean> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hasAudioInput = devices.some(device => device.kind === 'audioinput');
      return hasAudioInput;
    } catch (error) {
      console.error('Failed to check microphone:', error);
      return false;
    }
  }
}
