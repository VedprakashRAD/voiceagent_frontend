import { Component, ViewChild, ElementRef, OnDestroy, ChangeDetectorRef, OnInit, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ChatService } from '../../services/chat.service';
import { ApiService, CustomerDetails } from '../../services/api.service';
import { VoiceService } from '../../services/voice.service';

@Component({
  selector: 'app-voice-agent',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './voice-agent.component.html',
  styleUrl: './voice-agent.component.css',
  schemas: [CUSTOM_ELEMENTS_SCHEMA]
})
export class VoiceAgentComponent implements OnInit, OnDestroy {
  @ViewChild('orb') orbRef!: ElementRef;
  
  inputText = '';
  isLoading = false;
  sessionId = '';
  sessionState = 'NEW';
  isConnected = false;
  
  userId: string | null = null;
  vehicleId: string | null = null;
  customerParam = '';
  customer: CustomerDetails | null = null;
  customerName = '';
  customerMobile = '';
  customerId = '';
  externalVehicleId = '';
  userName: string = 'ReadyAssist AI';
  vehicleName: string = '';
  
  // Speech / Realtime properties
  isListening = false;
  aiSpeaking = false;
  synthesis: any = null;
  voiceError = '';
  private voiceResponseText = '';
  private selectedVehicle: any = null;

  // Web Audio API properties for orb
  private audioContext?: AudioContext;
  private micStream?: MediaStream;

  constructor(
    private chatService: ChatService, 
    private apiService: ApiService,
    private voiceService: VoiceService,
    private cdr: ChangeDetectorRef,
    private route: ActivatedRoute,
    private router: Router
  ) {
    if ('speechSynthesis' in window) {
      this.synthesis = window.speechSynthesis;
    }

    // Get user and vehicle IDs from query params
    this.route.queryParams.subscribe(params => {
      this.userId = params['userId'] || null;
      this.vehicleId = params['vehicleId'] || null;
      this.customerParam = params['customer'] || '';

      if (this.customerParam) {
        try {
          this.customer = JSON.parse(this.customerParam) as CustomerDetails;
          this.customerName = this.customer.customerName || this.customer.name || '';
          this.customerMobile = this.customer.mobileNo || '';
          this.customerId = this.customer.customerId != null ? String(this.customer.customerId) : '';
          this.externalVehicleId = this.customer.externalVehicleId != null ? String(this.customer.externalVehicleId) : '';
          if (this.customerName) {
            this.userName = this.customerName;
          }
        } catch {
          this.customer = null;
        }
      }

      if (!this.userId || !this.vehicleId) {
        console.warn("User or Vehicle ID not provided! Redirecting to landing page.");
        this.router.navigate(['/']);
      }
    });

    // Subscribe to session state
    this.chatService.sessionId$.subscribe(id => {
      this.sessionId = id;
      this.cdr.detectChanges();
    });
    this.chatService.sessionState$.subscribe(state => {
      this.sessionState = state;
      this.cdr.detectChanges();
    });
    this.chatService.isConnected$.subscribe(connected => {
      this.isConnected = connected;
      this.cdr.detectChanges();
    });

    // Grok Realtime voice state
    this.voiceService.voiceState$.subscribe(state => {
      this.isListening = state.isRecording || state.isListening;
      this.aiSpeaking = state.isSpeaking;
      this.isConnected = state.isConnected;
      if (state.error) {
        this.voiceError = state.error;
      }
      this.cdr.detectChanges();
    });

    this.voiceService.messages$.subscribe(message => {
      if (!message) return;
      switch (message.type) {
        case 'session_info':
          if (message.session_id) {
            this.sessionId = message.session_id;
          }
          this.voiceError = '';
          break;
        case 'ready':
          this.voiceError = '';
          break;
        case 'transcription':
          this.inputText = message.text || '';
          break;
        case 'response_delta':
          this.voiceResponseText += message.text || '';
          break;
        case 'response_done':
          this.voiceResponseText = '';
          break;
        case 'error':
          this.voiceError = message.error || 'Voice error';
          break;
        default:
          break;
      }
      this.cdr.detectChanges();
    });
  }

  ngOnInit() {
    if (this.userId) {
      this.apiService.getUsers().subscribe(users => {
        const user = users.find(u => u._id === this.userId);
        if (user) {
          if (!this.customerName) {
            this.userName = user.name;
          }
          this.cdr.detectChanges();
        }
      });
    }
    
    if (this.vehicleId) {
      this.apiService.getAllVehicles().subscribe(vehicles => {
        const vehicle = vehicles.find(v => v._id === this.vehicleId);
        if (vehicle) {
          this.selectedVehicle = vehicle;
          this.vehicleName = `${vehicle.make} ${vehicle.model}`;
          this.sendVoiceContext();
          this.cdr.detectChanges();
        }
      });
    }

    this.connectVoice();
  }

  ngOnDestroy(): void {
    this.voiceService.disconnect();
    this.stopAudioAnalysis();
  }

  private async connectVoice(): Promise<void> {
    try {
      await this.voiceService.connect(this.sessionId || undefined);
      this.sendVoiceContext();
    } catch (error) {
      console.error('Could not connect to Grok Realtime:', error);
      this.voiceError = 'Voice service unavailable. Check backend and API key.';
      this.cdr.detectChanges();
    }
  }

  private sendVoiceContext(): void {
    this.voiceService.sendSessionContext({
      customer_name: this.customerName || undefined,
      customer_mobile: this.customerMobile || undefined,
      customer_id: this.customerId || undefined,
      vehicle: this.selectedVehicle
        ? {
            id: this.selectedVehicle._id,
            make: this.selectedVehicle.make,
            model: this.selectedVehicle.model,
            registration: this.selectedVehicle.registration || this.selectedVehicle.vehicleNo || '',
          }
        : null,
    });
  }

  get orbState(): string {
    if (this.isLoading) return 'thinking';
    if (this.aiSpeaking) return 'speaking';
    if (this.isListening) return 'listening';
    return 'idle';
  }

  get statusHeading(): string {
    if (this.isLoading) return 'Thinking...';
    if (this.aiSpeaking) return 'Speaking...';
    if (this.isListening) return 'Listening...';
    if (this.userName && this.userName !== 'ReadyAssist AI') {
      return `${this.userName}, how can I help?`;
    }
    return 'How can I help?';
  }

  get statusSubtitle(): string {
    if (this.isLoading) return 'Checking the latest details...';
    if (this.aiSpeaking) return 'ReadyAssist is responding';
    if (this.isListening) return 'Tell me what you need';
    return 'Tap the microphone to speak';
  }

  get hintText(): string {
    if (this.voiceError) return this.voiceError;
    if (this.isLoading) return 'Thinking...';
    if (this.aiSpeaking) return 'Speaking...';
    if (this.isListening) return 'Listening...';
    return 'Tap to speak';
  }

  goBack() {
    this.router.navigate(['/'], {
      queryParams: this.customerParam ? { customer: this.customerParam } : {}
    });
  }

  async toggleListening(): Promise<void> {
    if (this.isListening) {
      this.voiceService.stopRecording();
      this.stopAudioAnalysis();
      return;
    }

    this.inputText = '';
    this.voiceError = '';
    try {
      await this.voiceService.startRecording();
      await this.startAudioAnalysis();
    } catch (err) {
      console.error('Could not start Grok voice capture:', err);
      this.voiceError = 'Microphone unavailable or voice service disconnected.';
      this.cdr.detectChanges();
    }
  }

  private async startAudioAnalysis(): Promise<void> {
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      await this.audioContext.resume();
      
      const source = this.audioContext.createMediaStreamSource(this.micStream);
      
      // Connect to the voice orb
      if (this.orbRef && this.orbRef.nativeElement) {
        await this.orbRef.nativeElement.connect(source);
      }
    } catch (err) {
      console.error("Audio analysis failed", err);
    }
  }

  private stopAudioAnalysis(): void {
    if (this.orbRef && this.orbRef.nativeElement && typeof this.orbRef.nativeElement.disconnect === 'function') {
      this.orbRef.nativeElement.disconnect();
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach(track => track.stop());
    }
    if (this.audioContext) {
      this.audioContext.close();
    }
    this.micStream = undefined;
    this.audioContext = undefined;
  }

  speakText(text: string): void {
    if (!this.synthesis) return;
    this.synthesis.cancel();
    
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    utterance.onstart = () => {
      this.aiSpeaking = true;
      this.cdr.detectChanges();
    };

    utterance.onend = () => {
      this.aiSpeaking = false;
      this.cdr.detectChanges();
    };

    utterance.onerror = (event: any) => {
      console.error('TTS error', event);
      this.aiSpeaking = false;
      this.cdr.detectChanges();
    };

    this.synthesis.speak(utterance);
  }

  sendMessage(text?: string): void {
    const message = text || this.inputText.trim();
    if (!message || this.isLoading) return;

    this.inputText = '';
    this.isLoading = true;
    this.cdr.detectChanges();

    this.chatService.sendMessage(message, this.sessionId, this.userId, this.vehicleId, this.customer).subscribe({
      next: (response) => {
        this.isLoading = false;
        this.cdr.detectChanges();
        this.speakText(response.response);
      },
      error: (err) => {
        this.isLoading = false;
        this.cdr.detectChanges();
        this.speakText('I am sorry, I am having trouble connecting to the server right now.');
      },
    });
  }
}

