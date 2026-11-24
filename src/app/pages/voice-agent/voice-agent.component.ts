import { Component, ViewChild, ElementRef, OnDestroy, ChangeDetectorRef, OnInit, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ChatService } from '../../services/chat.service';
import { ApiService, CustomerDetails } from '../../services/api.service';

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
  
  // Speech API properties
  isListening = false;
  aiSpeaking = false;
  recognition: any = null;
  synthesis: any = null;
  private isStartingRecognition = false;

  // Web Audio API properties for orb
  private audioContext?: AudioContext;
  private micStream?: MediaStream;

  constructor(
    private chatService: ChatService, 
    private apiService: ApiService,
    private cdr: ChangeDetectorRef,
    private route: ActivatedRoute,
    private router: Router
  ) {
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

    this.initSpeechApi();
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
          this.vehicleName = `${vehicle.make} ${vehicle.model}`;
          this.cdr.detectChanges();
        }
      });
    }
  }

  ngOnDestroy(): void {
    this.stopAudioAnalysis();
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
    if (this.isLoading) return 'Thinking...';
    if (this.aiSpeaking) return 'Speaking...';
    if (this.isListening) return 'Listening...';
    return 'Tap to speak';
  }

  private initSpeechApi(): void {
    if ('speechSynthesis' in window) {
      this.synthesis = window.speechSynthesis;
    } else {
      console.warn('Text-to-Speech is not supported in this browser.');
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      this.recognition = new SpeechRecognition();
      this.recognition.continuous = false;
      this.recognition.interimResults = true;
      this.recognition.lang = 'en-US';

      this.recognition.onstart = () => {
        this.isStartingRecognition = false;
        this.isListening = true;
        this.startAudioAnalysis();
        this.cdr.detectChanges();
      };

      this.recognition.onresult = (event: any) => {
        let interimTranscript = '';
        let finalTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          } else {
            interimTranscript += event.results[i][0].transcript;
          }
        }
        this.inputText = finalTranscript || interimTranscript;
        this.cdr.detectChanges();
      };

      this.recognition.onerror = (event: any) => {
        console.error('Speech recognition error', event.error);
        this.isStartingRecognition = false;
        this.isListening = false;
        this.stopAudioAnalysis();
        this.cdr.detectChanges();
      };

      this.recognition.onend = () => {
        this.isStartingRecognition = false;
        this.isListening = false;
        this.stopAudioAnalysis();
        this.cdr.detectChanges();
        if (this.inputText.trim().length > 0) {
          this.sendMessage();
        }
      };
    } else {
      console.warn('Speech Recognition is not supported in this browser.');
    }
  }

  goBack() {
    this.router.navigate(['/'], {
      queryParams: this.customerParam ? { customer: this.customerParam } : {}
    });
  }

  toggleListening(): void {
    if (!this.recognition) {
      alert('Speech recognition is not supported in your browser. Try using Chrome or Edge.');
      return;
    }

    if (this.isListening || this.isStartingRecognition) {
      this.isStartingRecognition = false;
      this.recognition.stop();
      return;
    }

    this.inputText = '';
    try {
      this.isStartingRecognition = true;
      this.recognition.start();
    } catch (err) {
      this.isStartingRecognition = false;
      console.error('Speech recognition failed to start', err);
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

