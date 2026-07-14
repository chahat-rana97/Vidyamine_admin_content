import { Component, OnInit, OnDestroy } from '@angular/core';
import { NgClass, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-admin-users',
  standalone: true,
  imports: [NgClass, DatePipe, FormsModule],
  templateUrl: './admin-users.component.html',
  styleUrls: ['./admin-users.component.css']
})
export class AdminUsersComponent implements OnInit, OnDestroy {
  users: any[] = [];
  filtered: any[] = [];
  loading = false;
  search = '';

  modal: { open: boolean; mode: 'add' | 'edit'; data: any } = {
    open: false, mode: 'add', data: {}
  };
  saving = false;
  deleteConfirm: any = null;

  roles = ['superadmin', 'admin', 'editor'];

  private avatarColors: Record<string, string> = {};
  private palette = [
    'linear-gradient(135deg,#6366f1,#8b5cf6)',
    'linear-gradient(135deg,#0ea5e9,#06b6d4)',
    'linear-gradient(135deg,#f59e0b,#ef4444)',
    'linear-gradient(135deg,#10b981,#059669)',
    'linear-gradient(135deg,#ec4899,#8b5cf6)',
    'linear-gradient(135deg,#f97316,#f59e0b)',
  ];

  constructor(
    private api: ApiService,
    private toast: ToastService,
    public auth: AuthService
  ) {}

  /** Refreshes the list (silently, no spinner) so online/offline + last-seen stay live. */
  private presencePollHandle: any = null;
  private readonly presencePollMs = 20000;

  ngOnInit() {
    this.load();

    // Keep the online/offline column live without the user having to
    // refresh the page — same 20s cadence as the presence heartbeat.
    this.presencePollHandle = setInterval(() => this.load(true), this.presencePollMs);
  }

  ngOnDestroy() {
    if (this.presencePollHandle) clearInterval(this.presencePollHandle);
  }

  load(silent = false) {
    if (!silent) this.loading = true;
    this.api.get<any>('/admin/users').subscribe({
      next: r => {
        if (r?.status) {
          this.users = r.data || [];
          this.applyFilter();
        } else if (!silent) {
          this.toast.error(r?.message || 'Failed to load users');
        }
        if (!silent) this.loading = false;
      },
      error: () => { if (!silent) { this.toast.error('Failed to load users'); this.loading = false; } }
    });
  }

  applyFilter() {
    const q = this.search.toLowerCase();
    this.filtered = q
      ? this.users.filter(u => u.name?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q))
      : [...this.users];
  }

  countByRole(role: string) {
    return this.users.filter(u => u.role === role).length;
  }

  countActive() {
    return this.users.filter(u => u.is_active).length;
  }

  avatarColor(name: string): string {
    if (!this.avatarColors[name]) {
      let hash = 0;
      for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
      this.avatarColors[name] = this.palette[Math.abs(hash) % this.palette.length];
    }
    return this.avatarColors[name];
  }

  roleLabel(role: string): string {
    const map: Record<string, string> = { superadmin: 'Super Admin', admin: 'Admin', editor: 'Editor' };
    return map[role] ?? role;
  }

  openAdd() {
    this.modal = { open: true, mode: 'add', data: { name: '', email: '', phone: '', password: '', role: 'admin', is_active: 1 } };
  }

  openEdit(u: any) {
    this.modal = { open: true, mode: 'edit', data: { ...u, password: '' } };
  }

  closeModal() { this.modal.open = false; }

  save() {
    const d = this.modal.data;
    if (!d.name || !d.email) { this.toast.error('Name and email are required'); return; }
    if (this.modal.mode === 'add' && (!d.phone || !d.password)) {
      this.toast.error('Phone and password are required'); return;
    }
    this.saving = true;

    const payload: any = { name: d.name, email: d.email, phone: d.phone, role: d.role, is_active: Number(d.is_active) };
    if (d.password) payload['password'] = d.password;

    const req = this.modal.mode === 'add'
      ? this.api.post<any>('/admin/users', payload)
      : this.api.put<any>(`/admin/users/${d.id}`, payload);

    req.subscribe({
      next: r => {
        this.saving = false;
        if (r?.status) {
          this.toast.success(this.modal.mode === 'add' ? 'User created' : 'User updated');
          this.closeModal(); this.load();
        } else {
          this.toast.error(r?.message || 'Operation failed');
        }
      },
      error: () => { this.saving = false; this.toast.error('Request failed'); }
    });
  }

  confirmDelete(u: any) { this.deleteConfirm = u; }

  doDelete() {
    if (!this.deleteConfirm) return;
    this.api.delete<any>(`/admin/users/${this.deleteConfirm.id}`).subscribe({
      next: r => {
        if (r?.status) { this.toast.success('User deleted'); this.load(); }
        else this.toast.error(r?.message || 'Delete failed');
        this.deleteConfirm = null;
      },
      error: () => { this.toast.error('Delete failed'); this.deleteConfirm = null; }
    });
  }

  get isSuperadmin() { return this.auth.user?.role === 'superadmin'; }

  /** Superadmin or admin — used to gate visibility of the "Created By" audit column. */
  get isAdminOrAbove() {
    const role = this.auth.user?.role;
    return role === 'superadmin' || role === 'admin';
  }

  // ---- Add User access gate (button stays visible to everyone; the
  // hover tooltip explains the restriction, this just blocks the click) ----
  onAddUserClick(event: Event) {
    if (!this.isSuperadmin) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    this.openAdd();
  }

  // ============================================================
  // PRESENCE (online / offline / last seen)
  // ============================================================

  /** Mirrors the backend's 45s threshold, in case is_online isn't present on an older cached row. */
  isOnline(u: any): boolean {
    if (typeof u.is_online === 'boolean') return u.is_online;
    if (!u.last_seen) return false;
    const last = new Date(u.last_seen.replace(' ', 'T')).getTime();
    return (Date.now() - last) <= 45000;
  }

  /** Human-friendly "last seen" text for offline users. */
  lastSeenText(u: any): string {
    if (!u.last_seen) return 'Never logged in';
    const last = new Date(u.last_seen.replace(' ', 'T')).getTime();
    const diffSec = Math.max(0, Math.floor((Date.now() - last) / 1000));

    if (diffSec < 60) return 'Just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d ago`;

    const d = new Date(u.last_seen.replace(' ', 'T'));
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  countOnline() {
    return this.users.filter(u => this.isOnline(u)).length;
  }
}