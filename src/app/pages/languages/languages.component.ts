import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-languages',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './languages.component.html',
  styleUrls: ['./languages.component.css']
})
export class LanguagesComponent implements OnInit {
  languages: any[] = [];
  filtered: any[] = [];
  loading = false;
  search = '';

  modal: { open: boolean; mode: 'add' | 'edit'; data: any } = {
    open: false, mode: 'add', data: {}
  };
  saving = false;
  deleteConfirm: any = null;

  constructor(
    private api: ApiService,
    private toast: ToastService,
    public auth: AuthService
  ) {}

  ngOnInit() {
    this.load();
  }

  get activeCount() {
    return this.languages.filter(l => this.isActive(l)).length;
  }

  get canWrite() {
    return ['superadmin', 'admin'].includes(this.auth.user?.role || '');
  }

  load() {
    this.loading = true;
    this.api.get<any>('/languages').subscribe({
      next: r => {
        if (r?.status) {
          this.languages = this.readList(r);
          this.applyFilter();
        } else {
          this.toast.error(r?.message || 'Failed to load languages');
        }
        this.loading = false;
      },
      error: () => {
        this.toast.error('Failed to load languages');
        this.loading = false;
      }
    });
  }

  applyFilter() {
    const q = this.search.trim().toLowerCase();
    this.filtered = q
      ? this.languages.filter(l =>
          (l.name || '').toLowerCase().includes(q) ||
          (l.code || '').toLowerCase().includes(q)
        )
      : [...this.languages];
  }

  openAdd() {
    this.modal = {
      open: true,
      mode: 'add',
      data: {
        name: '',
        code: '',
        status: 'Active'
      }
    };
  }

  openEdit(l: any) {
    this.modal = {
      open: true,
      mode: 'edit',
      data: { ...l }
    };
  }

  closeModal() {
    this.modal.open = false;
  }

  save() {
    const d = this.modal.data;
    if (!d.name?.trim()) { this.toast.error('Language name is required'); return; }
    if (!d.code?.trim()) { this.toast.error('Language code is required'); return; }

    this.saving = true;
    const payload = {
      name: d.name,
      code: d.code,
      status: d.status || 'Active'
    };

    const req = this.modal.mode === 'add'
      ? this.api.post<any>('/languages', payload)
      : this.api.put<any>(`/languages/${d.id}`, payload);

    req.subscribe({
      next: r => {
        this.saving = false;
        if (r?.status) {
          this.toast.success(this.modal.mode === 'add' ? 'Language created' : 'Language updated');
          this.closeModal();
          this.load();
        } else {
          this.toast.error(r?.message || 'Operation failed');
        }
      },
      error: () => {
        this.saving = false;
        this.toast.error('Request failed');
      }
    });
  }

  confirmDelete(l: any) {
    this.deleteConfirm = l;
  }

  doDelete() {
    if (!this.deleteConfirm) return;
    this.api.delete<any>(`/languages/${this.deleteConfirm.id}`).subscribe({
      next: r => {
        if (r?.status) {
          this.toast.success('Language deleted');
          this.load();
        } else {
          this.toast.error(r?.message || 'Delete failed');
        }
        this.deleteConfirm = null;
      },
      error: () => {
        this.toast.error('Delete failed');
        this.deleteConfirm = null;
      }
    });
  }

  isActive(l: any): boolean {
    return l.status === 'Active' || l.status === 'active' || l.is_active === 1 || l.is_active === true;
  }

  private readList(r: any): any[] {
    if (Array.isArray(r?.data)) return r.data;
    if (Array.isArray(r?.data?.languages)) return r.data.languages;
    if (Array.isArray(r?.languages)) return r.languages;
    return [];
  }
}
