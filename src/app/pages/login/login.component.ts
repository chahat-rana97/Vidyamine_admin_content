import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.css']
})
export class LoginComponent {
  identifier = '';   // email or phone
  password = '';
  loading = false;
  error = '';
  showPassword = false;
  currentYear = new Date().getFullYear();

  constructor(private auth: AuthService, private router: Router) {}

  submit() {
    if (!this.identifier || !this.password) {
      this.error = 'Please fill in all fields.';
      return;
    }
    this.loading = true;
    this.error = '';

    this.auth.login(this.identifier, this.password).subscribe({
      next: res => {
        this.loading = false;
        if (res?.status) {
          this.router.navigate(['/dashboard']);
        } else {
          this.error = res?.message || 'Invalid credentials. Please try again.';
        }
      },
      error: err => {
        this.loading = false;
        // Show the actual HTTP error status if available
        if (err?.status === 0) {
          this.error = 'Cannot reach server. Check your connection or CORS settings.';
        } else if (err?.status === 401) {
          this.error = 'Invalid credentials. Please try again.';
        } else {
          this.error = err?.error?.message || `Server error (${err?.status}). Please try again.`;
        }
      }
    });
  }
}
