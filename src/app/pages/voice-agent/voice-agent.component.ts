import { Component, OnDestroy, ChangeDetectorRef, OnInit, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService, CustomerDetails, Vehicle } from '../../services/api.service';
import { VoiceService } from '../../services/voice.service';

@Component({
  selector: 'app-voice-agent',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './voice-agent.component.html',
  styleUrl: './voice-agent.component.css',
  schemas: [CUSTOM_ELEMENTS_SCHEMA]
})
export class VoiceAgentComponent implements OnInit, OnDestroy {
  sessionId = '';
  sessionState = 'NEW';
  isLoading = false;

  userId: string | null = null;
  vehicleId: string | null = null;
  customerParam = '';
  customer: CustomerDetails | null = null;
  customerName = '';
  customerMobile = '';
  customerId = '';
  externalVehicleId = '';
  userName = 'ReadyAssist AI';
  vehicleName = '';

  // Grok Realtime state only — no browser/local speech model.
  isListening = false;
  aiSpeaking = false;
  voiceError = '';
  private selectedVehicle: Vehicle | null = null;

  constructor(
    private apiService: ApiService,
    private voiceService: VoiceService,
    private cdr: ChangeDetectorRef,
    private route: ActivatedRoute,
    private router: Router
  ) {
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
        console.warn('User or Vehicle ID not provided! Redirecting to landing page.');
        this.router.navigate(['/']);
      }
    });

    this.voiceService.voiceState$.subscribe(state => {
      this.isListening = state.isRecording || state.isListening;
      this.aiSpeaking = state.isSpeaking;
      if (state.error) {
        this.voiceError = state.error;
      }
      this.cdr.detectChanges();
    });

    this.voiceService.messages$.subscribe(message => {
      if (!message) return;
      switch (message.type) {
        case 'session_info':
          if (message.session_id) this.sessionId = message.session_id;
          if (message.state) this.sessionState = message.state;
          this.voiceError = '';
          break;
        case 'ready':
          this.voiceError = '';
          break;
        case 'tool_call':
          this.isLoading = true;
          break;
        case 'response_done':
          this.isLoading = false;
          break;
        case 'error':
          this.voiceError = message.error || 'Grok Realtime error';
          this.isLoading = false;
          break;
        default:
          break;
      }
      this.cdr.detectChanges();
    });
  }

  ngOnInit(): void {
    if (this.userId) {
      this.apiService.getUsers().subscribe(users => {
        const user = users.find(u => u._id === this.userId);
        if (user) {
          if (!this.customerName) this.userName = user.name;
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

    void this.connectVoice();
  }

  ngOnDestroy(): void {
    this.voiceService.disconnect();
  }

  get orbState(): string {
    if (this.isLoading) return 'thinking';
    if (this.aiSpeaking) return 'speaking';
    if (this.isListening) return 'listening';
    return 'idle';
  }

  get statusHeading(): string {
    if (this.isLoading) return 'Checking the latest details...';
    if (this.aiSpeaking) return 'ReadyAssist is responding';
    if (this.isListening) return 'Listening...';
    if (this.userName && this.userName !== 'ReadyAssist AI') {
      return `${this.userName}, how can I help?`;
    }
    return 'How can I help?';
  }

  get statusSubtitle(): string {
    if (this.isLoading) return 'Looking up your request';
    if (this.aiSpeaking) return 'Grok is responding';
    if (this.isListening) return 'Tell me what you need';
    return 'Tap the microphone to speak';
  }

  get hintText(): string {
    if (this.voiceError) return this.voiceError;
    if (this.isLoading) return 'Checking...';
    if (this.aiSpeaking) return 'Speaking...';
    if (this.isListening) return 'Listening...';
    return 'Tap to speak';
  }

  goBack(): void {
    this.router.navigate(['/'], {
      queryParams: this.customerParam ? { customer: this.customerParam } : {}
    });
  }

  async toggleListening(): Promise<void> {
    if (this.isListening) {
      this.voiceService.stopRecording();
      return;
    }

    this.voiceError = '';
    try {
      await this.voiceService.startRecording();
    } catch (err) {
      console.error('Could not start Grok voice capture:', err);
      this.voiceError = 'Microphone unavailable or voice service disconnected.';
      this.cdr.detectChanges();
    }
  }

  /** Optional typed input uses the same Grok Realtime session. */
  sendText(text: string): void {
    const message = text.trim();
    if (!message) return;
    this.voiceService.sendTextMessage(message);
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
            registration: this.selectedVehicle.registration_number,
          }
        : null,
    });
  }
}
