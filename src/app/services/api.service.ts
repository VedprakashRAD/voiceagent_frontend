import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface User {
  _id: string;
  name: string;
  email?: string;
  created_at: string;
}

export interface Vehicle {
  _id: string;
  user_id: string;
  make: string;
  model: string;
  vehicle_type: string;
  registration_number: string;
  created_at: string;
}

export interface CustomerDetails {
  success: boolean;
  name: string;
  userId: string;
  mobileNo: string;
  customerId?: number;
  customerName?: string;
  customerEmail?: string | null;
  externalVehicleId?: number | string;
  isSubscribedCustomer?: boolean;
  subscriptionList?: unknown[];
  message?: string;
}

@Injectable({
  providedIn: 'root'
})
export class ApiService {
  private readonly apiUrl = '/api';

  constructor(private http: HttpClient) {}

  getUsers(): Observable<User[]> {
    return this.http.get<User[]>(`${this.apiUrl}/users`);
  }

  createUser(name: string): Observable<User> {
    return this.http.post<User>(`${this.apiUrl}/users`, { name });
  }

  deleteUser(userId: string): Observable<any> {
    return this.http.delete(`${this.apiUrl}/users/${userId}`);
  }

  getUserVehicles(userId: string): Observable<Vehicle[]> {
    return this.http.get<Vehicle[]>(`${this.apiUrl}/users/${userId}/vehicles`);
  }

  getAllVehicles(): Observable<Vehicle[]> {
    return this.http.get<Vehicle[]>(`${this.apiUrl}/vehicles`);
  }

  tagVehicle(userId: string, vehicle: Partial<Vehicle>): Observable<Vehicle> {
    return this.http.post<Vehicle>(`${this.apiUrl}/users/${userId}/vehicles`, vehicle);
  }

  checkSubscription(name: string, mobileNo: string): Observable<CustomerDetails> {
    return this.http.post<CustomerDetails>(`${this.apiUrl}/customers/is-subscribed`, { name, mobileNo });
  }
}
