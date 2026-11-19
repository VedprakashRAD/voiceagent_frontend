import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService, CustomerDetails, User, Vehicle } from '../../services/api.service';
import { forkJoin } from 'rxjs';

export interface UserWithVehicles extends User {
  vehicles: Vehicle[];
}

@Component({
  selector: 'app-user-selection',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './user-selection.component.html',
  styleUrl: './user-selection.component.css'
})
export class UserSelectionComponent implements OnInit {
  usersWithVehicles: UserWithVehicles[] = [];
  
  // Forms state
  showAddUserForm = false;
  showAddVehicleForm: Record<string, boolean> = {};

  // Form inputs
  newUserName = '';
  errorMessage = '';

  customerName = '';
  customerMobile = '';
  customer: CustomerDetails | null = null;
  lookupError = '';
  isLookingUp = false;

  newVehicle = {
    make: '',
    model: '',
    vehicle_type: 'car',
    registration_number: ''
  };

  constructor(
    private api: ApiService, 
    private router: Router,
    private route: ActivatedRoute,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit() {
    const customerParam = this.route.snapshot.queryParamMap.get('customer');
    if (customerParam) {
      try {
        this.customer = JSON.parse(customerParam) as CustomerDetails;
        this.loadData(this.customer.userId);
        return;
      } catch {
        this.customer = null;
      }
    }
    this.loadData();
  }

  loadData(userId?: string) {
    forkJoin({
      users: this.api.getUsers(),
      vehicles: this.api.getAllVehicles()
    }).subscribe(({ users, vehicles }) => {
      const sourceUsers = userId ? users.filter(u => u._id === userId) : users;
      this.usersWithVehicles = sourceUsers.map(u => ({
        ...u,
        name: this.customer?.customerName || this.customer?.name || u.name,
        vehicles: vehicles.slice(0, 1)
      }));
      this.cdr.detectChanges();
    });
  }

  // --- Add User Inline Form ---
  toggleAddUserForm() {
    this.showAddUserForm = !this.showAddUserForm;
    if (this.showAddUserForm) {
      this.newUserName = '';
      this.errorMessage = '';
    }
    this.cdr.detectChanges();
  }

  createUser() {
    if (!this.newUserName.trim()) return;
    this.errorMessage = '';
    
    this.api.createUser(this.newUserName).subscribe({
      next: (user) => {
        this.usersWithVehicles.push({ ...user, vehicles: [] });
        this.showAddUserForm = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        if (err.status === 400) {
          this.errorMessage = 'This user already exists!';
        } else {
          this.errorMessage = 'Failed to create user.';
        }
        this.cdr.detectChanges();
      }
    });
  }

  deleteUser(user: User) {
    if (confirm(`Are you sure you want to delete ${user.name}? This will also delete all their vehicles and chat logs.`)) {
      this.api.deleteUser(user._id).subscribe({
        next: () => {
          this.usersWithVehicles = this.usersWithVehicles.filter(u => u._id !== user._id);
          this.cdr.detectChanges();
        },
        error: (err) => {
          console.error("Failed to delete user", err);
          alert("Failed to delete user");
        }
      });
    }
  }

  // --- Add Vehicle Inline Form ---
  toggleAddVehicleForm(user: User) {
    const isCurrentlyOpen = this.showAddVehicleForm[user._id];
    
    // Close all other vehicle forms first
    this.showAddVehicleForm = {};
    
    if (!isCurrentlyOpen) {
      this.showAddVehicleForm[user._id] = true;
      this.newVehicle = { make: '', model: '', vehicle_type: 'car', registration_number: '' };
    }
    
    this.cdr.detectChanges();
  }

  tagVehicle(user: User) {
    if (!this.newVehicle.make || !this.newVehicle.model || !this.newVehicle.registration_number) return;

    this.api.tagVehicle(user._id, this.newVehicle).subscribe(vehicle => {
      const u = this.usersWithVehicles.find(x => x._id === user._id);
      if (u) {
        u.vehicles.push(vehicle);
      }
      this.showAddVehicleForm[user._id] = false;
      this.cdr.detectChanges();
    });
  }

  checkCustomer() {
    if (!this.customerName.trim() || !this.customerMobile.trim() || this.isLookingUp) return;

    this.lookupError = '';
    this.isLookingUp = true;
    this.api.checkSubscription(this.customerName.trim(), this.customerMobile.trim()).subscribe({
      next: (customer) => {
        this.customer = customer;
        this.loadData(customer.userId);
        this.isLookingUp = false;
        this.cdr.detectChanges();
      },
      error: () => {
        this.lookupError = 'Unable to find customer details. Please try again.';
        this.isLookingUp = false;
        this.cdr.detectChanges();
      }
    });
  }

  startOver() {
    this.customer = null;
    this.customerName = '';
    this.customerMobile = '';
    this.lookupError = '';
    this.usersWithVehicles = [];
    this.router.navigate(['/']);
  }

  // --- Navigation ---
  startChat(user: User, vehicle: Vehicle) {
    this.router.navigate(['/chat'], {
      queryParams: {
        userId: user._id,
        vehicleId: vehicle._id,
        customer: JSON.stringify(this.customer)
      }
    });
  }
}
