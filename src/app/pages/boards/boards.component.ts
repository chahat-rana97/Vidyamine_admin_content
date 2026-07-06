import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-boards',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './boards.component.html',
  styleUrls: ['./boards.component.css']
})
export class BoardsComponent implements OnInit {
  boards: any[] = [];
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

  ngOnInit() { this.load(); }

  get activeCount() {
    return this.boards.filter(b => b.is_active).length;
  }

  load() {
    this.loading = true;
    this.api.get<any>('/boards').subscribe({
      next: r => {
        if (r?.status) { this.boards = r.data || []; this.applyFilter(); }
        else { this.toast.error(r?.message || 'Failed to load boards'); }
        this.loading = false;
      },
      error: () => { this.toast.error('Failed to load boards'); this.loading = false; }
    });
  }

  applyFilter() {
    const q = this.search.toLowerCase();
    this.filtered = q
      ? this.boards.filter(b =>
          b.name?.toLowerCase().includes(q) ||
          b.code?.toLowerCase().includes(q) ||
          b.description?.toLowerCase().includes(q)
        )
      : [...this.boards];
  }

  openAdd() {
    this.modal = {
      open: true, mode: 'add',
      data: { name: '', code: '', description: '', display_order: this.boards.length + 1, is_active: 1 }
    };
  }

  openEdit(b: any) {
    this.modal = { open: true, mode: 'edit', data: { ...b } };
  }

  closeModal() { this.modal.open = false; }

  save() {
    const d = this.modal.data;
    if (!d.name?.trim()) { this.toast.error('Board name is required'); return; }
    this.saving = true;

    const payload = {
      name: d.name,
      code: d.code,
      description: d.description,
      display_order: d.display_order,
      is_active: d.is_active
    };

    const req = this.modal.mode === 'add'
      ? this.api.post<any>('/boards', payload)
      : this.api.put<any>(`/boards/${d.id}`, payload);

    req.subscribe({
      next: r => {
        this.saving = false;
        if (r?.status) {
          this.toast.success(this.modal.mode === 'add' ? 'Board created' : 'Board updated');
          this.closeModal(); this.load();
        } else { this.toast.error(r?.message || 'Operation failed'); }
      },
      error: () => { this.saving = false; this.toast.error('Request failed'); }
    });
  }

  confirmDelete(b: any) { this.deleteConfirm = b; }

  doDelete() {
    if (!this.deleteConfirm) return;
    this.api.delete<any>(`/boards/${this.deleteConfirm.id}`).subscribe({
      next: r => {
        if (r?.status) { this.toast.success('Board deleted'); this.load(); }
        else this.toast.error(r?.message || 'Delete failed');
        this.deleteConfirm = null;
      },
      error: () => { this.toast.error('Delete failed'); this.deleteConfirm = null; }
    });
  }

  get canWrite() {
    return ['superadmin', 'admin'].includes(this.auth.user?.role || '');
  }
}