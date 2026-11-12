/**
 * ReadyAssist Voice Agent — Chat Service
 *
 * Handles HTTP communication with the FastAPI backend.
 */

import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, BehaviorSubject, tap, catchError, throwError } from 'rxjs';

export interface ChatMessage {
  text: string;
  sender: 'user' | 'assistant';
  timestamp: Date;
  toolCalls?: ToolCallInfo[];
  isLoading?: boolean;
}

export interface ToolCallInfo {
  tool: string;
  success: boolean;
  timestamp: string;
}

export interface ChatResponse {
  response: string;
  session_id: string;
  session_state: string;
  tool_calls: ToolCallInfo[];
}

export interface SessionInfo {
  session_id: string;
  state: string;
  customer_name?: string;
  service?: { id: number; name: string };
  vehicle?: { id: number; name: string; registration: string };
  location?: { latitude: number; longitude: number; address: string };
  availability?: { available: boolean; mechanics: number; eta_minutes: number; price: number };
  order_id?: string;
}

@Injectable({
  providedIn: 'root'
})
export class ChatService {
  private readonly apiUrl = 'http://localhost:8000/api';

  private sessionId = new BehaviorSubject<string>('');
  private sessionState = new BehaviorSubject<string>('NEW');
  private isConnected = new BehaviorSubject<boolean>(false);

  sessionId$ = this.sessionId.asObservable();
  sessionState$ = this.sessionState.asObservable();
  isConnected$ = this.isConnected.asObservable();

  constructor(private http: HttpClient) {}

  /**
   * Send a chat message and get the agent's response.
   */
  sendMessage(message: string, sessionId?: string, userId?: string | null, vehicleId?: string | null): Observable<ChatResponse> {
    return this.http.post<ChatResponse>(`${this.apiUrl}/chat`, {
      message,
      session_id: sessionId || this.sessionId.value || undefined,
      user_id: userId || undefined,
      vehicle_id: vehicleId || undefined,
    }).pipe(
      tap(response => {
        this.sessionId.next(response.session_id);
        this.sessionState.next(response.session_state);
        this.isConnected.next(true);
      }),
      catchError(err => {
        this.isConnected.next(false);
        return throwError(() => err);
      })
    );
  }

  /**
   * Create a new session.
   */
  createSession(): Observable<SessionInfo> {
    return new Observable(observer => {
      this.http.post<SessionInfo>(`${this.apiUrl}/session`, {}).subscribe({
        next: (session) => {
          this.sessionId.next(session.session_id);
          this.sessionState.next(session.state);
          this.isConnected.next(true);
          observer.next(session);
          observer.complete();
        },
        error: (err) => {
          this.isConnected.next(false);
          observer.error(err);
        }
      });
    });
  }

  /**
   * Get current session info.
   */
  getSession(sessionId: string): Observable<SessionInfo> {
    return this.http.get<SessionInfo>(`${this.apiUrl}/session/${sessionId}`);
  }

  /**
   * Reset the session.
   */
  resetSession(): void {
    this.sessionId.next('');
    this.sessionState.next('NEW');
  }
}
